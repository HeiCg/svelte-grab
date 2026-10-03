/**
 * JS/TS rules (also applied to the `<script>` blocks of `.svelte` files):
 *
 * - `secrets/client-exposure` / `secrets/hardcoded-server`: secret-shaped
 *   literals (shared secret rules) and high-entropy literals assigned to
 *   sensitive names. Client-reachable code is a leak; server-only code is a
 *   hardcoded credential.
 * - `js/eval`: `eval(` / `new Function(`.
 * - `js/postmessage-no-origin`: `message` listeners on window without an
 *   `origin` check in the handler body.
 * - `storage/token-in-web-storage`: tokens written to localStorage /
 *   sessionStorage under token-ish key names.
 */
import { decodeJwt, findSecrets, isHighEntropyToken, redact, sensitiveKeyKind, type SecretKind, type SecretMatch } from '../secrets.js';
import {
	functionBodyAfter,
	lineAt,
	maskComments,
	maskStrings,
	matchBracket,
	resolveFunctionBody,
	type FileContext
} from '../source.js';
import type { SourceFile } from '../types.js';
import { FindingSink, svelteScriptText, type RuleContext } from './shared.js';

/** Credentials that must never reach a browser. */
const SERVER_SECRET_KINDS = new Set<SecretKind>([
	'private-key',
	'supabase-service-role',
	'aws-access-key',
	'stripe-secret-key',
	'stripe-restricted-key',
	'github-token',
	'anthropic-key',
	'openai-key',
	'slack-token',
	'slack-webhook'
]);

const SECRET_NAME_KINDS = new Set(['api-key', 'secret', 'private-key', 'password', 'token', 'jwt', 'authorization']);
const STORAGE_KEY_KINDS = new Set(['token', 'jwt', 'authorization', 'session', 'api-key', 'secret', 'password', 'private-key']);

function isPublicJwt(m: SecretMatch): boolean {
	if (m.kind !== 'jwt') return false;
	const role = decodeJwt(m.value)?.payload.role;
	return role === 'anon' || role === 'authenticated';
}

// ------------------------------------------------------------------ secrets

/**
 * The source line with `value` replaced by its redaction (explicitly: a value
 * matched by name only may not be caught by `redactText`). Long lines lead
 * with the redaction so truncation never hides it.
 */
function secretEvidence(text: string, offset: number, value: string, redacted: string): string {
	const line = lineAt(text, offset).split(value).join(redacted);
	return line.length > 160 ? `${redacted} in: ${line}` : line;
}

function secretRules(file: SourceFile, context: FileContext, sink: FindingSink): void {
	const text = file.text;
	const where = context === 'server' ? 'server-only code' : 'build/tooling code';
	const matches = findSecrets(text, { entropy: false });
	for (const m of matches) {
		if (isPublicJwt(m)) continue;
		const ev = secretEvidence(text, m.start, m.value, m.redacted);
		if (context === 'client') {
			const server = SERVER_SECRET_KINDS.has(m.kind);
			sink.add(
				'secrets/client-exposure',
				m.start,
				server ? 'high' : 'medium',
				server ? 'confirmed' : 'needs_validation',
				`${m.label} in client-reachable code`,
				ev,
				server
					? 'Revoke and rotate this credential, then read it on the server only ($env/static/private or $env/dynamic/private in a +page.server / +server / $lib/server module).'
					: 'Check whether this token grants access on its own; if so move it to server-only code ($env/static/private) and rotate it.'
			);
		} else {
			sink.add(
				'secrets/hardcoded-server',
				m.start,
				'medium',
				'needs_validation',
				`${m.label} hardcoded in ${where}`,
				ev,
				'Not shipped to the browser, but committed to the repository: move it to an environment variable ($env/static/private) and rotate it if it was ever pushed.'
			);
		}
	}

	// High-entropy literal assigned to a sensitive name: `apiKey = '...'`, `{ secret: "..." }`.
	const assign = /([A-Za-z_$][\w$]*)['"]?\s*[:=]\s*(['"`])([^'"`\n]{16,256})\2/g;
	for (const m of text.matchAll(assign)) {
		const [, name, , value] = m;
		const keyKind = sensitiveKeyKind(name);
		if (!keyKind || !SECRET_NAME_KINDS.has(keyKind)) continue;
		if (!isHighEntropyToken(value)) continue;
		const valueStart = (m.index ?? 0) + m[0].lastIndexOf(value);
		if (matches.some((s) => valueStart < s.end && valueStart + value.length > s.start)) continue;
		const ev = secretEvidence(text, valueStart, value, redact(value, keyKind));
		if (context === 'client') {
			sink.add(
				'secrets/client-exposure',
				valueStart,
				'medium',
				'needs_validation',
				`Possible hardcoded ${keyKind} ("${name}") in client-reachable code`,
				ev,
				'If this is a real credential, move it to server-only code ($env/static/private) and rotate it; public identifiers can be ignored.'
			);
		} else {
			sink.add(
				'secrets/hardcoded-server',
				valueStart,
				'low',
				'needs_validation',
				`Possible hardcoded ${keyKind} ("${name}") in ${where}`,
				ev,
				'Read credentials from the environment ($env/static/private) instead of committing them.'
			);
		}
	}
}

// ------------------------------------------------------------------ eval

function evalRule(code: string, sink: FindingSink): void {
	const bare = maskStrings(code);
	for (const m of bare.matchAll(/(?<![\w$.])eval\s*\(|\bnew\s+Function\s*\(/g)) {
		const isEval = m[0].startsWith('eval');
		sink.add(
			'js/eval',
			m.index ?? 0,
			'medium',
			'confirmed',
			isEval ? 'eval() executes strings as code' : 'new Function() executes strings as code',
			lineAt(code, m.index ?? 0),
			'Avoid evaluating strings: parse data with JSON.parse, use a lookup table for dynamic behaviour. It also forces `unsafe-eval` in your CSP.'
		);
	}
}

// ------------------------------------------------------------------ postMessage

const ORIGIN_CHECK = /\borigin\b/;

function checkMessageHandler(code: string, handlerStart: number, offset: number, sink: FindingSink, evidenceText: string): void {
	const rest = code.slice(handlerStart);
	const ident = /^([A-Za-z_$][\w$]*)\s*(?:[,)]|$)/.exec(rest);
	let body: string | null;
	if (ident && ident[1] !== 'async' && ident[1] !== 'function') {
		body = resolveFunctionBody(code, ident[1]);
	} else {
		const fn = functionBodyAfter(code, handlerStart);
		body = fn ? code.slice(fn.start, fn.end) : null;
	}
	if (body !== null && ORIGIN_CHECK.test(body)) return;
	const unresolved = body === null;
	sink.add(
		'js/postmessage-no-origin',
		offset,
		'medium',
		unresolved ? 'needs_validation' : 'confirmed',
		unresolved
			? 'message listener: handler not found in this file, origin check unverified'
			: 'message listener without an event.origin check',
		evidenceText,
		'Reject messages from unexpected senders first: `if (event.origin !== EXPECTED_ORIGIN) return;` (and validate event.data).'
	);
}

function postMessageRule(code: string, sink: FindingSink): void {
	const listener = /(?:\b(?:window|self|globalThis)\s*\.\s*|(?<![\w$.]))addEventListener\s*\(\s*(['"`])message\1\s*,\s*/g;
	for (const m of code.matchAll(listener)) {
		const at = m.index ?? 0;
		checkMessageHandler(code, at + m[0].length, at, sink, lineAt(code, at));
	}
	for (const m of code.matchAll(/\b(?:window|self|globalThis)\s*\.\s*onmessage\s*=\s*/g)) {
		const at = m.index ?? 0;
		checkMessageHandler(code, at + m[0].length, at, sink, lineAt(code, at));
	}
}

/** `<svelte:window onmessage={...} />` in a component's markup. */
function svelteWindowMessageRule(text: string, script: string, sink: FindingSink): void {
	for (const m of text.matchAll(/<svelte:window\b[^>]*?\bonmessage\s*=\s*\{/g)) {
		const open = (m.index ?? 0) + m[0].length - 1;
		const close = matchBracket(text, open);
		if (close === -1) continue;
		const expr = text.slice(open + 1, close - 1).trim();
		let body: string | null;
		if (/^[A-Za-z_$][\w$]*$/.test(expr)) body = resolveFunctionBody(script, expr);
		else body = expr;
		if (body !== null && ORIGIN_CHECK.test(body)) continue;
		const unresolved = body === null;
		sink.add(
			'js/postmessage-no-origin',
			m.index ?? 0,
			'medium',
			unresolved ? 'needs_validation' : 'confirmed',
			unresolved
				? '<svelte:window onmessage>: handler not found, origin check unverified'
				: '<svelte:window onmessage> without an event.origin check',
			lineAt(text, m.index ?? 0),
			'Reject messages from unexpected senders first: `if (event.origin !== EXPECTED_ORIGIN) return;` (and validate event.data).'
		);
	}
}

// ------------------------------------------------------------------ web storage

function storageRule(code: string, sink: FindingSink): void {
	const report = (offset: number, store: string, key: string, viaName: boolean) => {
		const local = store === 'localStorage';
		sink.add(
			'storage/token-in-web-storage',
			offset,
			local ? 'medium' : 'low',
			viaName ? 'needs_validation' : 'confirmed',
			`${viaName ? 'Possible credential' : 'Credential'} stored in ${store} ("${key}")`,
			lineAt(code, offset),
			'Web Storage is readable by any script on the origin (one XSS steals it). Keep session tokens in HttpOnly, Secure, SameSite cookies set by the server.'
		);
	};
	const setItemLiteral = /\b(localStorage|sessionStorage)\s*\.\s*setItem\s*\(\s*(['"`])([^'"`]+)\2/g;
	for (const m of code.matchAll(setItemLiteral)) {
		const kind = sensitiveKeyKind(m[3]);
		if (kind && STORAGE_KEY_KINDS.has(kind)) report(m.index ?? 0, m[1], m[3], false);
	}
	const setItemIdent = /\b(localStorage|sessionStorage)\s*\.\s*setItem\s*\(\s*([A-Za-z_$][\w$.]*)\s*,/g;
	for (const m of code.matchAll(setItemIdent)) {
		const name = m[2].split('.').pop() ?? m[2];
		const kind = sensitiveKeyKind(name);
		if (kind && STORAGE_KEY_KINDS.has(kind)) report(m.index ?? 0, m[1], m[2], true);
	}
	const assign = /\b(localStorage|sessionStorage)\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(['"`])([^'"`]+)\3\s*\])\s*=(?!=)/g;
	for (const m of code.matchAll(assign)) {
		const key = m[2] ?? m[4];
		if (!key || key === 'setItem') continue;
		const kind = sensitiveKeyKind(key);
		if (kind && STORAGE_KEY_KINDS.has(kind)) report(m.index ?? 0, m[1], key, false);
	}
}

// ------------------------------------------------------------------ entry

export function codeRules(file: SourceFile, context: FileContext, _ctx: RuleContext): FindingSink {
	const sink = new FindingSink(file);
	if (context === 'test' || context === 'env') return sink;
	secretRules(file, context, sink);
	if (context === 'tooling') return sink;

	const svelte = file.rel.endsWith('.svelte');
	const code = maskComments(svelte ? svelteScriptText(file.text) : file.text);
	evalRule(code, sink);
	postMessageRule(code, sink);
	storageRule(code, sink);
	if (svelte) svelteWindowMessageRule(file.text, code, sink);
	return sink;
}
