/**
 * Light source helpers for the audit rules: offsets to line/column, comment
 * masking, balanced-bracket extraction and file classification
 * (server-only vs client-reachable). Regex + small scanners on purpose: the
 * audit must run with zero config and no parser beyond the Svelte compiler.
 */

/** Line-start offsets of `text`, for {@link lineColAt}. */
export function lineStarts(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
	return starts;
}

/** 1-based line and column of `offset`. */
export function lineColAt(starts: number[], offset: number): { line: number; column: number } {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return { line: lo + 1, column: offset - starts[lo] + 1 };
}

const TOKEN_CHAR = /[A-Za-z0-9+/_=.~-]/;

/**
 * The trimmed source line containing `offset`. Long (minified) lines are
 * windowed to about `radius` characters around `offset`, with the window
 * edges pushed out to token boundaries so a secret is never cut in half
 * (a partial secret would escape redaction). Callers redact the result
 * before truncating it (see `evidence()` in rules/shared.ts).
 */
export function lineAt(text: string, offset: number, radius = 300): string {
	const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
	let lineEnd = text.indexOf('\n', offset);
	if (lineEnd === -1) lineEnd = text.length;
	let start = Math.max(lineStart, offset - radius);
	let end = Math.min(lineEnd, offset + radius);
	while (start > lineStart && TOKEN_CHAR.test(text[start - 1])) start--;
	while (end < lineEnd && TOKEN_CHAR.test(text[end])) end++;
	return (
		(start > lineStart ? '…' : '') + text.slice(start, end).trim() + (end < lineEnd ? '…' : '')
	);
}

/** Collapse whitespace and cap the length of a code excerpt. */
export function excerpt(code: string, max = 160): string {
	const one = code.replace(/\s+/g, ' ').trim();
	return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

function blank(s: string): string {
	return s.replace(/[^\n]/g, ' ');
}

/**
 * `text` with JS comments (`//`, `/* *\/`) replaced by spaces, offsets and
 * newlines preserved. Strings and template literals are kept (rules look for
 * `'message'` etc.). Regex literals are not recognised (good enough here).
 */
export function maskComments(text: string): string {
	let out = '';
	let i = 0;
	const n = text.length;
	while (i < n) {
		const ch = text[i];
		const next = text[i + 1];
		if (ch === '/' && next === '/') {
			let end = text.indexOf('\n', i);
			if (end === -1) end = n;
			out += blank(text.slice(i, end));
			i = end;
			continue;
		}
		if (ch === '/' && next === '*') {
			let end = text.indexOf('*/', i + 2);
			end = end === -1 ? n : end + 2;
			out += blank(text.slice(i, end));
			i = end;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === '`') {
			const end = stringEnd(text, i);
			out += text.slice(i, end);
			i = end;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/**
 * `code` (already comment-masked) with the contents of string and template
 * literals blanked, quotes and offsets kept: for rules that must not match
 * inside strings (`'eval() is bad'`).
 */
export function maskStrings(code: string): string {
	let out = '';
	let i = 0;
	while (i < code.length) {
		const ch = code[i];
		if (ch === '"' || ch === "'" || ch === '`') {
			const end = stringEnd(code, i);
			const closed = code[end - 1] === ch && end - 1 > i;
			const inner = code.slice(i + 1, closed ? end - 1 : end);
			out += ch + blank(inner) + (closed ? ch : '');
			i = end;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/** Offset just past the string literal starting at `start` (quote char). */
function stringEnd(text: string, start: number): number {
	const quote = text[start];
	let i = start + 1;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '\\') {
			i += 2;
			continue;
		}
		if (ch === quote) return i + 1;
		if (quote !== '`' && ch === '\n') return i;
		i++;
	}
	return text.length;
}

const CLOSE: Record<string, string> = { '{': '}', '(': ')', '[': ']' };

/**
 * Offset just past the bracket matching the one at `open` (`{`, `(`, `[`),
 * skipping strings. Expects comment-masked text. -1 when unbalanced.
 */
export function matchBracket(text: string, open: number): number {
	const stack: string[] = [];
	for (let i = open; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"' || ch === "'" || ch === '`') {
			i = stringEnd(text, i) - 1;
			continue;
		}
		if (ch in CLOSE) stack.push(CLOSE[ch]);
		else if (ch === '}' || ch === ')' || ch === ']') {
			if (stack.pop() !== ch) return -1;
			if (stack.length === 0) return i + 1;
		}
	}
	return -1;
}

/** Split `inner` (text between brackets) on top-level commas, with offsets. */
export function splitTopLevel(inner: string, base: number): { text: string; start: number }[] {
	const parts: { text: string; start: number }[] = [];
	let depth = 0;
	let partStart = 0;
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (ch === '"' || ch === "'" || ch === '`') {
			i = stringEnd(inner, i) - 1;
			continue;
		}
		if (ch === '{' || ch === '(' || ch === '[') depth++;
		else if (ch === '}' || ch === ')' || ch === ']') depth--;
		else if (ch === ',' && depth === 0) {
			parts.push({ text: inner.slice(partStart, i), start: base + partStart });
			partStart = i + 1;
		}
	}
	parts.push({ text: inner.slice(partStart), start: base + partStart });
	return parts
		.map((p) => {
			const lead = p.text.length - p.text.trimStart().length;
			return { text: p.text.trim(), start: p.start + lead };
		})
		.filter((p) => p.text.length > 0);
}

/**
 * End of the statement starting at `start`: the first `;` at depth 0, or a
 * newline at depth 0 not followed by a continuation (`.`, `?`, operator).
 */
export function statementEnd(text: string, start: number): number {
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"' || ch === "'" || ch === '`') {
			i = stringEnd(text, i) - 1;
			continue;
		}
		if (ch === '{' || ch === '(' || ch === '[') depth++;
		else if (ch === '}' || ch === ')' || ch === ']') {
			if (depth === 0) return i;
			depth--;
		} else if (depth === 0 && ch === ';') return i;
		else if (depth === 0 && ch === '\n') {
			const rest = text.slice(i + 1).trimStart();
			if (!/^(?:\.|\?|\|\||&&|\+|-|\*|\/|:)/.test(rest)) return i;
		}
	}
	return text.length;
}

/**
 * The body of a function whose definition starts at `from`: the text inside
 * the first `{...}` after its parameter list / `=>`, or, for an arrow with an
 * expression body, the expression. Expects comment-masked text.
 */
export function functionBodyAfter(
	text: string,
	from: number
): { start: number; end: number; expression: boolean } | null {
	let i = from;
	const skipWs = () => {
		while (i < text.length && /\s/.test(text[i])) i++;
	};
	skipWs();
	if (text.startsWith('async', i) && !/[\w$]/.test(text[i + 5] ?? '')) {
		i += 5;
		skipWs();
	}
	if (text.startsWith('function', i)) {
		i += 8;
		while (i < text.length && text[i] !== '(') i++;
	}
	if (text[i] === '(') {
		const close = matchBracket(text, i);
		if (close === -1) return null;
		i = close;
	} else {
		// single identifier parameter: `event => ...`
		const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
		if (!m) return null;
		i += m[0].length;
	}
	// optional return type / arrow
	while (i < text.length && text[i] !== '{' && !text.startsWith('=>', i)) {
		if (text[i] === ';') return null;
		i++;
	}
	if (text.startsWith('=>', i)) {
		i += 2;
		skipWs();
		if (text[i] !== '{') {
			const end = statementEnd(text, i);
			return { start: i, end, expression: true };
		}
	}
	if (text[i] !== '{') return null;
	const close = matchBracket(text, i);
	if (close === -1) return null;
	return { start: i + 1, end: close - 1, expression: false };
}

/** Body text of a function named `name` declared in `code`, or null. */
export function resolveFunctionBody(code: string, name: string): string | null {
	const escaped = name.replace(/[$]/g, '\\$');
	const decl = new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`).exec(code);
	if (decl) {
		const body = functionBodyAfter(code, decl.index);
		return body ? code.slice(body.start, body.end) : null;
	}
	const assign = new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*(?::[^=]+)?=\\s*`).exec(code);
	if (assign) {
		const body = functionBodyAfter(code, assign.index + assign[0].length);
		return body ? code.slice(body.start, body.end) : null;
	}
	return null;
}

// ------------------------------------------------------------------ classification

export type FileContext = 'client' | 'server' | 'test' | 'tooling' | 'env';

const CODE_EXT = /\.(?:svelte|[cm]?[jt]sx?)$/;

export function isCodeFile(rel: string): boolean {
	return CODE_EXT.test(rel) && !/\.d\.[cm]?ts$/.test(rel);
}

export function isEnvFile(rel: string): boolean {
	const base = rel.split('/').pop() ?? '';
	return base === '.env' || base.startsWith('.env.');
}

/**
 * Server-only per SvelteKit's rules: any `server` path segment
 * (`src/lib/server/`, `$lib/server`, `#lib/server`), a `.server.` filename
 * segment (`hooks.server.ts`, `+page.server.ts`, `+layout.server.ts`,
 * `secrets.server.ts`), route endpoints (`+server.ts`), and remote-function
 * files (`*.remote.ts`, executed on the server; the client gets fetch stubs).
 */
export function isServerOnly(rel: string): boolean {
	const segments = rel.split('/');
	const base = segments[segments.length - 1];
	if (segments.slice(0, -1).includes('server')) return true;
	if (/^\+server\.[cm]?[jt]s$/.test(base)) return true;
	return /\.(?:server|remote)\./.test(base) || /^(?:server|remote)\./.test(base);
}

/** Tests and fixtures: never bundled for the browser. */
export function isTestFile(rel: string): boolean {
	const segments = rel.split('/');
	const base = segments[segments.length - 1];
	if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base)) return true;
	const dirs = segments.slice(0, -1);
	if (dirs.includes('__tests__')) return true;
	// `src/routes/test/` is a route, not a test directory: only count a test
	// segment that is not below a `routes` segment.
	const routes = dirs.indexOf('routes');
	return dirs.some(
		(s, i) => (s === 'tests' || s === 'test' || s === 'e2e') && (routes === -1 || i < routes)
	);
}

/** Node-side tooling: `*.config.*` files and anything outside src/static/public. */
function isTooling(rel: string): boolean {
	const segments = rel.split('/');
	const base = segments[segments.length - 1];
	if (/\.config\.[cm]?[jt]s$/.test(base)) return true;
	return !segments.slice(0, -1).some((s) => s === 'src' || s === 'static' || s === 'public');
}

export function classifyFile(rel: string): FileContext {
	if (isEnvFile(rel)) return 'env';
	if (isTestFile(rel)) return 'test';
	if (isServerOnly(rel)) return 'server';
	if (isTooling(rel)) return 'tooling';
	return 'client';
}

export function isSvelteKitServerLoadFile(rel: string): boolean {
	return /(?:^|\/)\+(?:page|layout)\.server\.[cm]?[jt]s$/.test(rel);
}

export function isPageServerFile(rel: string): boolean {
	return /(?:^|\/)\+page\.server\.[cm]?[jt]s$/.test(rel);
}

export function isRemoteFile(rel: string): boolean {
	return /\.remote\.[cm]?[jt]s$/.test(rel);
}
