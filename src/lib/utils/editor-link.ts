/**
 * Pure editor-deep-link and project-root detection helpers for SvelteGrab.
 *
 * Extracted from SvelteGrab.svelte. These functions build `editor://` deep links
 * for the 8 supported editors and detect the project's absolute filesystem root
 * from Vite dev-server URLs / Svelte file paths. None of them close over
 * component `$state` — the editor and project root are passed in explicitly.
 *
 * With the `svelte-grab/vite` plugin installed, the project root comes from the
 * plugin and files open through Vite's `/__open-in-editor` middleware; the
 * deep-link heuristics below are the fallback.
 */
import { OPEN_IN_EDITOR_PATH, getVitePluginInfo } from './vite-plugin-info.js';

/** Editor identifiers supported by {@link buildEditorUrl}. */
export type EditorId =
	| 'vscode'
	| 'cursor'
	| 'webstorm'
	| 'zed'
	| 'sublime'
	| 'idea'
	| 'phpstorm'
	| 'pycharm'
	| 'none';

/**
 * Cached Vite project root.
 * `undefined` = not yet attempted, `null` = detection failed.
 *
 * Module-scoped memoization of a one-time DOM scan; the resolved value is stable
 * for a given page, so hoisting it out of the component is behavior-preserving.
 */
let viteProjectRootCache: string | null | undefined = undefined;

/**
 * Test-only reset of the Vite project-root cache. Not used in production code.
 */
export function _resetViteProjectRootCache(): void {
	viteProjectRootCache = undefined;
}

/**
 * Detect project root from Vite dev server's `/@fs/` script URLs.
 *
 * Vite serves files from node_modules via `/@fs/<absolute-path>/node_modules/...`
 * which reveals the project's absolute filesystem path.
 *
 * @returns The detected absolute project root, or `null` if undetectable.
 */
export function detectViteProjectRoot(): string | null {
	// The svelte-grab/vite plugin knows the real root: no guessing needed.
	const pluginRoot = getVitePluginInfo()?.root;
	if (pluginRoot) return pluginRoot;

	if (viteProjectRootCache !== undefined) return viteProjectRootCache;

	try {
		const scripts = document.querySelectorAll('script[src]');
		for (const script of scripts) {
			const src = script.getAttribute('src') || '';
			// Match /@fs/<absolute-path>/node_modules/ (most reliable)
			const fsNodeModules = src.match(/\/@fs\/(.*?)\/node_modules\//);
			if (fsNodeModules) {
				viteProjectRootCache = '/' + fsNodeModules[1];
				return viteProjectRootCache;
			}
			// Match /@fs/<absolute-path>/src/ as fallback
			const fsSrc = src.match(/\/@fs\/(.*?)\/src\//);
			if (fsSrc) {
				viteProjectRootCache = '/' + fsSrc[1];
				return viteProjectRootCache;
			}
		}
	} catch {
		// DOM access may fail in unusual environments
	}

	viteProjectRootCache = null;
	return null;
}

/**
 * Try to detect project root from a file path.
 * Handles both absolute paths and relative paths from Vite/SvelteKit.
 *
 * @param filePath - The (possibly relative) source file path from `__svelte_meta`.
 * @returns The detected absolute project root, or `null` if undetectable.
 */
export function detectProjectRoot(filePath: string): string | null {
	// Relative paths (e.g., "src/lib/components/Foo.svelte") — common in Vite dev
	if (!filePath.startsWith('/')) {
		return detectViteProjectRoot();
	}

	if (filePath.startsWith('/.')) {
		return null;
	}

	// Paths like "/src/routes/..." are Vite dev-relative
	if (filePath.startsWith('/src/') || filePath.startsWith('/lib/')) {
		return detectViteProjectRoot();
	}

	// SvelteKit convention: /src/routes/ pattern
	const routesIndex = filePath.indexOf('/src/routes/');
	if (routesIndex > 0) {
		return filePath.slice(0, routesIndex);
	}

	const srcIndex = filePath.indexOf('/src/');
	if (srcIndex > 0) {
		return filePath.slice(0, srcIndex);
	}

	const libIndex = filePath.indexOf('/lib/');
	if (libIndex > 0) {
		return filePath.slice(0, libIndex);
	}

	return null;
}

/**
 * Build an editor deep-link URL for opening `file` at `line`.
 *
 * @param file - The source file path (absolute system path or project-relative).
 * @param line - The 1-based line number to jump to.
 * @param editor - The configured editor id.
 * @param root - The resolved project root (from the `projectRoot` prop or
 *   auto-detection); used to absolutize project-relative paths.
 * @returns The deep-link URL string, or `null` if `editor` is `'none'`.
 */
export function buildEditorUrl(
	file: string,
	line: number,
	editor: EditorId,
	root: string | null
): string | null {
	if (editor === 'none') return null;

	let absolutePath: string;

	const isAbsoluteSystemPath = file.startsWith('/') &&
		!file.startsWith('/.') &&
		(file.startsWith('/Users/') || file.startsWith('/home/') || file.match(/^\/[a-zA-Z]\//));

	if (isAbsoluteSystemPath) {
		absolutePath = file;
	} else if (root) {
		const relativePath = file.startsWith('/') ? file : `/${file}`;
		absolutePath = root.endsWith('/')
			? root.slice(0, -1) + relativePath
			: root + relativePath;
	} else {
		console.warn(
			`[SvelteGrab] Could not auto-detect project root for relative path "${file}". ` +
			`Set the "projectRoot" prop to your project's absolute path. ` +
			`Example: <SvelteGrab projectRoot="/Users/you/my-project" />`
		);
		absolutePath = file.startsWith('/') ? file : `/${file}`;
	}

	switch (editor) {
		case 'vscode':
			return `vscode://file${absolutePath}:${line}`;
		case 'cursor':
			return `cursor://file${absolutePath}:${line}`;
		case 'webstorm':
			return `webstorm://open?file=${absolutePath}&line=${line}`;
		case 'zed':
			return `zed://file${absolutePath}:${line}`;
		case 'sublime':
			return `subl://open?url=file://${absolutePath}&line=${line}`;
		case 'idea':
			return `idea://open?file=${absolutePath}&line=${line}`;
		case 'phpstorm':
			return `phpstorm://open?file=${absolutePath}&line=${line}`;
		case 'pycharm':
			return `pycharm://open?file=${absolutePath}&line=${line}`;
		default:
			return null;
	}
}

/**
 * Absolute path of `file` for Vite's launch-editor. Root-relative paths
 * (`src/App.svelte`, `/src/App.svelte`) are joined to `root`; anything else
 * starting with `/` (or a drive letter) is taken as already absolute.
 */
export function resolveFileForVite(file: string, root: string | null): string {
	const f = file.replace(/\\/g, '/');
	const r = root ? root.replace(/\\/g, '/').replace(/\/+$/, '') : null;
	if (/^[a-zA-Z]:\//.test(f)) return f;
	if (f.startsWith('/')) {
		if (r && f.startsWith(`${r}/`)) return f;
		const devRelative = f.startsWith('/src/') || f.startsWith('/lib/');
		return devRelative && r ? r + f : f;
	}
	return r ? `${r}/${f.replace(/^\.\//, '')}` : f;
}

/**
 * URL of Vite's launch-editor middleware for `file:line:column`, or `null`
 * when the `svelte-grab/vite` plugin is not installed.
 */
export function buildViteOpenInEditorUrl(
	file: string,
	line: number,
	column = 1,
	root: string | null = null
): string | null {
	const plugin = getVitePluginInfo();
	if (!plugin) return null;
	const absolute = resolveFileForVite(file, root || plugin.root);
	return `${OPEN_IN_EDITOR_PATH}?file=${encodeURIComponent(`${absolute}:${line}:${column}`)}`;
}

/** Follow a deep link with a temporary anchor (custom schemes do not navigate away). */
function followDeepLink(url: string): void {
	const a = document.createElement('a');
	a.href = url;
	a.click();
}

export interface OpenInEditorDeps {
	fetch?: (url: string) => Promise<{ ok: boolean }>;
	openUrl?: (url: string) => void;
}

/**
 * Open `file:line` in the editor. With the `svelte-grab/vite` plugin, asks the
 * dev server (`/__open-in-editor`, Vite's launch-editor) and falls back to the
 * deep link if that request fails; without the plugin, uses the deep link.
 * Does nothing when `editor` is `'none'`.
 */
export function openInEditor(
	file: string,
	line: number,
	editor: EditorId,
	root: string | null,
	deps: OpenInEditorDeps = {}
): void {
	if (editor === 'none') return;
	const openUrl = deps.openUrl ?? followDeepLink;
	const fallback = () => {
		const url = buildEditorUrl(file, line, editor, root || getVitePluginInfo()?.root || null);
		if (url) openUrl(url);
	};

	const viteUrl = buildViteOpenInEditorUrl(file, line, 1, root);
	const doFetch = deps.fetch ?? (typeof fetch === 'function' ? (u: string) => fetch(u) : undefined);
	if (!viteUrl || !doFetch) {
		fallback();
		return;
	}
	doFetch(viteUrl).then(
		(res) => {
			if (!res.ok) fallback();
		},
		() => fallback()
	);
}
