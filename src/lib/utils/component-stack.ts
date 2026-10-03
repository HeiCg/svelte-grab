/**
 * Pure component-stack walking for SvelteGrab.
 *
 * Walks the DOM up from an element to its nearest `__svelte_meta`, then follows
 * the `__svelte_meta.parent` chain, collecting source locations into a
 * de-duplicated `StackEntry[]`. Extracted verbatim from SvelteGrab.svelte so the
 * stack-walking / dedup / path-filter logic can be unit tested in isolation.
 *
 * The function is pure: it takes the predicate used to filter framework-internal
 * paths and an optional per-file callback (used by the component to lazily detect
 * the project root) as explicit arguments instead of closing over component
 * `$state`.
 */
import type { SvelteMeta, StackEntry } from '../types.js';

/**
 * Build the de-duplicated component stack for `element`.
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
	let current: HTMLElement | null = element;

	while (current) {
		const meta = (current as HTMLElement & { __svelte_meta?: SvelteMeta }).__svelte_meta;

		if (meta) {
			if (meta.loc && !isExcludedPath(meta.loc.file)) {
				const key = `${meta.loc.file}:${meta.loc.line}`;
				if (!seen.has(key)) {
					seen.add(key);
					entries.push({
						type: 'element',
						file: meta.loc.file,
						line: meta.loc.line,
						column: meta.loc.column
					});

					onEntryFile?.(meta.loc.file);
				}
			}

			let parentEntry = meta.parent;
			while (parentEntry) {
				if (parentEntry.file && parentEntry.line && !isExcludedPath(parentEntry.file)) {
					const key = `${parentEntry.file}:${parentEntry.line}`;
					if (!seen.has(key)) {
						seen.add(key);
						entries.push({
							type: parentEntry.type || 'component',
							file: parentEntry.file,
							line: parentEntry.line,
							column: parentEntry.column || 0
						});

						onEntryFile?.(parentEntry.file);
					}
				}
				parentEntry = parentEntry.parent;
			}
			break;
		}

		current = current.parentElement;
	}

	return entries;
}
