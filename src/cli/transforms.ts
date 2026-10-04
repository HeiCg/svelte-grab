/**
 * Pure, string-in/string-out project transforms shared by `svelte-grab init`
 * (src/cli/init.ts) and the `sv` community add-on (src/sv/plan.ts).
 *
 * No file system access here: callers read the file, pass its content (or
 * null when it does not exist) and write back `content` when `changed`.
 * Every transform is idempotent.
 */

// ============================================================
// Diff
// ============================================================

/**
 * Line diff (LCS) for previews: `'  '` unchanged, `'+ '` added, `'- '` removed.
 * Meant for small config files.
 */
export function lineDiff(before: string, after: string): string[] {
	const split = (s: string) => (s === '' ? [] : s.replace(/\n$/, '').split('\n'));
	const a = split(before);
	const b = split(after);
	const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
		new Array<number>(b.length + 1).fill(0)
	);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}
	const out: string[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			out.push(`  ${a[i]}`);
			i++;
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
			out.push(`- ${a[i++]}`);
		} else {
			out.push(`+ ${b[j++]}`);
		}
	}
	while (i < a.length) out.push(`- ${a[i++]}`);
	while (j < b.length) out.push(`+ ${b[j++]}`);
	return out;
}

// ============================================================
// .mcp.json
// ============================================================

export interface McpServerEntry {
	type: 'stdio';
	command: string;
	args: string[];
}

/** Server entries written to `.mcp.json`, keyed by server name. */
export const MCP_SERVERS = {
	// Local bin of the installed svelte-grab package (src/mcp/cli.ts), stdio transport.
	'svelte-grab': { type: 'stdio', command: 'npx', args: ['svelte-grab-mcp', '--stdio'] },
	// Official Svelte MCP: docs lookup + svelte-autofixer.
	svelte: { type: 'stdio', command: 'npx', args: ['-y', '@sveltejs/mcp'] },
	// Playwright MCP: real input, screenshots, viewports, network.
	playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] }
} as const satisfies Record<string, McpServerEntry>;

export type McpServerName = keyof typeof MCP_SERVERS;

export interface McpJsonOptions {
	/** Add the official Svelte MCP (`@sveltejs/mcp`). */
	svelteMcp: boolean;
	/** Add Playwright MCP (`@playwright/mcp`). */
	playwrightMcp: boolean;
}

export interface McpJsonResult {
	content: string;
	changed: boolean;
	/** Servers this merge added. */
	added: McpServerName[];
	/** Requested servers that were already declared (left untouched). */
	kept: McpServerName[];
	/** Set when the existing file cannot be merged safely; content is then the input. */
	error?: string;
}

/** Server names requested by the options, in write order. */
export function wantedMcpServers(options: McpJsonOptions): McpServerName[] {
	const names: McpServerName[] = ['svelte-grab'];
	if (options.svelteMcp) names.push('svelte');
	if (options.playwrightMcp) names.push('playwright');
	return names;
}

function detectIndent(json: string): string | number {
	const match = json.match(/^[ \t]+(?=")/m);
	if (!match) return 2;
	return match[0].includes('\t') ? '\t' : match[0].length;
}

/**
 * Merge svelte-grab's MCP servers into a `.mcp.json` (Claude Code project
 * format, `{ "mcpServers": { name: { command, args } } }`). Existing entries
 * are never replaced, other keys are kept, indentation is preserved.
 */
export function mergeMcpJson(existing: string | null, options: McpJsonOptions): McpJsonResult {
	const source = existing ?? '';
	const fail = (error: string): McpJsonResult => ({
		content: source,
		changed: false,
		added: [],
		kept: [],
		error
	});

	let data: Record<string, unknown> = {};
	if (source.trim()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(source);
		} catch {
			return fail('.mcp.json is not valid JSON; fix it or pass --no-mcp-json');
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return fail('.mcp.json must contain a JSON object');
		}
		data = parsed as Record<string, unknown>;
	}

	const current = data.mcpServers ?? {};
	if (!current || typeof current !== 'object' || Array.isArray(current)) {
		return fail('"mcpServers" in .mcp.json must be an object');
	}
	const servers = current as Record<string, unknown>;

	const added: McpServerName[] = [];
	const kept: McpServerName[] = [];
	for (const name of wantedMcpServers(options)) {
		if (name in servers) {
			kept.push(name);
		} else {
			const entry = MCP_SERVERS[name];
			servers[name] = { ...entry, args: [...entry.args] };
			added.push(name);
		}
	}

	if (added.length === 0 && source.trim()) {
		return { content: source, changed: false, added, kept };
	}
	data.mcpServers = servers;
	const content = JSON.stringify(data, null, source.trim() ? detectIndent(source) : 2) + '\n';
	return { content, changed: content !== source, added, kept };
}

// ============================================================
// .codex/config.toml (OpenAI Codex)
// ============================================================

/** Project-scoped Codex config (loaded by Codex for trusted projects only). */
export const CODEX_CONFIG_PATH = '.codex/config.toml';

/** Comment line written above every table svelte-grab adds. */
export const CODEX_ADDED_COMMENT = '# added by svelte-grab';

/**
 * Codex waits `startup_timeout_sec` (default 10) for a server to start; the
 * `npx -y` servers may download on first run, so they get more time.
 */
const CODEX_STARTUP_TIMEOUT_SEC: Partial<Record<McpServerName, number>> = {
	svelte: 30,
	playwright: 30
};

export interface CodexConfigResult {
	content: string;
	changed: boolean;
	/** Servers this merge added (a new `[mcp_servers.<name>]` table each). */
	added: McpServerName[];
	/** Requested servers already declared in the file (left untouched). */
	kept: McpServerName[];
}

const TOML_KEY_PART = /\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*/y;

/** Split a TOML (dotted) key into its parts, unquoted. Null when it is not a key. */
function splitTomlKey(key: string): string[] | null {
	const parts: string[] = [];
	let index = 0;
	for (;;) {
		TOML_KEY_PART.lastIndex = index;
		const match = TOML_KEY_PART.exec(key);
		if (!match) return null;
		const raw = match[1];
		parts.push(
			raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw.replace(/^'|'$/g, '')
		);
		index = TOML_KEY_PART.lastIndex;
		if (index === key.length) return parts;
		if (key[index] !== '.') return null;
		index++;
	}
}

/**
 * Names of the MCP servers a Codex `config.toml` declares, without a full
 * TOML parser: `[mcp_servers.<name>]` (or a sub-table of it), dotted keys
 * (`mcp_servers.<name>.command = ...` at the root) and keys inside an
 * `[mcp_servers]` table (`<name> = { ... }`). Lines inside multi-line strings
 * are skipped.
 */
export function codexDeclaredServers(toml: string): Set<string> {
	const names = new Set<string>();
	let table: string[] = [];
	let inMultiline = false;
	for (const line of toml.split(/\r?\n/)) {
		const fences = (line.match(/"""|'''/g) ?? []).length;
		if (inMultiline) {
			if (fences % 2 === 1) inMultiline = false;
			continue;
		}
		const header = /^\s*\[\[?([^[\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
		if (header) {
			table = splitTomlKey(header[1].trim()) ?? [];
		} else {
			const assignment = /^\s*([^=#[]+?)\s*=/.exec(line);
			const key = assignment && splitTomlKey(assignment[1]);
			if (key) {
				const path = [...table, ...key];
				if (path[0] === 'mcp_servers' && path.length >= 2) names.add(path[1]);
			}
			if (fences % 2 === 1) inMultiline = true;
			continue;
		}
		if (table[0] === 'mcp_servers' && table.length >= 2) names.add(table[1]);
	}
	return names;
}

/** The `[mcp_servers.<name>]` table svelte-grab writes for a server. */
export function codexServerTable(name: McpServerName): string {
	const entry = MCP_SERVERS[name];
	const lines = [
		CODEX_ADDED_COMMENT,
		`[mcp_servers.${name}]`,
		`command = ${JSON.stringify(entry.command)}`,
		`args = [${entry.args.map((arg) => JSON.stringify(arg)).join(', ')}]`
	];
	const timeout = CODEX_STARTUP_TIMEOUT_SEC[name];
	if (timeout) lines.push(`startup_timeout_sec = ${timeout}`);
	return lines.join('\n');
}

/**
 * Merge svelte-grab's MCP servers into a Codex `config.toml` by appending a
 * `[mcp_servers.<name>]` table for each one the file does not declare yet.
 * Existing tables and keys are never edited; a second run changes nothing.
 */
export function mergeCodexConfigToml(
	existing: string | null,
	options: McpJsonOptions
): CodexConfigResult {
	const source = existing ?? '';
	const declared = codexDeclaredServers(source);
	const added: McpServerName[] = [];
	const kept: McpServerName[] = [];
	for (const name of wantedMcpServers(options)) {
		if (declared.has(name)) kept.push(name);
		else added.push(name);
	}
	if (added.length === 0) return { content: source, changed: false, added, kept };

	const tables = added.map(codexServerTable).join('\n\n');
	let content = source.trim() === '' ? '' : source.endsWith('\n') ? source : `${source}\n`;
	if (content !== '') content += '\n';
	content += `${tables}\n`;
	return { content, changed: content !== source, added, kept };
}

// ============================================================
// vite.config.(ts|js)
// ============================================================

export const VITE_PLUGIN_IMPORT = "import { svelteGrab } from 'svelte-grab/vite';";

export interface VitePluginResult {
	content: string;
	changed: boolean;
	/** `manual`: the config shape was not recognised, nothing was written. */
	status: 'added' | 'already-present' | 'manual';
}

/**
 * Index just past the `)` that closes the call whose `(` is at `open`.
 * Skips string/template literals and comments. Returns -1 when unbalanced.
 */
function findClosingParen(src: string, open: number): number {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const ch = src[i];
		const next = src[i + 1];
		if (ch === '/' && next === '/') {
			const end = src.indexOf('\n', i);
			if (end === -1) return -1;
			i = end;
		} else if (ch === '/' && next === '*') {
			const end = src.indexOf('*/', i + 2);
			if (end === -1) return -1;
			i = end + 1;
		} else if (ch === '"' || ch === "'" || ch === '`') {
			i++;
			while (i < src.length && src[i] !== ch) {
				if (src[i] === '\\') i++;
				i++;
			}
		} else if (ch === '(') {
			depth++;
		} else if (ch === ')') {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

/** Offset just past the last top-level `import ...` statement (0 when none). */
function endOfImports(src: string): number {
	const importRe = /^import\b[^;]*?['"][^'"\n]+['"][ \t]*;?[ \t]*$/gm;
	let end = 0;
	let match: RegExpExecArray | null;
	while ((match = importRe.exec(src))) end = match.index + match[0].length;
	return end;
}

/**
 * Add `svelteGrab()` from `svelte-grab/vite` to a Vite config without an AST:
 * only when the file has a `plugins: [` array holding a `sveltekit(...)` or
 * `svelte(...)` call. The plugin goes right after that call, the import after
 * the last import. Anything else returns `status: 'manual'` unchanged.
 */
export function injectVitePlugin(content: string): VitePluginResult {
	if (content.includes('svelte-grab/vite')) {
		return { content, changed: false, status: 'already-present' };
	}
	const manual: VitePluginResult = { content, changed: false, status: 'manual' };

	const pluginsMatch = /\bplugins\s*:\s*\[/.exec(content);
	if (!pluginsMatch) return manual;
	const arrayStart = pluginsMatch.index + pluginsMatch[0].length;

	const callRe = /(?<![\w$.])(sveltekit|svelte)\s*\(/g;
	callRe.lastIndex = arrayStart;
	const call = callRe.exec(content);
	if (!call) return manual;
	// The call must sit inside the plugins array, i.e. before its closing `]`.
	const between = content.slice(arrayStart, call.index);
	if (between.split('[').length - 1 < between.split(']').length - 1) return manual;

	const callEnd = findClosingParen(content, call.index + call[0].length - 1);
	if (callEnd === -1) return manual;

	const lineStart = content.lastIndexOf('\n', call.index) + 1;
	const beforeCall = content.slice(lineStart, call.index);
	const onOwnLine = /^[ \t]*$/.test(beforeCall);
	const entry = onOwnLine ? `,\n${beforeCall}svelteGrab()` : ', svelteGrab()';

	let next = content.slice(0, callEnd) + entry + content.slice(callEnd);

	const importEnd = endOfImports(next);
	next =
		importEnd === 0
			? `${VITE_PLUGIN_IMPORT}\n${next}`
			: `${next.slice(0, importEnd)}\n${VITE_PLUGIN_IMPORT}${next.slice(importEnd)}`;

	return { content: next, changed: true, status: 'added' };
}

// ============================================================
// Root layout / App.svelte
// ============================================================

export interface LayoutOptions {
	/** Render `<SvelteDevKit enableMcp />` (connects to the MCP server). */
	enableMcp?: boolean;
	/** Language for a newly created file (`lang="ts"` script). */
	language?: 'ts' | 'js';
}

export interface LayoutResult {
	content: string;
	changed: boolean;
}

const IMPORTS_SVELTE_GRAB = /from\s+['"]svelte-grab['"]/;
// The instance <script>, not <script module> / <script context="module">.
const INSTANCE_SCRIPT = /(<script(?![^>]*\bcontext\s*=)(?![^>]*\bmodule\b)[^>]*>)/;
const IMPORT_LINE = "import { SvelteDevKit } from 'svelte-grab';";
const DEV_IMPORT_LINE = "import { dev } from '$app/environment';";

function devKitTag(options: LayoutOptions): string {
	return options.enableMcp ? '<SvelteDevKit enableMcp />' : '<SvelteDevKit />';
}

function scriptOpen(content: string | null, options: LayoutOptions): string {
	const ts = content ? /<script[^>]*lang=["']ts["']/.test(content) : options.language === 'ts';
	return ts ? '<script lang="ts">' : '<script>';
}

/**
 * Add `<SvelteDevKit />` to a SvelteKit root layout (`src/routes/+layout.svelte`),
 * gated by `dev` from `$app/environment` (still the dev flag in Kit 2 and 3).
 * Creates the layout when `existing` is null/empty.
 */
export function injectKitLayout(
	existing: string | null,
	options: LayoutOptions = {}
): LayoutResult {
	const tag = devKitTag(options);
	if (!existing || !existing.trim()) {
		const content = `${scriptOpen(null, options)}
	${DEV_IMPORT_LINE}
	${IMPORT_LINE}
	let { children } = $props();
</script>

{@render children?.()}

{#if dev}
	${tag}
{/if}
`;
		return { content, changed: true };
	}

	if (IMPORTS_SVELTE_GRAB.test(existing)) return { content: existing, changed: false };

	let content = existing;
	if (INSTANCE_SCRIPT.test(content)) {
		const children = content.includes('children') ? '' : '\n\tlet { children } = $props();';
		content = content.replace(
			INSTANCE_SCRIPT,
			`$1\n\t${DEV_IMPORT_LINE}\n\t${IMPORT_LINE}${children}`
		);
	} else {
		content =
			`${scriptOpen(content, options)}\n\t${DEV_IMPORT_LINE}\n\t${IMPORT_LINE}\n\tlet { children } = $props();\n</script>\n\n` +
			content;
	}

	content = content.trimEnd() + `\n\n{#if dev}\n\t${tag}\n{/if}\n`;
	return { content, changed: true };
}

/**
 * Add `<SvelteDevKit />` to a plain Vite + Svelte root component
 * (`src/App.svelte`). The tools disable themselves outside dev builds.
 */
export function injectAppSvelte(existing: string, options: LayoutOptions = {}): LayoutResult {
	if (IMPORTS_SVELTE_GRAB.test(existing)) return { content: existing, changed: false };

	let content = existing;
	if (INSTANCE_SCRIPT.test(content)) {
		content = content.replace(INSTANCE_SCRIPT, `$1\n\t${IMPORT_LINE}`);
	} else {
		content = `${scriptOpen(content, options)}\n\t${IMPORT_LINE}\n</script>\n\n` + content;
	}

	content = content.trimEnd() + `\n\n${devKitTag(options)}\n`;
	return { content, changed: true };
}

/**
 * True when the file renders `<SvelteDevKit>` or `<SvelteGrab>` without
 * `enableMcp` (used to hint at it when the layout was set up earlier).
 */
export function devKitMissingEnableMcp(content: string): boolean {
	const tag = /<(SvelteDevKit|SvelteGrab)\b([^>]*)>/.exec(content);
	if (!tag) return false;
	return !/\benableMcp\b/.test(tag[2]);
}
