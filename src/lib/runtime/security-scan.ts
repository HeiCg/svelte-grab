/**
 * `ui_security_scan` (docs/agent-runtime-spec.md, Phase 9b): runtime security
 * checks on the live page, every value through the shared secret rules
 * (`security/secret-rules.ts`) and redacted. Never returns a full secret.
 *
 * Checks (all by default, or `checks: [...]`):
 * - transit: secrets in URL query / fragment / path of captured requests (and
 *   the page URL); auth headers (Authorization, Cookie, API-key headers, any
 *   sensitive or secret-shaped header) sent to third-party origins; secrets
 *   in request bodies sent to third parties.
 * - storage: secret-shaped values / sensitive keys in localStorage and
 *   sessionStorage (JWT -> medium, provider secret keys -> high); IndexedDB
 *   database names that look like auth stores (info).
 * - cookies: JS-readable cookies that look like session/auth cookies
 *   (=> missing HttpOnly).
 * - globals: secrets in non-standard `window` globals (baseline from a blank
 *   iframe).
 * - sveltekit: SvelteKit (3) serialized data. Kit renders the page data
 *   inline in the boot `<script>` (`kit.start(app, element, { node_ids,
 *   data: [...devalue.uneval...], form, error })`), fetches made during SSR
 *   load as `<script type="application/json" data-sveltekit-fetched
 *   data-url>`, and remote-function data as `__sveltekit_*.data`. Client-side
 *   navigations fetch `__data.json` (devalue flattened JSON), read from the
 *   network buffer when bodies were captured.
 * - env: client env exposed to the browser (Vite's client env, VITE_*
 *   values, via the svelte-grab/vite plugin's `__SVELTE_GRAB_VITE__.env`;
 *   SvelteKit `$env/dynamic/public` in `__sveltekit_*.env`) holding
 *   secret-shaped values or sensitive names.
 * - headers: response headers of the page (same-origin HEAD): CSP (present,
 *   no unsafe-inline / unsafe-eval for scripts, frame-ancestors),
 *   X-Content-Type-Options, Referrer-Policy, X-Frame-Options, HSTS; source
 *   maps reachable. On a loopback (dev) host they are `info`: check the
 *   production response.
 * - dom: inline `on*` handler attributes / `javascript:` URLs / scripts
 *   inserted under Svelte markup (raw HTML, e.g. `{@html}`),
 *   `target=_blank` external links without `rel=noopener`.
 * - mixed: http:// / ws:// requests or DOM URLs from an https page; ws://
 *   to a non-loopback host.
 *
 * Finding: `{ id, check, severity: high|medium|low|info, verdict:
 * confirmed|needs_validation, title, evidence (redacted), source?, fix }`.
 * `id` is `<rule>:<6 hex>` and stable across runs for the same issue.
 */
import { findMetaElement, getSvelteLoc } from '../utils/component-stack.js';
import { shortenPath } from '../utils/shared.js';
import { VITE_PLUGIN_GLOBAL } from '../utils/vite-plugin-info.js';
import {
	detectSecret,
	findSecrets,
	isMeaningfulSecretValue,
	redact,
	redactText,
	redactUrl,
	scanValue,
	secretLabel,
	sensitiveKeyKind,
	sha256Hex,
	unflattenDevalue,
	type SecretKind,
	type SecretMatch,
	type SensitiveKeyKind,
	type ValueSecretHit
} from '../security/secret-rules.js';
import { isInOwnUi } from './node-info.js';
import {
	isThirdParty,
	networkCapture,
	type NetworkCapture,
	type NetworkEntry,
	type NetworkInitiator
} from './network.js';
import type { RuntimeToolResult } from './types.js';

export const SECURITY_CHECKS = [
	'transit',
	'storage',
	'cookies',
	'globals',
	'sveltekit',
	'env',
	'headers',
	'dom',
	'mixed'
] as const;
export type SecurityCheck = (typeof SECURITY_CHECKS)[number];
export type Severity = 'high' | 'medium' | 'low' | 'info';
export type Verdict = 'confirmed' | 'needs_validation';

export interface SecurityFinding extends Record<string, unknown> {
	id: string;
	check: SecurityCheck;
	severity: Severity;
	verdict: Verdict;
	title: string;
	/** Redacted. */
	evidence: string;
	source?: string;
	fix: string;
}

export interface SecurityScanOptions {
	capture?: NetworkCapture;
	win?: Window;
	doc?: Document;
	pageUrl?: string;
	/** Client env (test seam). Defaults to the one the svelte-grab/vite plugin exposes. */
	env?: Record<string, unknown> | null;
	/** HEAD fetch (test seam). Defaults to `capture.ownFetch`. */
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

const SEVERITY_ORDER: Severity[] = ['high', 'medium', 'low', 'info'];
/** Secret kinds that are server credentials: exposure in the browser is high. */
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
/** Sensitive key names whose values must never reach the browser. */
const HIGH_KEY_KINDS = new Set<SensitiveKeyKind>([
	'password',
	'secret',
	'private-key',
	'api-key',
	'ssn',
	'credit-card',
	'cvv',
	'hash'
]);
/** Header names that carry credentials. */
const AUTH_HEADERS = new Set([
	'authorization',
	'proxy-authorization',
	'cookie',
	'x-api-key',
	'api-key',
	'apikey',
	'x-auth-token',
	'x-access-token'
]);
/** Storage keys written by svelte-grab itself. */
const OWN_STORAGE_KEY = /^svelte-grab/;
const MAX_ITEMS_PER_FINDING = 5;

function isLoopbackHost(host: string): boolean {
	return (
		host === 'localhost' ||
		host === '127.0.0.1' ||
		host === '[::1]' ||
		host === '::1' ||
		host.endsWith('.localhost')
	);
}

function fingerprint(rule: string, ...parts: string[]): string {
	return `${rule}:${sha256Hex(parts.join('|')).slice(0, 6)}`;
}

function initiatorSource(i: NetworkInitiator | null): string | undefined {
	if (!i) return undefined;
	return `${i.file}:${i.line}${i.component ? ` (${i.component})` : ''}`;
}

function elementSource(el: Element): string | undefined {
	const metaEl = findMetaElement(el);
	const loc = getSvelteLoc(metaEl);
	return loc ? `${shortenPath(loc.file)}:${loc.line}` : undefined;
}

function hostPath(url: string): string {
	try {
		const u = new URL(url);
		return `${u.origin}${u.pathname}`;
	} catch {
		return url.replace(/[?#].*$/, '');
	}
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return '';
	}
}

function parseChecks(args: Record<string, unknown>): SecurityCheck[] {
	const raw = args.checks;
	if (raw === undefined || raw === null) return [...SECURITY_CHECKS];
	if (!Array.isArray(raw)) throw new Error('"checks" must be an array of check names');
	const out: SecurityCheck[] = [];
	for (const item of raw) {
		if (typeof item !== 'string' || !(SECURITY_CHECKS as readonly string[]).includes(item)) {
			throw new Error(
				`Unknown check ${JSON.stringify(item)}: use any of ${SECURITY_CHECKS.join(', ')}`
			);
		}
		if (!out.includes(item as SecurityCheck)) out.push(item as SecurityCheck);
	}
	return out.length > 0 ? out : [...SECURITY_CHECKS];
}

/** Collects findings, merging repeats of the same issue (same id). */
class Findings {
	readonly list: SecurityFinding[] = [];
	private counts = new Map<string, number>();

	add(f: SecurityFinding): void {
		const n = (this.counts.get(f.id) ?? 0) + 1;
		this.counts.set(f.id, n);
		if (n === 1) {
			this.list.push(f);
			return;
		}
		const existing = this.list.find((x) => x.id === f.id)!;
		existing.evidence = existing.evidence.replace(/ \(x\d+\)$/, '') + ` (x${n})`;
	}
}

function hitSeverity(
	hit: { kind: string; shaped: boolean; confidence: string },
	place: 'url' | 'storage' | 'data'
): {
	severity: Severity;
	verdict: Verdict;
} {
	if (hit.shaped && hit.confidence === 'high') {
		if (place === 'url') return { severity: 'high', verdict: 'confirmed' };
		if (SERVER_SECRET_KINDS.has(hit.kind as SecretKind))
			return { severity: 'high', verdict: 'confirmed' };
		return { severity: 'medium', verdict: 'confirmed' };
	}
	if (hit.shaped) return { severity: 'medium', verdict: 'needs_validation' };
	if (place === 'data' && HIGH_KEY_KINDS.has(hit.kind as SensitiveKeyKind))
		return { severity: 'high', verdict: 'needs_validation' };
	return { severity: 'medium', verdict: 'needs_validation' };
}

function kindLabel(kind: string): string {
	try {
		return secretLabel(kind as SecretKind) ?? kind;
	} catch {
		return kind;
	}
}

// ------------------------------------------------------------------ transit

function checkTransit(entries: NetworkEntry[], pageUrl: string, out: Findings): void {
	const urls: { url: string; method: string; source?: string }[] = [
		{ url: pageUrl, method: 'PAGE' },
		...entries
			.filter((e) => e.type !== 'document')
			.map((e) => ({ url: e.url, method: e.method, source: initiatorSource(e.initiator) }))
	];
	for (const { url, method, source } of urls) {
		const { redacted, hits } = redactUrl(url);
		for (const hit of hits) {
			const { severity, verdict } = hitSeverity(hit, 'url');
			const where = hit.key ? `${hit.location} parameter "${hit.key}"` : hit.location;
			out.add({
				id: fingerprint('token-in-url', hostPath(url), hit.location, hit.key ?? '', hit.kind),
				check: 'transit',
				severity,
				verdict,
				title: `${hit.shaped ? kindLabel(hit.kind) : `Sensitive value (${hit.kind})`} in URL ${where}`,
				evidence: `${method} ${redacted}`,
				...(source ? { source } : {}),
				fix:
					'Never put credentials in URLs (they end up in logs, history, Referer headers and analytics). ' +
					'Send them in an Authorization header or the request body, from server code when the secret is server-only.'
			});
		}
	}

	for (const e of entries) {
		if (!isThirdParty(e.url, pageUrl)) continue;
		const host = hostOf(e.url);
		for (const [name, value] of Object.entries(e.requestHeaders)) {
			const shaped = detectSecret(value, { entropy: false });
			const keyKind = sensitiveKeyKind(name);
			if (!AUTH_HEADERS.has(name) && !shaped && !keyKind) continue;
			const shown = shaped
				? redactText(value, { entropy: false })
				: redact(value, keyKind ?? 'header');
			out.add({
				id: fingerprint('auth-header-third-party', host, name),
				check: 'transit',
				severity: 'high',
				verdict: AUTH_HEADERS.has(name) || shaped ? 'confirmed' : 'needs_validation',
				title: `Credential header "${name}" sent to third-party ${host}`,
				evidence: `${e.method} ${redactUrl(e.url).redacted} ${name}: ${shown}`,
				...(initiatorSource(e.initiator) ? { source: initiatorSource(e.initiator) } : {}),
				fix:
					"Do not send your users' or your own credentials to third-party origins. Call third-party APIs from " +
					'server code (+server.ts / a remote function) with a server-only secret, or use a token scoped to that vendor.'
			});
		}
		if (e.requestBody) {
			const hits = bodyHits(e.requestBody);
			for (const hit of hits.slice(0, MAX_ITEMS_PER_FINDING)) {
				const shapedHigh = hit.shaped && hit.confidence === 'high';
				out.add({
					id: fingerprint('credential-in-body-third-party', host, hit.path || hit.kind),
					check: 'transit',
					severity: shapedHigh ? 'high' : 'medium',
					verdict: shapedHigh ? 'confirmed' : 'needs_validation',
					title: `${hit.shaped ? kindLabel(hit.kind) : `Sensitive field (${hit.kind})`} in request body to third-party ${host}`,
					evidence: `${e.method} ${redactUrl(e.url).redacted} body${hit.path ? ` ${hit.path}` : ''} = ${hit.redacted}`,
					...(initiatorSource(e.initiator) ? { source: initiatorSource(e.initiator) } : {}),
					fix: 'Strip credentials and personal data before sending events to analytics/telemetry or other third parties.'
				});
			}
		}
	}
}

/** Secrets in a request body: JSON walk (key names) else text scan. */
function bodyHits(body: string): ValueSecretHit[] {
	try {
		const parsed = JSON.parse(body);
		if (parsed && typeof parsed === 'object') return scanValue(parsed, { entropy: false });
	} catch {
		// not JSON
	}
	if (body.includes('=') && !body.includes(' ')) {
		const hits: ValueSecretHit[] = [];
		for (const h of redactUrl(`?${body}`).hits) {
			hits.push({
				path: h.key ?? '',
				key: h.key ?? null,
				kind: h.kind,
				confidence: h.confidence,
				shaped: h.shaped,
				redacted: h.redacted
			});
		}
		return hits;
	}
	return findSecrets(body, { entropy: false }).map((m) => ({
		path: '',
		key: null,
		kind: m.kind,
		confidence: m.confidence,
		shaped: true,
		redacted: m.redacted
	}));
}

// ------------------------------------------------------------------ storage

function storageOf(win: Window, name: 'localStorage' | 'sessionStorage'): Storage | null {
	try {
		return (win as unknown as Record<string, Storage | undefined>)[name] ?? null;
	} catch {
		return null;
	}
}

function valueHits(value: string): ValueSecretHit[] {
	const hits: ValueSecretHit[] = [];
	try {
		const parsed = JSON.parse(value);
		if (parsed && typeof parsed === 'object') hits.push(...scanValue(parsed, { entropy: false }));
	} catch {
		// plain string
	}
	if (hits.length === 0) {
		for (const m of findSecrets(value, { entropy: false })) {
			hits.push({
				path: '',
				key: null,
				kind: m.kind,
				confidence: m.confidence,
				shaped: true,
				redacted: m.redacted
			});
		}
	}
	return hits;
}

async function checkStorage(win: Window, out: Findings, notes: string[]): Promise<void> {
	for (const name of ['localStorage', 'sessionStorage'] as const) {
		const storage = storageOf(win, name);
		if (!storage) {
			notes.push(`storage: ${name} unavailable`);
			continue;
		}
		for (let i = 0; i < storage.length; i++) {
			const key = storage.key(i);
			if (key === null || OWN_STORAGE_KEY.test(key)) continue;
			const value = storage.getItem(key) ?? '';
			const hits = valueHits(value);
			const keyKind = sensitiveKeyKind(key);
			if (hits.length === 0 && keyKind && isMeaningfulSecretValue(value, 8)) {
				hits.push({
					path: '',
					key,
					kind: keyKind,
					confidence: 'low',
					shaped: false,
					redacted: redact(value, keyKind)
				});
			}
			for (const hit of hits.slice(0, MAX_ITEMS_PER_FINDING)) {
				const { severity, verdict } = hitSeverity(hit, 'storage');
				const isToken = hit.kind === 'jwt' || hit.kind === 'bearer';
				out.add({
					id: fingerprint(
						isToken ? 'jwt-in-storage' : 'secret-in-storage',
						name,
						key,
						hit.path,
						hit.kind
					),
					check: 'storage',
					severity,
					verdict,
					title: `${hit.shaped ? kindLabel(hit.kind) : `Sensitive value (${hit.kind})`} in ${name} "${key}"`,
					evidence: `${name}["${key}"]${hit.path ? `.${hit.path}` : ''} = ${hit.redacted}`,
					fix: isToken
						? 'Any script on the page (XSS, a compromised dependency) can read Web Storage. Keep session tokens in ' +
							'HttpOnly, Secure, SameSite cookies set by the server (SvelteKit: cookies.set in hooks/actions).'
						: 'Do not store credentials in Web Storage. Server secrets must never reach the browser at all.'
				});
			}
		}
	}

	const idb = (
		win as unknown as {
			indexedDB?: IDBFactory & { databases?: () => Promise<{ name?: string }[]> };
		}
	).indexedDB;
	if (idb && typeof idb.databases === 'function') {
		try {
			const dbs = await Promise.race([
				idb.databases(),
				new Promise<{ name?: string }[]>((resolve) => setTimeout(() => resolve([]), 500))
			]);
			for (const db of dbs) {
				if (!db.name || !/auth|token|session|firebaselocalstorage|credential/i.test(db.name))
					continue;
				out.add({
					id: fingerprint('auth-indexeddb', db.name),
					check: 'storage',
					severity: 'info',
					verdict: 'needs_validation',
					title: `IndexedDB "${db.name}" looks like an auth store`,
					evidence: `indexedDB database "${db.name}"`,
					fix: 'Auth SDKs persisting tokens in IndexedDB are readable by any script on the origin; prefer HttpOnly cookie sessions where the SDK allows it.'
				});
			}
		} catch {
			notes.push('storage: indexedDB.databases() failed');
		}
	}
}

// ------------------------------------------------------------------ cookies

const AUTH_COOKIE = /sess|sid$|^sid|auth|token|jwt|login|remember/i;

function checkCookies(doc: Document, out: Findings): void {
	let raw = '';
	try {
		raw = doc.cookie ?? '';
	} catch {
		return;
	}
	for (const part of raw.split(';')) {
		const eq = part.indexOf('=');
		if (eq <= 0) continue;
		const name = part.slice(0, eq).trim();
		const value = part.slice(eq + 1).trim();
		if (!value || OWN_STORAGE_KEY.test(name)) continue;
		const shaped = detectSecret(decodeURIComponentSafe(value), { entropy: false });
		const keyKind = sensitiveKeyKind(name);
		if (!shaped && !keyKind && !AUTH_COOKIE.test(name)) continue;
		if (/^(csrf|xsrf)/i.test(name) && !shaped) continue; // double-submit CSRF cookies are JS-readable by design
		out.add({
			id: fingerprint('js-readable-auth-cookie', name),
			check: 'cookies',
			severity: 'medium',
			verdict: shaped ? 'confirmed' : 'needs_validation',
			title: `Auth-looking cookie "${name}" is readable by JavaScript (missing HttpOnly)`,
			evidence: `document.cookie ${name}=${shaped ? shaped.redacted : redact(value, keyKind ?? 'cookie')}`,
			fix: 'Set session/auth cookies with HttpOnly (and Secure, SameSite=Lax/Strict) from the server; SvelteKit cookies.set defaults to httpOnly: true.'
		});
	}
}

function decodeURIComponentSafe(v: string): string {
	try {
		return decodeURIComponent(v);
	} catch {
		return v;
	}
}

// ------------------------------------------------------------------ globals

const IGNORED_GLOBAL =
	/^(?:__svelte|__SVELTE|__sveltekit_|__vite|__VITE|__vite_|webpack|__REACT|__VUE|__playwright|__pw|__coverage__|\$)/;

function pristineGlobalNames(doc: Document): Set<string> | null {
	const body = doc.body ?? doc.documentElement;
	if (!body) return null;
	let frame: HTMLIFrameElement | null = null;
	try {
		frame = doc.createElement('iframe');
		frame.setAttribute('data-svelte-grab-ui', '');
		frame.style.display = 'none';
		body.appendChild(frame);
		const w = frame.contentWindow;
		if (!w) return null;
		return new Set(Object.getOwnPropertyNames(w));
	} catch {
		return null;
	} finally {
		frame?.remove();
	}
}

function checkGlobals(win: Window, doc: Document, out: Findings, notes: string[]): void {
	const baseline = pristineGlobalNames(doc);
	if (!baseline) {
		notes.push('globals: no baseline window available (skipped)');
		return;
	}
	for (const name of Object.getOwnPropertyNames(win)) {
		if (baseline.has(name) || IGNORED_GLOBAL.test(name)) continue;
		let value: unknown;
		try {
			value = (win as unknown as Record<string, unknown>)[name];
		} catch {
			continue;
		}
		if (typeof value === 'function' || value === null || value === undefined || value === win)
			continue;
		if ((value as { window?: unknown }).window === value) continue; // another window / global alias
		if (typeof Node !== 'undefined' && value instanceof Node) continue;
		const hits: ValueSecretHit[] =
			typeof value === 'string'
				? valueHits(value)
				: typeof value === 'object'
					? scanValue(value, { entropy: false, maxDepth: 3, maxNodes: 500 })
					: [];
		const keyKind = sensitiveKeyKind(name);
		if (hits.length === 0 && keyKind && isMeaningfulSecretValue(value, 8)) {
			hits.push({
				path: '',
				key: name,
				kind: keyKind,
				confidence: 'low',
				shaped: false,
				redacted: redact(value, keyKind)
			});
		}
		for (const hit of hits.slice(0, MAX_ITEMS_PER_FINDING)) {
			const { severity, verdict } = hitSeverity(hit, 'storage');
			out.add({
				id: fingerprint('secret-in-global', name, hit.path, hit.kind),
				check: 'globals',
				severity,
				verdict,
				title: `${hit.shaped ? kindLabel(hit.kind) : `Sensitive value (${hit.kind})`} in window.${name}`,
				evidence: `window.${name}${hit.path ? `.${hit.path}` : ''} = ${hit.redacted}`,
				fix: 'Do not expose credentials as globals; any script on the page can read them.'
			});
		}
	}
}

// ------------------------------------------------------------------ sveltekit + env

function sveltekitGlobals(win: Window): { name: string; value: Record<string, unknown> }[] {
	const out: { name: string; value: Record<string, unknown> }[] = [];
	for (const name of Object.getOwnPropertyNames(win)) {
		if (!/^__sveltekit_/.test(name)) continue;
		try {
			const value = (win as unknown as Record<string, unknown>)[name];
			if (value && typeof value === 'object')
				out.push({ name, value: value as Record<string, unknown> });
		} catch {
			// unreadable
		}
	}
	return out;
}

/** `key: "value"` pairs of a devalue.uneval / JS object literal text. */
const LITERAL_PAIR =
	/[{,]\s*(?:"((?:[^"\\]|\\.){1,80})"|([A-Za-z_$][\w$]{0,80}))\s*:\s*"((?:[^"\\]|\\.)*)"/g;

export function literalPairs(text: string): { key: string; value: string }[] {
	const out: { key: string; value: string }[] = [];
	for (const m of text.matchAll(LITERAL_PAIR)) {
		let value = m[3];
		try {
			value = JSON.parse(`"${m[3]}"`);
		} catch {
			// keep raw
		}
		out.push({ key: m[1] ?? m[2], value });
	}
	return out;
}

function dataFinding(
	out: Findings,
	where: string,
	hit: ValueSecretHit | (SecretMatch & { path?: string; shaped?: boolean }),
	evidencePrefix: string,
	source?: string
): void {
	const shaped = 'shaped' in hit && hit.shaped !== undefined ? hit.shaped : true;
	const { severity, verdict } = hitSeverity(
		{ kind: hit.kind, shaped, confidence: hit.confidence },
		'data'
	);
	const path = 'path' in hit && hit.path ? hit.path : '';
	out.add({
		id: fingerprint('sensitive-page-data', where, path, hit.kind),
		check: 'sveltekit',
		severity: shaped && SERVER_SECRET_KINDS.has(hit.kind as SecretKind) ? 'high' : severity,
		verdict,
		title: `${shaped ? kindLabel(hit.kind) : `Sensitive field (${hit.kind})`} in SvelteKit ${where}`,
		evidence: `${evidencePrefix}${path ? ` ${path}` : ''} = ${hit.redacted}`,
		...(source ? { source } : {}),
		fix:
			'Return only the fields the page needs from load / remote functions (select columns explicitly, never ' +
			'`return { user }` with a whole DB row). Everything returned is serialized into the HTML and __data.json.'
	});
}

function scanKitText(text: string, where: string, prefix: string, out: Findings): void {
	for (const m of findSecrets(text, { entropy: false })) dataFinding(out, where, m, prefix);
	for (const { key, value } of literalPairs(text)) {
		const kind = sensitiveKeyKind(key);
		if (!kind || !isMeaningfulSecretValue(value) || detectSecret(value, { entropy: false }))
			continue;
		dataFinding(
			out,
			where,
			{ path: key, key, kind, confidence: 'low', shaped: false, redacted: redact(value, kind) },
			prefix
		);
	}
}

/** Parse a `__data.json` / remote-function body (JSON or NDJSON, devalue) and scan it. */
function scanKitJson(body: string): ValueSecretHit[] {
	const hits: ValueSecretHit[] = [];
	for (const line of body.split('\n').filter((l) => l.trim())) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const values: unknown[] = [];
		const nodes = (parsed as { nodes?: unknown[] })?.nodes;
		if (Array.isArray(nodes)) {
			for (const n of nodes) {
				const data = (n as { data?: unknown })?.data;
				values.push(unflattenDevalue(data) ?? data);
			}
		} else if (parsed && typeof parsed === 'object') {
			const p = parsed as Record<string, unknown>;
			for (const k of ['data', 'result']) {
				const v = p[k];
				if (typeof v === 'string') {
					try {
						const inner = JSON.parse(v);
						values.push(unflattenDevalue(inner) ?? inner);
					} catch {
						values.push(v);
					}
				} else if (Array.isArray(v)) values.push(unflattenDevalue(v) ?? v);
			}
			if (values.length === 0) values.push(parsed);
		}
		for (const v of values) hits.push(...scanValue(v, { entropy: false }));
	}
	return hits;
}

function checkSvelteKit(
	win: Window,
	doc: Document,
	entries: NetworkEntry[],
	out: Findings,
	notes: string[]
): void {
	const globals = sveltekitGlobals(win);
	const fetched = Array.from(doc.querySelectorAll('script[data-sveltekit-fetched]'));
	const bootScripts = Array.from(doc.querySelectorAll('script:not([src])')).filter((s) =>
		/__sveltekit_\w+/.test(s.textContent ?? '')
	);
	const dataEntries = entries.filter(
		(e) => e.tags.includes('sveltekit-data') || e.tags.includes('remote-function')
	);
	if (
		globals.length === 0 &&
		fetched.length === 0 &&
		bootScripts.length === 0 &&
		dataEntries.length === 0
	) {
		notes.push(
			'sveltekit: not a SvelteKit page (no __sveltekit_* global, boot script or __data.json)'
		);
		return;
	}

	for (const script of bootScripts) {
		scanKitText(
			script.textContent ?? '',
			'page data (inline boot script)',
			'boot <script> data',
			out
		);
	}
	for (const script of fetched) {
		const url = script.getAttribute('data-url') ?? '?';
		const where = `SSR fetch payload ${redactUrl(url).redacted}`;
		try {
			const payload = JSON.parse(script.textContent ?? '{}') as { body?: unknown };
			const body =
				typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body ?? '');
			let hits: ValueSecretHit[];
			try {
				hits = scanValue(JSON.parse(body), { entropy: false });
			} catch {
				hits = findSecrets(body, { entropy: false }).map((m) => ({
					path: '',
					key: null,
					kind: m.kind,
					confidence: m.confidence,
					shaped: true,
					redacted: m.redacted
				}));
			}
			for (const hit of hits)
				dataFinding(
					out,
					where,
					hit,
					`<script data-sveltekit-fetched data-url="${redactUrl(url).redacted}">`
				);
		} catch {
			// malformed payload
		}
	}
	for (const { name, value } of globals) {
		const data = value.data;
		if (data && typeof data === 'object') {
			for (const hit of scanValue(data, { entropy: false }))
				dataFinding(out, 'remote function data', hit, `window.${name}.data`);
		}
	}
	let withoutBodies = 0;
	for (const e of dataEntries) {
		if (!e.responseBody) {
			withoutBodies++;
			continue;
		}
		const where = e.tags.includes('remote-function')
			? 'remote function response'
			: '__data.json response';
		for (const hit of scanKitJson(e.responseBody)) {
			dataFinding(
				out,
				where,
				hit,
				`${e.method} ${redactUrl(e.url).redacted}`,
				initiatorSource(e.initiator)
			);
		}
	}
	if (withoutBodies > 0) {
		notes.push(
			`sveltekit: ${withoutBodies} __data.json / remote-function response(s) captured without bodies; ` +
				'run ui_network({ reload: true, includeBodies: true }) (or includeBodies: true before navigating) and scan again'
		);
	}
}

/**
 * The client env Vite bundles (VITE_* values), as exposed
 * by the `svelte-grab/vite` plugin's client module. The library itself never
 * reads Vite's env object (it must work with any bundler).
 */
function viteClientEnv(win: Window): Record<string, unknown> | null {
	try {
		const info = (win as unknown as Record<string, unknown>)[VITE_PLUGIN_GLOBAL] as
			{ env?: unknown } | undefined;
		return info?.env && typeof info.env === 'object' ? (info.env as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

const VITE_BUILTIN_ENV = new Set(['BASE_URL', 'MODE', 'DEV', 'PROD', 'SSR']);

function checkEnv(
	win: Window,
	env: Record<string, unknown> | null,
	out: Findings,
	notes: string[]
): void {
	const sources: { origin: string; vars: Record<string, unknown> }[] = [];
	if (env) sources.push({ origin: 'vite client env', vars: env });
	for (const { name, value } of sveltekitGlobals(win)) {
		if (value.env && typeof value.env === 'object') {
			sources.push({
				origin: `window.${name}.env ($env/dynamic/public)`,
				vars: value.env as Record<string, unknown>
			});
		}
	}
	if (sources.length === 0) {
		notes.push(
			'env: no client env reachable (add the svelte-grab/vite plugin to see VITE_* values; no SvelteKit dynamic public env)'
		);
		return;
	}
	for (const { origin, vars } of sources) {
		for (const [key, value] of Object.entries(vars)) {
			if (VITE_BUILTIN_ENV.has(key) || typeof value !== 'string' || !value) continue;
			const shaped = detectSecret(value, { entropy: false });
			const keyKind = sensitiveKeyKind(key);
			if (!shaped && !(keyKind && isMeaningfulSecretValue(value, 8))) continue;
			const severity: Severity = shaped
				? SERVER_SECRET_KINDS.has(shaped.kind)
					? 'high'
					: 'medium'
				: 'medium';
			out.add({
				id: fingerprint('secret-in-client-env', origin, key),
				check: 'env',
				severity,
				verdict: shaped ? 'confirmed' : 'needs_validation',
				title: `${shaped ? kindLabel(shaped.kind) : `Sensitive name (${keyKind})`} exposed to the browser as ${key}`,
				evidence: `${origin}.${key} = ${shaped ? shaped.redacted : redact(value, keyKind ?? 'env')}`,
				fix:
					'PUBLIC_* / VITE_* variables are bundled into client code. Move secrets to private env ' +
					'($env/static/private or $env/dynamic/private) and use them only in server code (*.server.ts, $lib/server).'
			});
		}
	}
}

// ------------------------------------------------------------------ headers

async function checkHeaders(
	pageUrl: string,
	doc: Document,
	doFetch: (url: string, init?: RequestInit) => Promise<Response>,
	out: Findings,
	notes: string[]
): Promise<void> {
	let page: URL;
	try {
		page = new URL(pageUrl);
	} catch {
		notes.push('headers: page URL unreadable');
		return;
	}
	const dev = isLoopbackHost(page.hostname);
	const sev = (prod: Severity): Severity => (dev ? 'info' : prod);
	const devNote = dev
		? ' (dev server: verify on the production response, e.g. vite preview / the deployed site)'
		: '';
	let res: Response;
	try {
		res = await doFetch(page.origin + page.pathname + page.search, {
			method: 'HEAD',
			cache: 'no-store',
			credentials: 'same-origin'
		});
	} catch (err) {
		notes.push(
			`headers: HEAD ${page.pathname} failed (${err instanceof Error ? err.message : String(err)})`
		);
		return;
	}
	const h = (name: string) => res.headers.get(name);
	const metaCsp =
		doc.querySelector('meta[http-equiv="Content-Security-Policy" i]')?.getAttribute('content') ??
		null;
	const csp = h('content-security-policy') ?? metaCsp;
	const add = (rule: string, severity: Severity, title: string, evidence: string, fix: string) =>
		out.add({
			id: fingerprint(rule, page.origin),
			check: 'headers',
			severity,
			verdict: dev ? 'needs_validation' : 'confirmed',
			title: title + devNote,
			evidence,
			fix
		});

	if (!csp) {
		add(
			'csp-missing',
			sev('medium'),
			'No Content-Security-Policy',
			`HEAD ${page.pathname} -> no content-security-policy header or meta`,
			'Enable SvelteKit `kit.csp` (mode auto, script-src self + nonces/hashes) or send a CSP header from hooks.server.ts.'
		);
	} else {
		const scriptSrc =
			/(?:^|;)\s*script-src\s+([^;]*)/i.exec(csp)?.[1] ??
			/(?:^|;)\s*default-src\s+([^;]*)/i.exec(csp)?.[1] ??
			'';
		if (/'unsafe-eval'/.test(scriptSrc)) {
			add(
				'csp-unsafe-eval',
				'medium',
				"CSP allows 'unsafe-eval' for scripts",
				`script-src ${scriptSrc.trim()}`,
				"Remove 'unsafe-eval'; avoid eval/new Function in app code and deps."
			);
		}
		if (
			/'unsafe-inline'/.test(scriptSrc) &&
			!/'nonce-|'sha(256|384|512)-|'strict-dynamic'/.test(scriptSrc)
		) {
			add(
				'csp-unsafe-inline',
				'medium',
				"CSP allows 'unsafe-inline' scripts",
				`script-src ${scriptSrc.trim()}`,
				"Use nonces or hashes (SvelteKit kit.csp mode 'auto') instead of 'unsafe-inline'."
			);
		}
		if (!/frame-ancestors/i.test(csp) && !h('x-frame-options')) {
			add(
				'clickjacking',
				sev('low'),
				'No frame-ancestors / X-Frame-Options (clickjacking)',
				`HEAD ${page.pathname} -> no frame-ancestors, no x-frame-options`,
				"Add CSP frame-ancestors 'self' (or X-Frame-Options: DENY)."
			);
		}
	}
	if (!csp && !h('x-frame-options')) {
		add(
			'clickjacking',
			sev('low'),
			'No frame-ancestors / X-Frame-Options (clickjacking)',
			`HEAD ${page.pathname} -> no frame-ancestors, no x-frame-options`,
			"Add CSP frame-ancestors 'self' (or X-Frame-Options: DENY)."
		);
	}
	if ((h('x-content-type-options') ?? '').toLowerCase() !== 'nosniff') {
		add(
			'no-nosniff',
			sev('low'),
			'X-Content-Type-Options: nosniff missing',
			`HEAD ${page.pathname} -> x-content-type-options: ${h('x-content-type-options') ?? '(none)'}`,
			'Send X-Content-Type-Options: nosniff (hooks.server.ts setHeaders or the adapter/CDN).'
		);
	}
	if (!h('referrer-policy')) {
		add(
			'no-referrer-policy',
			sev('low'),
			'Referrer-Policy missing',
			`HEAD ${page.pathname} -> no referrer-policy`,
			'Send Referrer-Policy: strict-origin-when-cross-origin (or stricter).'
		);
	}
	if (page.protocol === 'https:' && !h('strict-transport-security')) {
		add(
			'no-hsts',
			sev('low'),
			'Strict-Transport-Security missing',
			`HEAD ${page.pathname} -> no strict-transport-security`,
			'Send Strict-Transport-Security: max-age=31536000; includeSubDomains in production.'
		);
	} else if (page.protocol === 'http:' && dev) {
		notes.push('headers: HSTS not applicable on the http dev server');
	}

	const script = Array.from(doc.querySelectorAll('script[src]'))
		.map((s) => s.getAttribute('src') ?? '')
		.map((src) => {
			try {
				return new URL(src, pageUrl);
			} catch {
				return null;
			}
		})
		.find((u): u is URL => !!u && u.origin === page.origin && /\.m?js$/.test(u.pathname));
	if (script) {
		try {
			const map = await doFetch(`${script.origin}${script.pathname}.map`, {
				method: 'HEAD',
				cache: 'no-store'
			});
			if (map.ok && !/text\/html/i.test(map.headers.get('content-type') ?? '')) {
				add(
					'sourcemap-reachable',
					sev('low'),
					'Source maps are publicly reachable',
					`HEAD ${script.pathname}.map -> ${map.status}`,
					'Do not deploy .map files publicly (build.sourcemap: false or "hidden", upload them to your error tracker instead).'
				);
			}
		} catch {
			// unreachable: fine
		}
	}
}

// ------------------------------------------------------------------ dom

function checkDom(doc: Document, pageUrl: string, out: Findings): void {
	const page = (() => {
		try {
			return new URL(pageUrl);
		} catch {
			return null;
		}
	})();
	const blank: { el: Element; href: string }[] = [];
	for (const a of Array.from(doc.querySelectorAll('a[target="_blank" i][href]'))) {
		if (isInOwnUi(a)) continue;
		const rel = (a.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
		if (rel.includes('noopener') || rel.includes('noreferrer')) continue;
		const href = a.getAttribute('href') ?? '';
		try {
			const u = new URL(href, pageUrl);
			if (page && u.origin === page.origin) continue;
			if (!/^https?:$/.test(u.protocol)) continue;
		} catch {
			continue;
		}
		blank.push({ el: a, href });
	}
	const bySource = new Map<string, { el: Element; href: string }[]>();
	for (const item of blank) {
		const key = elementSource(item.el) ?? '(unknown source)';
		bySource.set(key, [...(bySource.get(key) ?? []), item]);
	}
	for (const [source, items] of bySource) {
		out.add({
			id: fingerprint('target-blank-no-rel', source),
			check: 'dom',
			severity: 'low',
			verdict: 'confirmed',
			title: `${items.length} external link(s) with target="_blank" and no rel="noopener"`,
			evidence: items
				.slice(0, MAX_ITEMS_PER_FINDING)
				.map((i) => `<a href="${redactUrl(i.href).redacted}" target="_blank">`)
				.join(', '),
			...(source !== '(unknown source)' ? { source } : {}),
			fix: 'Add rel="noopener noreferrer" to external target="_blank" links (older browsers expose window.opener).'
		});
	}

	// Svelte never renders on* attributes or javascript: URLs itself: they come from raw HTML ({@html}).
	const all = Array.from(doc.body?.querySelectorAll('*') ?? []).slice(0, 20_000);
	const handlers: { el: Element; attr: string }[] = [];
	const jsUrls: { el: Element; attr: string }[] = [];
	const scripts: Element[] = [];
	for (const el of all) {
		if (isInOwnUi(el)) continue;
		for (const attr of Array.from(el.attributes)) {
			const name = attr.name.toLowerCase();
			if (name.startsWith('on') && name.length > 2) handlers.push({ el, attr: name });
			else if (
				(name === 'href' || name === 'src' || name === 'action' || name === 'formaction') &&
				/^\s*javascript:/i.test(attr.value)
			) {
				jsUrls.push({ el, attr: name });
			}
		}
		if (
			el.localName === 'script' &&
			el.parentElement &&
			findMetaElement(el.parentElement) === el.parentElement &&
			!/__sveltekit_/.test(el.textContent ?? '')
		) {
			scripts.push(el);
		}
	}
	const report = (
		rule: string,
		list: { el: Element; attr?: string }[],
		title: string,
		fix: string
	) => {
		const bySrc = new Map<string, { el: Element; attr?: string }[]>();
		for (const item of list) {
			const key = elementSource(item.el.parentElement ?? item.el) ?? '(unknown source)';
			bySrc.set(key, [...(bySrc.get(key) ?? []), item]);
		}
		for (const [source, items] of bySrc) {
			out.add({
				id: fingerprint(rule, source),
				check: 'dom',
				severity: 'medium',
				verdict: 'needs_validation',
				title: `${items.length} ${title}`,
				evidence: items
					.slice(0, MAX_ITEMS_PER_FINDING)
					.map((i) => `<${i.el.localName}${i.attr ? ` ${i.attr}=…` : ''}>`)
					.join(', '),
				...(source !== '(unknown source)' ? { source } : {}),
				fix
			});
		}
	};
	const htmlFix =
		'Raw HTML ({@html}) must never contain user input: sanitize it (e.g. DOMPurify) or render it as text.';
	report(
		'inline-handler',
		handlers,
		'element(s) with inline on* handler attributes (raw HTML / {@html}?)',
		htmlFix
	);
	report('javascript-url', jsUrls, 'javascript: URL(s) (raw HTML / {@html}?)', htmlFix);
	report(
		'injected-script',
		scripts.map((el) => ({ el })),
		'<script> element(s) inside Svelte markup (raw HTML / {@html}?)',
		htmlFix
	);
}

// ------------------------------------------------------------------ mixed

function checkMixed(entries: NetworkEntry[], doc: Document, pageUrl: string, out: Findings): void {
	let page: URL;
	try {
		page = new URL(pageUrl);
	} catch {
		return;
	}
	const https = page.protocol === 'https:';
	for (const e of entries) {
		let u: URL;
		try {
			u = new URL(e.url);
		} catch {
			continue;
		}
		const insecure = u.protocol === 'http:' || u.protocol === 'ws:';
		if (!insecure) continue;
		if (https) {
			out.add({
				id: fingerprint('mixed-content', u.origin),
				check: 'mixed',
				severity: 'medium',
				verdict: 'confirmed',
				title: `Insecure ${u.protocol.replace(':', '')}:// request from an https page`,
				evidence: `${e.method} ${redactUrl(e.url).redacted}`,
				...(initiatorSource(e.initiator) ? { source: initiatorSource(e.initiator) } : {}),
				fix: 'Use https:// / wss:// for every request from an https page.'
			});
		} else if (u.protocol === 'ws:' && !isLoopbackHost(u.hostname)) {
			out.add({
				id: fingerprint('insecure-websocket', u.origin),
				check: 'mixed',
				severity: 'low',
				verdict: 'confirmed',
				title: 'Unencrypted WebSocket (ws://) to a remote host',
				evidence: `WS ${redactUrl(e.url).redacted}`,
				...(initiatorSource(e.initiator) ? { source: initiatorSource(e.initiator) } : {}),
				fix: 'Use wss:// for WebSockets outside localhost.'
			});
		}
	}
	if (https) {
		for (const el of Array.from(doc.querySelectorAll('[src^="http:" i], link[href^="http:" i]'))) {
			if (isInOwnUi(el)) continue;
			const url = el.getAttribute('src') ?? el.getAttribute('href') ?? '';
			out.add({
				id: fingerprint('mixed-content-dom', hostPath(url)),
				check: 'mixed',
				severity: 'medium',
				verdict: 'confirmed',
				title: `Insecure http:// <${el.localName}> on an https page`,
				evidence: `<${el.localName} ${el.hasAttribute('src') ? 'src' : 'href'}="${redactUrl(url).redacted}">`,
				...(elementSource(el) ? { source: elementSource(el) } : {}),
				fix: 'Load every subresource over https://.'
			});
		}
	} else if (!isLoopbackHost(page.hostname)) {
		out.add({
			id: fingerprint('page-over-http', page.origin),
			check: 'mixed',
			severity: 'medium',
			verdict: 'confirmed',
			title: 'Page served over plain http:// on a non-local host',
			evidence: `location ${page.origin}`,
			fix: 'Serve the app over https (and redirect http -> https).'
		});
	}
}

// ------------------------------------------------------------------ handler

function formatFindings(
	findings: SecurityFinding[],
	checks: SecurityCheck[],
	notes: string[]
): string {
	const counts = SEVERITY_ORDER.map(
		(s) => `${findings.filter((f) => f.severity === s).length} ${s}`
	);
	const lines = [
		findings.length === 0
			? `SECURITY no findings (checks: ${checks.join(', ')})`
			: `SECURITY ${counts.join(', ')} (checks: ${checks.join(', ')})`
	];
	for (const severity of SEVERITY_ORDER) {
		const group = findings.filter((f) => f.severity === severity);
		if (group.length === 0) continue;
		lines.push(severity.toUpperCase());
		for (const f of group) {
			lines.push(`  ${f.id} [${f.verdict}] ${f.title}`);
			lines.push(`    evidence: ${f.evidence}`);
			if (f.source) lines.push(`    source: ${f.source}`);
			lines.push(`    fix: ${f.fix}`);
		}
	}
	if (notes.length > 0) {
		lines.push('NOTES');
		for (const n of notes) lines.push(`  ${n}`);
	}
	// Belt and braces: nothing secret-shaped leaves the page unredacted.
	return redactText(lines.join('\n'), { entropy: false });
}

export async function uiSecurityScan(
	args: Record<string, unknown>,
	options: SecurityScanOptions = {}
): Promise<RuntimeToolResult> {
	const checks = parseChecks(args);
	const capture = options.capture ?? networkCapture;
	const win = options.win ?? window;
	const doc = options.doc ?? document;
	const pageUrl = options.pageUrl ?? win.location.href;
	const env = options.env !== undefined ? options.env : viteClientEnv(win);
	const doFetch =
		options.fetch ?? ((url: string, init?: RequestInit) => capture.ownFetch(url, init));
	const entries = capture.entries();
	const out = new Findings();
	const notes: string[] = [];
	if (checks.includes('transit') && !capture.active && entries.length === 0) {
		notes.push(
			'transit: network capture is not running (start the runtime with enableMcp); request checks saw nothing'
		);
	}

	for (const check of checks) {
		try {
			switch (check) {
				case 'transit':
					checkTransit(entries, pageUrl, out);
					break;
				case 'storage':
					await checkStorage(win, out, notes);
					break;
				case 'cookies':
					checkCookies(doc, out);
					break;
				case 'globals':
					checkGlobals(win, doc, out, notes);
					break;
				case 'sveltekit':
					checkSvelteKit(win, doc, entries, out, notes);
					break;
				case 'env':
					checkEnv(win, env, out, notes);
					break;
				case 'headers':
					await checkHeaders(pageUrl, doc, doFetch, out, notes);
					break;
				case 'dom':
					checkDom(doc, pageUrl, out);
					break;
				case 'mixed':
					checkMixed(entries, doc, pageUrl, out);
					break;
			}
		} catch (err) {
			notes.push(
				`${check}: check failed to run (${err instanceof Error ? err.message : String(err)})`
			);
		}
	}

	const findings = out.list.sort(
		(a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
	);
	const counts = Object.fromEntries(
		SEVERITY_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length])
	);
	return {
		text: formatFindings(findings, checks, notes),
		data: { counts, findings, notes, checks }
	};
}
