/**
 * Pure editor-deep-link and project-root detection helpers for SvelteGrab.
 *
 * Extracted from SvelteGrab.svelte. These functions build `editor://` deep links
 * for the 8 supported editors and detect the project's absolute filesystem root
 * from Vite dev-server URLs / Svelte file paths. None of them close over
 * component `$state` — the editor and project root are passed in explicitly.
 */

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
