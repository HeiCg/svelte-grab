/**
 * SvelteKit rules (heuristics, so mostly `needs_validation`):
 *
 * - `kit/load-overexposure`: a `+page.server` / `+layout.server` `load`
 *   returning a bare identifier (or spreading one) that comes from a DB /
 *   query call without field selection: the "returned the whole user row"
 *   leak, since everything `load` returns is serialized into the page.
 * - `kit/action-no-auth`: form actions without an obvious auth check.
 * - `kit/remote-no-auth`: remote `command(...)` / `form(...)` (from
 *   `$app/server`) without an obvious auth check.
 * - `kit/csrf-trusted-origins-wildcard`: `csrf.trustedOrigins` contains `'*'`.
 * - `kit/csp-missing`: Kit `csp` config absent and no hook / server file sets
 *   a Content-Security-Policy header.
 *
 * "Obvious auth check": `locals.user|session|auth...`, destructured
 * `locals: { user }`, `getRequestEvent().locals`, `redirect(30x`,
 * `error(401|403`, `fail(401|403`, or a `requireAuth`-style helper call.
 */
import {
	functionBodyAfter,
	isPageServerFile,
	isRemoteFile,
	isSvelteKitServerLoadFile,
	lineAt,
	maskComments,
	matchBracket,
	resolveFunctionBody,
	splitTopLevel,
	statementEnd
} from '../source.js';
import type { SourceFile } from '../types.js';
import { FindingSink, type RuleContext } from './shared.js';

export const AUTH_CHECK =
	/\blocals\s*\??\.\s*(?:user|session|auth|account|member|admin|role|getSession|safeGetSession|validate\w*|require\w*)\b|\blocals\s*:\s*\{[^}]*\b(?:user|session|auth)\b|\{[^}]*\b(?:user|session|auth)\b[^}]*\}\s*=\s*(?:\w+\s*\.\s*)?locals\b|getRequestEvent\s*\(\s*\)\s*\.\s*locals|\bredirect\s*\(\s*30[1-8]\b|\berror\s*\(\s*40[13]\b|\bfail\s*\(\s*40[13]\b|\b(?:requireAuth\w*|requireUser|requireLogin|requireSession|requireAdmin|ensureAuth\w*|assertAuth\w*|isAuthenticated|checkAuth\w*|authorize\w*|getUserOrThrow)\s*\(/;

/** Initializers that read from a database / query builder. */
const DB_CALL =
	/\b(?:db|prisma|sql|knex|drizzle|supabase|pool|kysely|mongoose|collection|turso|pg|mysql|sqlite|orm|repo|repository)\b\s*[.(`]|\.(?:find(?:Unique|First|Many|One|ById|All)\w*|findUniqueOrThrow|findFirstOrThrow|query\w*|execute\w*|first|raw|selectFrom)\s*[(`<]|\bsql\s*`/;
/** The query picks fields explicitly. */
const FIELD_SELECTION =
	/\bselect\s*:\s*\{|\bcolumns\s*:\s*\{|\.select\s*\(\s*(?:\{|\[|['"`](?!\s*\*\s*['"`])[^'"`]+['"`])|\.pick\s*\(|\bomit\s*:|\bSELECT\s+(?!\*)[\w"`]/i;

// ------------------------------------------------------------------ load over-exposure

/** Offset ranges of the `load` function body. */
function loadBodies(code: string): { start: number; end: number; expression: boolean }[] {
	const bodies: { start: number; end: number; expression: boolean }[] = [];
	const re =
		/export\s+(?:(async\s+function|function)\s+load\b|(?:const|let|var)\s+load\b[^=]*=\s*)/g;
	for (const m of code.matchAll(re)) {
		const at = m[1] ? (m.index ?? 0) + m[0].indexOf(m[1]) : (m.index ?? 0) + m[0].length;
		let body = functionBodyAfter(code, at);
		if (!body && code[at] === '(') body = functionBodyAfter(code, at + 1);
		if (body) bodies.push(body);
	}
	return bodies;
}

/** Initializer of `const|let|var <name> = ...` (also `[name]` / `{ name }`), searched in `scope`. */
function initializerOf(
	code: string,
	scope: { start: number; end: number },
	name: string
): string | null {
	const n = name.replace(/[$]/g, '\\$');
	const re = new RegExp(
		`\\b(?:const|let|var)\\s+(?:${n}\\b|\\[\\s*${n}\\b[^\\]]*\\]|\\{[^}]*\\b${n}\\b[^}]*\\})\\s*(?::[^=]+)?=\\s*`,
		'g'
	);
	const search = (from: number, to: number): string | null => {
		re.lastIndex = from;
		const m = re.exec(code);
		if (!m || m.index >= to) return null;
		const start = m.index + m[0].length;
		return code.slice(start, statementEnd(code, start));
	};
	return search(scope.start, scope.end) ?? search(0, code.length);
}

function isUnselectedQuery(init: string): boolean {
	return DB_CALL.test(init) && !FIELD_SELECTION.test(init);
}

function loadRule(code: string, sink: FindingSink): void {
	for (const body of loadBodies(code)) {
		const objects: number[] = [];
		const segment = code.slice(body.start, body.end);
		if (body.expression) {
			const lead = /^\(\s*\{/.exec(segment);
			if (lead) objects.push(body.start + lead[0].length - 1);
		}
		for (const m of segment.matchAll(/\breturn\s*\(?\s*\{/g))
			objects.push(body.start + (m.index ?? 0) + m[0].length - 1);

		for (const open of objects) {
			const close = matchBracket(code, open);
			if (close === -1) continue;
			for (const entry of splitTopLevel(code.slice(open + 1, close - 1), open + 1)) {
				let name: string | null = null;
				let direct: string | null = null;
				const spread = /^\.\.\.\s*([\s\S]+)$/.exec(entry.text);
				const shorthand = /^([A-Za-z_$][\w$]*)$/.exec(entry.text);
				const keyed = /^([A-Za-z_$][\w$]*|['"][^'"]+['"])\s*:\s*([\s\S]+)$/.exec(entry.text);
				const valueExpr = spread ? spread[1] : shorthand ? shorthand[1] : keyed ? keyed[2] : null;
				if (!valueExpr) continue;
				const ident = /^(?:await\s+)?([A-Za-z_$][\w$]*)$/.exec(valueExpr.trim());
				if (ident) name = ident[1];
				else direct = valueExpr;

				const init = name ? initializerOf(code, body, name) : direct;
				if (!init || !isUnselectedQuery(init)) continue;
				const what = spread ? `spreads "${spread[1].trim()}"` : `returns "${entry.text}"`;
				sink.add(
					'kit/load-overexposure',
					entry.start,
					'medium',
					'needs_validation',
					'Possible over-exposure of server data: load returns a whole DB row',
					`load ${what}${name ? ` where ${name} = ${init.trim()}` : ''}`,
					'Everything load returns is serialized into the page (HTML and __data.json). Return only the fields the page needs (select them in the query or map the row) and never password hashes, tokens or internal ids.'
				);
			}
		}
	}
}

// ------------------------------------------------------------------ actions

function actionsRule(code: string, sink: FindingSink): void {
	for (const m of code.matchAll(/export\s+const\s+actions\b[^=]*=\s*/g)) {
		let open = (m.index ?? 0) + m[0].length;
		while (open < code.length && code[open] !== '{') {
			if (code[open] !== '(' && !/\s/.test(code[open])) break;
			open++;
		}
		if (code[open] !== '{') continue;
		const close = matchBracket(code, open);
		if (close === -1) continue;
		for (const entry of splitTopLevel(code.slice(open + 1, close - 1), open + 1)) {
			const keyMatch = /^(?:async\s+)?([A-Za-z_$][\w$]*|['"][^'"]+['"])/.exec(entry.text);
			if (!keyMatch) continue;
			const key = keyMatch[1].replace(/['"]/g, '');
			let body: string | null = entry.text;
			const ref =
				/^[A-Za-z_$][\w$]*\s*:\s*([A-Za-z_$][\w$]*)$/.exec(entry.text) ??
				/^([A-Za-z_$][\w$]*)$/.exec(entry.text);
			if (ref) body = resolveFunctionBody(code, ref[1]);
			if (body !== null && AUTH_CHECK.test(body)) continue;
			sink.add(
				'kit/action-no-auth',
				entry.start,
				'medium',
				'needs_validation',
				body === null
					? `Form action "${key}": handler not found, auth check unverified`
					: `Form action "${key}" without an obvious auth check`,
				lineAt(code, entry.start),
				'Actions are public POST endpoints. Check the session first (e.g. `if (!locals.user) return fail(401)` or `redirect(303, "/login")`) unless the action is meant to be anonymous; if hooks.server already guards this route, mark the finding rejected.'
			);
		}
	}
}

// ------------------------------------------------------------------ remote functions

function remoteRule(code: string, sink: FindingSink): void {
	const locals = new Map<string, string>();
	for (const imp of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\$app\/server['"]/g)) {
		for (const spec of imp[1].split(',')) {
			const m = /^\s*(command|form)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(spec);
			if (m) locals.set(m[2] ?? m[1], m[1]);
		}
	}
	if (locals.size === 0) return;
	const names = [...locals.keys()].map((n) => n.replace(/[$]/g, '\\$')).join('|');
	const re = new RegExp(
		`\\b(?:export\\s+)?const\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=]+)?=\\s*(${names})\\s*(?:<[^>]*>)?\\s*\\(`,
		'g'
	);
	for (const m of code.matchAll(re)) {
		const open = (m.index ?? 0) + m[0].length - 1;
		const close = matchBracket(code, open);
		if (close === -1) continue;
		const args = code.slice(open, close);
		if (AUTH_CHECK.test(args)) continue;
		// A handler passed by name: look it up.
		const lastArg = splitTopLevel(args.slice(1, -1), 0).pop()?.text ?? '';
		if (/^[A-Za-z_$][\w$]*$/.test(lastArg)) {
			const body = resolveFunctionBody(code, lastArg);
			if (body !== null && AUTH_CHECK.test(body)) continue;
		}
		const kind = locals.get(m[2]) ?? m[2];
		sink.add(
			'kit/remote-no-auth',
			m.index ?? 0,
			'medium',
			'needs_validation',
			`Remote ${kind} "${m[1]}" without an obvious auth check`,
			lineAt(code, m.index ?? 0),
			'Remote commands and forms are public HTTP endpoints. Read the session with getRequestEvent().locals and reject anonymous callers (error(401)) unless the function is meant to be public.'
		);
	}
}

// ------------------------------------------------------------------ config

const SVELTE_CONFIG = /(?:^|\/)svelte\.config\.[cm]?[jt]s$/;
const VITE_CONFIG = /(?:^|\/)vite\.config\.[cm]?[jt]s$/;

function trustedOriginsRule(code: string, sink: FindingSink): void {
	for (const m of code.matchAll(/\btrustedOrigins\s*:\s*\[/g)) {
		const open = (m.index ?? 0) + m[0].length - 1;
		const close = matchBracket(code, open);
		if (close === -1) continue;
		const star = /(['"`])\*\1/.exec(code.slice(open, close));
		if (!star) continue;
		const at = open + star.index;
		sink.add(
			'kit/csrf-trusted-origins-wildcard',
			at,
			'high',
			'confirmed',
			"csrf.trustedOrigins allows every origin ('*')",
			lineAt(code, at),
			"'*' turns off SvelteKit's CSRF origin check for form submissions. List the exact origins that may POST forms to this app."
		);
	}
}

function cspRule(file: SourceFile, code: string, ctx: RuleContext, sink: FindingSink): void {
	if (!/\bkit\s*:/.test(code)) return;
	if (/\bcsp\s*:/.test(code)) return;
	const dir = file.rel.includes('/') ? file.rel.slice(0, file.rel.lastIndexOf('/') + 1) : '';
	for (const [rel, other] of ctx.files) {
		if (!rel.startsWith(dir) || !/\.server\.[cm]?[jt]s$|(?:^|\/)\+server\.[cm]?[jt]s$/.test(rel))
			continue;
		if (/content-security-policy/i.test(other.text)) return;
	}
	const kit = /\bkit\s*:/.exec(code);
	const at = kit ? kit.index : 0;
	sink.add(
		'kit/csp-missing',
		at,
		'low',
		'confirmed',
		'No Content-Security-Policy: kit.csp is not configured and no hook sets the header',
		lineAt(code, at),
		"Add `kit: { csp: { mode: 'auto', directives: { 'script-src': ['self'] } } }` to svelte.config (Kit adds nonces/hashes for its own scripts), or set the header in hooks.server / at the CDN."
	);
}

// ------------------------------------------------------------------ entry

export function kitRules(file: SourceFile, ctx: RuleContext): FindingSink {
	const sink = new FindingSink(file);
	const rel = file.rel;
	const svelteConfig = SVELTE_CONFIG.test(rel);
	const viteConfig = VITE_CONFIG.test(rel);
	const loadFile = isSvelteKitServerLoadFile(rel);
	const remote = isRemoteFile(rel);
	if (!svelteConfig && !viteConfig && !loadFile && !remote) return sink;

	const code = maskComments(file.text);
	if (loadFile) loadRule(code, sink);
	if (isPageServerFile(rel)) actionsRule(code, sink);
	if (remote) remoteRule(code, sink);
	if (svelteConfig || viteConfig) trustedOriginsRule(code, sink);
	if (svelteConfig) cspRule(file, code, ctx, sink);
	return sink;
}
