/**
 * `svelte-grab/vite`: optional Vite plugin for the agent runtime
 * (docs/agent-runtime-spec.md, Phase 4). Dev server only (`apply: 'serve'`);
 * a production build never sees it.
 *
 * - HMR bridge: a tiny client module (`virtual:svelte-grab/client`) forwards
 *   Vite HMR events as `svelte-grab:hmr` CustomEvents on `window` and sets
 *   `window.__SVELTE_GRAB_VITE__ = { version, root, hmrBridge, importersEndpoint, env }`
 *   (`env` = the client's `import.meta.env`, read by `ui_security_scan`).
 *   It is injected into index.html (plain Vite) and prepended to every app
 *   module that imports `svelte-grab` (SvelteKit renders its own HTML, so
 *   `transformIndexHtml` never runs there).
 * - `GET /__svelte-grab/importers?file=<path>`: importers of a file from
 *   Vite's module graph. Same-origin requests only.
 * - Editor links: the marker tells svelte-grab to open files through Vite's
 *   built-in `/__open-in-editor` and gives it the project root.
 *
 * ```ts
 * // vite.config.ts
 * import { sveltekit } from '@sveltejs/kit/vite';
 * import { svelteGrab } from 'svelte-grab/vite';
 * export default defineConfig({ plugins: [sveltekit(), svelteGrab()] });
 * ```
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

/** Import specifier of the client module. */
export const VIRTUAL_CLIENT_ID = 'virtual:svelte-grab/client';
const RESOLVED_CLIENT_ID = `\0${VIRTUAL_CLIENT_ID}`;

/** Module-graph importers endpoint. */
export const IMPORTERS_PATH = '/__svelte-grab/importers';

/**
 * Names shared with the browser side (`src/lib/utils/vite-plugin-info.ts`;
 * `tests/vite-plugin.test.ts` keeps the copies in sync).
 */
export const VITE_PLUGIN_GLOBAL = '__SVELTE_GRAB_VITE__';
export const HMR_BRIDGE_EVENT = 'svelte-grab:hmr';
/** Window flag that keeps the bridge from subscribing twice. */
const BRIDGE_FLAG = '__SVELTE_GRAB_VITE_BRIDGE__';

/** Vite events the bridge forwards. */
export const BRIDGED_EVENTS = [
	'vite:beforeUpdate',
	'vite:afterUpdate',
	'vite:beforeFullReload',
	'vite:error'
] as const;

/** Longest the bridge lets a page listener hold the Vite client (e.g. before a reload). */
export const BRIDGE_HOLD_CAP_MS = 1_000;

const MAX_FILE_PARAM_LENGTH = 1_024;
const MAX_IMPORTERS = 500;

export interface SvelteGrabViteOptions {
	/** Forward HMR events to the page (`svelte-grab:hmr`). Default true. */
	hmrBridge?: boolean;
	/** Serve `GET /__svelte-grab/importers`. Default true. */
	importers?: boolean;
}

export interface ClientInfo {
	version: string;
	root: string;
	hmrBridge: boolean;
	importersEndpoint: string | null;
}

function readVersion(): string {
	try {
		const require = createRequire(import.meta.url);
		const pkg = require('../../package.json') as { name?: string; version?: string };
		return pkg.name === 'svelte-grab' && typeof pkg.version === 'string' ? pkg.version : '0.0.0';
	} catch {
		return '0.0.0';
	}
}

/** Source of `virtual:svelte-grab/client`. */
export function createClientModule(info: ClientInfo): string {
	return `// svelte-grab/vite client (dev only)
const info = ${JSON.stringify(info)};
if (typeof window !== 'undefined') {
	// env: the client env Vite already bundles (VITE_*), for ui_security_scan's env check.
	window[${JSON.stringify(VITE_PLUGIN_GLOBAL)}] = { ...info, env: import.meta.env };
	const flag = ${JSON.stringify(BRIDGE_FLAG)};
	if (info.hmrBridge && import.meta.hot && !window[flag]) {
		window[flag] = true;
		const forward = (type) => (payload) => {
			const holds = [];
			window.dispatchEvent(
				new CustomEvent(${JSON.stringify(HMR_BRIDGE_EVENT)}, {
					detail: { type, payload, waitUntil: (p) => holds.push(p) }
				})
			);
			if (holds.length === 0) return;
			return Promise.race([
				Promise.allSettled(holds),
				new Promise((resolve) => setTimeout(resolve, ${BRIDGE_HOLD_CAP_MS}))
			]);
		};
		for (const type of ${JSON.stringify(BRIDGED_EVENTS)}) import.meta.hot.on(type, forward(type));
	}
}
`;
}

const IMPORTS_SVELTE_GRAB = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']svelte-grab(?:\/[\w./-]*)?["']/;

/**
 * Prepend the client import to a module that imports `svelte-grab`. Returns
 * `null` when nothing changes. The import goes on the first line (no newline)
 * so existing source-map lines stay valid.
 */
export function injectClientImport(code: string): string | null {
	if (!IMPORTS_SVELTE_GRAB.test(code) || code.includes(VIRTUAL_CLIENT_ID)) return null;
	return `import ${JSON.stringify(VIRTUAL_CLIENT_ID)};${code}`;
}

/**
 * Whether a request comes from the dev server's own origin. Browsers send
 * `Sec-Fetch-Site` and/or `Origin`; non-browser clients (curl, the MCP server)
 * send neither and are allowed: the dev server is local.
 */
export function isSameOriginRequest(req: Pick<IncomingMessage, 'headers'>): boolean {
	const site = req.headers['sec-fetch-site'];
	if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
	const origin = req.headers.origin;
	if (typeof origin === 'string' && origin !== '') {
		if (origin === 'null') return false;
		try {
			return new URL(origin).host === req.headers.host;
		} catch {
			return false;
		}
	}
	return true;
}

/** Structural subset of Vite's (Environment)ModuleNode. */
export interface ModuleNodeLike {
	id: string | null;
	file: string | null;
	url: string;
	importers: Set<ModuleNodeLike>;
}

/** Structural subset of Vite's (Environment)ModuleGraph. */
export interface ModuleGraphLike {
	getModulesByFile(file: string): Set<ModuleNodeLike> | undefined;
	fileToModulesMap?: Map<string, Set<ModuleNodeLike>>;
}

export interface ImporterEntry {
	/** Root-relative path (absolute when outside the root). */
	file: string;
	url: string;
}

export interface ImportersResult {
	file: string;
	found: boolean;
	/** Files in the graph the query matched (root-relative). */
	matches: string[];
	importers: ImporterEntry[];
	truncated?: boolean;
}

function toPosix(p: string): string {
	return p.replace(/\\/g, '/');
}

function relativeToRoot(file: string, root: string): string {
	const rel = path.posix.relative(root, file);
	return rel && !rel.startsWith('..') && !path.posix.isAbsolute(rel) ? rel : file;
}

/** Boundary-aware suffix match (`Card.svelte` does not match `FixtureCard.svelte`). */
function suffixMatches(file: string, wanted: string): boolean {
	return file === wanted || file.endsWith(`/${wanted}`);
}

function normalizeQuery(file: string): string {
	let p = toPosix(file.trim()).replace(/[?#].*$/, '');
	if (p.startsWith('/@fs/')) p = p.slice(4);
	if (p.startsWith('./')) p = p.slice(2);
	return p;
}

/**
 * Importers of `fileParam` (absolute, root-relative or a path suffix) in the
 * module graph. Importers in the same file (e.g. a component and its CSS
 * module) are left out.
 */
export function findImporters(
	graph: ModuleGraphLike,
	root: string,
	fileParam: string
): ImportersResult {
	const rootPosix = toPosix(root).replace(/\/+$/, '');
	const query = normalizeQuery(fileParam);
	const result: ImportersResult = { file: fileParam, found: false, matches: [], importers: [] };
	if (!query) return result;

	const files = new Set<string>();
	const direct = [query, path.posix.join(rootPosix, query.replace(/^\/+/, ''))];
	for (const candidate of direct) {
		if (graph.getModulesByFile(candidate)?.size) files.add(candidate);
	}
	if (files.size === 0 && graph.fileToModulesMap) {
		const suffix = query.replace(/^\/+/, '');
		for (const file of graph.fileToModulesMap.keys()) {
			if (suffixMatches(file, suffix)) files.add(file);
		}
	}
	if (files.size === 0) return result;

	result.found = true;
	result.matches = [...files].map((f) => relativeToRoot(f, rootPosix));
	const seen = new Set<string>();
	for (const file of files) {
		for (const mod of graph.getModulesByFile(file) ?? []) {
			for (const importer of mod.importers) {
				const importerFile = importer.file ?? importer.id ?? importer.url;
				if (!importerFile || files.has(importerFile)) continue;
				const rel = relativeToRoot(toPosix(importerFile), rootPosix);
				if (seen.has(rel)) continue;
				if (seen.size >= MAX_IMPORTERS) {
					result.truncated = true;
					break;
				}
				seen.add(rel);
				result.importers.push({ file: rel, url: importer.url });
			}
		}
	}
	result.importers.sort((a, b) => a.file.localeCompare(b.file));
	return result;
}

type Middleware = (
	req: IncomingMessage,
	res: ServerResponse,
	next: (err?: unknown) => void
) => void;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.statusCode = status;
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-store');
	res.end(JSON.stringify(body));
}

/** Handler for {@link IMPORTERS_PATH} (mounted on that path, so `req.url` is `/?file=...`). */
export function createImportersMiddleware(
	getGraph: () => ModuleGraphLike | undefined,
	getRoot: () => string
): Middleware {
	return (req, res) => {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			res.setHeader('Allow', 'GET, HEAD');
			sendJson(res, 405, { error: 'Method not allowed' });
			return;
		}
		if (!isSameOriginRequest(req)) {
			sendJson(res, 403, { error: 'Cross-origin requests are not allowed' });
			return;
		}
		const file = new URL(req.url ?? '/', 'http://localhost').searchParams.get('file');
		if (!file) {
			sendJson(res, 400, { error: 'Missing "file" query parameter' });
			return;
		}
		if (file.length > MAX_FILE_PARAM_LENGTH) {
			sendJson(res, 414, { error: '"file" is too long' });
			return;
		}
		const graph = getGraph();
		if (!graph) {
			sendJson(res, 503, { error: 'Module graph unavailable' });
			return;
		}
		sendJson(res, 200, findImporters(graph, getRoot(), file));
	};
}

/** Structural subset of `ViteDevServer` the plugin uses. */
interface DevServerLike {
	moduleGraph?: ModuleGraphLike;
	environments?: Record<string, { moduleGraph?: ModuleGraphLike } | undefined>;
	middlewares: { use(path: string, handler: Middleware): unknown };
}

function clientGraph(server: DevServerLike): ModuleGraphLike | undefined {
	return server.environments?.client?.moduleGraph ?? server.moduleGraph;
}

export function svelteGrab(options: SvelteGrabViteOptions = {}): Plugin {
	const hmrBridge = options.hmrBridge !== false;
	const importers = options.importers !== false;
	const version = readVersion();
	let root = toPosix(process.cwd());
	let base = '/';

	return {
		name: 'svelte-grab',
		apply: 'serve',
		enforce: 'post',

		configResolved(config) {
			root = toPosix(config.root);
			base = config.base || '/';
		},

		resolveId(id) {
			return id === VIRTUAL_CLIENT_ID ? RESOLVED_CLIENT_ID : null;
		},

		load(id) {
			if (id !== RESOLVED_CLIENT_ID) return null;
			return createClientModule({
				version,
				root,
				hmrBridge,
				importersEndpoint: importers ? IMPORTERS_PATH : null
			});
		},

		transform(code, id, transformOptions) {
			if (transformOptions?.ssr) return null;
			if (id.startsWith('\0') || id.includes('/node_modules/')) return null;
			const injected = injectClientImport(code);
			return injected === null ? null : { code: injected, map: null };
		},

		transformIndexHtml() {
			return [
				{
					tag: 'script',
					attrs: {
						type: 'module',
						src: `${base.replace(/\/?$/, '/')}@id/__x00__${VIRTUAL_CLIENT_ID}`
					},
					injectTo: 'head'
				}
			];
		},

		configureServer(server) {
			if (!importers) return;
			const dev = server as unknown as DevServerLike;
			dev.middlewares.use(
				IMPORTERS_PATH,
				createImportersMiddleware(
					() => clientGraph(dev),
					() => root
				)
			);
		}
	};
}

export default svelteGrab;
