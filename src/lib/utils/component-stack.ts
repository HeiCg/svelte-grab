/**
 * The single place that reads Svelte's dev metadata (`__svelte_meta`).
 *
 * Svelte (>= 5.35.1) attaches to every element in dev builds:
 *
 *   element.__svelte_meta = { loc: { file, line, column }, parent: DevStackEntry | null }
 *
 * where `parent` is the dev stack, nearest first. A `type: 'component'` entry
 * carries the USAGE SITE (`file/line/column` of `<Child />` in the parent file)
 * and `componentTag` (the child's tag name). Other entry types
 * (`if/each/await/key/render`) are template blocks, not components.
 *
 * Every tool goes through the helpers below instead of touching
 * `__svelte_meta` directly. They are pure (no component state) so the
 * walking / naming / dedup logic can be unit tested in isolation.
 */
import type {
	SvelteMeta,
	SvelteSourceLocation,
	DevStackEntry,
	DevStackEntryType,
	StackEntry
} from '../types.js';

/** Element that may carry Svelte dev metadata. */
export type SvelteMetaElement = HTMLElement & { __svelte_meta?: SvelteMeta };

/** Hard cap on dev stack length, guards against malformed / cyclic chains. */
const MAX_STACK_DEPTH = 1000;

/**
 * Extract a component name from a `.svelte` file path (`/a/Card.svelte` -> `Card`).
 * Returns `null` for non-svelte files.
 */
export function extractComponentName(filePath: string): string | null {
	const match = filePath.match(/\/([^/]+)\.svelte$/);
	return match ? match[1] : null;
}

/**
 * Read `__svelte_meta` from an element. Returns `null` when absent or not an object.
 */
export function getSvelteMeta(el: Element | null | undefined): SvelteMeta | null {
	if (!el) return null;
	const meta = (el as SvelteMetaElement).__svelte_meta;
	return meta && typeof meta === 'object' ? meta : null;
}

/**
 * Read the element's own source location (`__svelte_meta.loc`), or `null`.
 */
export function getSvelteLoc(el: Element | null | undefined): SvelteSourceLocation | null {
	const loc = getSvelteMeta(el)?.loc;
	return loc && typeof loc.file === 'string' ? loc : null;
}

/**
 * Whether the element carries a usable `__svelte_meta.loc`.
 */
export function hasSvelteLoc(el: Element | null | undefined): boolean {
	return getSvelteLoc(el) !== null;
}

export interface FindMetaElementOptions {
	/** Require `meta.loc` (default `true`). With `false`, any meta object matches. */
	requireLoc?: boolean;
}

/**
 * Find the nearest element (itself first, then ancestors) carrying Svelte meta.
 */
export function findMetaElement(
	el: Element | null | undefined,
	options: FindMetaElementOptions = {}
): HTMLElement | null {
	const { requireLoc = true } = options;
	let current: Element | null = el ?? null;
	while (current) {
		if (requireLoc ? hasSvelteLoc(current) : getSvelteMeta(current) !== null) {
			return current as HTMLElement;
		}
		current = current.parentElement;
	}
	return null;
}

/** One dev stack entry, classified. */
export interface DevStackItem {
	/** `'component'` for a component boundary, `'block'` for if/each/await/key/render/... */
	kind: 'component' | 'block';
	/** Raw dev stack type. */
	type: DevStackEntryType;
	/**
	 * For components: `componentTag` when present, else derived from the file
	 * name. For blocks: the component whose file contains the block.
	 */
	componentName: string | null;
	/** `file/line/column` of the entry (for components: where `<Child />` is written). */
	usageSite: SvelteSourceLocation;
	/** The raw entry. */
	entry: DevStackEntry;
}

/**
 * Walk the `meta.parent` dev stack, nearest first. Entries without a file or
 * a positive line are skipped; cycles are cut.
 */
export function walkDevStack(meta: SvelteMeta | null | undefined): DevStackItem[] {
	const items: DevStackItem[] = [];
	const visited = new Set<DevStackEntry>();
	let entry: DevStackEntry | null | undefined = meta?.parent;

	while (entry && !visited.has(entry) && visited.size < MAX_STACK_DEPTH) {
		visited.add(entry);
		const { file, line } = entry;
		if (typeof file === 'string' && file && typeof line === 'number' && line > 0) {
			const isComponent = entry.type === 'component';
			items.push({
				kind: isComponent ? 'component' : 'block',
				type: entry.type,
				componentName: (isComponent && entry.componentTag) || extractComponentName(file),
				usageSite: { file, line, column: entry.column || 0 },
				entry
			});
		}
		entry = entry.parent;
	}

	return items;
}

/**
 * Build the de-duplicated component stack for `element`.
 *
 * Walks up to the nearest element with meta, emits its own `loc` as an
 * `'element'` entry, then every dev stack entry (type kept as-is, so blocks
 * stay distinguishable). Dedup key is `file:line`.
 *
 * @param element - The DOM element to walk up from.
 * @param isExcludedPath - Predicate returning `true` for framework-internal /
 *   excluded file paths that should be filtered out of the stack.
 * @param onEntryFile - Optional callback invoked once per accepted (non-excluded,
 *   not-yet-seen) entry with its file path. SvelteGrab uses this to lazily detect
 *   the project root from the first real source file it encounters.
 * @returns The de-duplicated stack of source locations, nearest-first.
 */
export function getComponentStack(
	element: HTMLElement,
	isExcludedPath: (file: string) => boolean,
	onEntryFile?: (file: string) => void
): StackEntry[] {
	const entries: StackEntry[] = [];
	const seen = new Set<string>();

	const push = (entry: StackEntry) => {
		if (isExcludedPath(entry.file)) return;
		const key = `${entry.file}:${entry.line}`;
		if (seen.has(key)) return;
		seen.add(key);
		entries.push(entry);
		onEntryFile?.(entry.file);
	};

	const metaEl = findMetaElement(element, { requireLoc: false });
	if (!metaEl) return entries;

	const loc = getSvelteLoc(metaEl);
	if (loc) {
		const name = extractComponentName(loc.file);
		push({
			type: 'element',
			file: loc.file,
			line: loc.line,
			column: loc.column,
			...(name ? { componentName: name } : {})
		});
	}

	for (const item of walkDevStack(getSvelteMeta(metaEl))) {
		push({
			type: item.type || 'component',
			file: item.usageSite.file,
			line: item.usageSite.line,
			column: item.usageSite.column,
			...(item.componentName ? { componentName: item.componentName } : {})
		});
	}

	return entries;
}
