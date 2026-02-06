import type { SvelteMeta } from '../types.js';

type SvelteElement = HTMLElement & { __svelte_meta?: SvelteMeta };

/**
 * Check if an element has Svelte dev metadata with a location.
 */
function hasSvelteMeta(el: HTMLElement): el is SvelteElement {
	return !!(el as SvelteElement).__svelte_meta?.loc;
}

/**
 * Find the nearest parent element with __svelte_meta.loc.
 * Starts from el.parentElement (does not include el itself).
 */
export function findSvelteParent(el: HTMLElement): HTMLElement | null {
	let current = el.parentElement;
	while (current) {
		if (hasSvelteMeta(current)) return current;
		current = current.parentElement;
	}
	return null;
}

/**
 * Find the first child element (depth-first) with __svelte_meta.loc.
 */
export function findSvelteChild(el: HTMLElement): HTMLElement | null {
	const walker = document.createTreeWalker(
		el,
		NodeFilter.SHOW_ELEMENT,
		{
			acceptNode(node) {
				// Skip the root element itself
				if (node === el) return NodeFilter.FILTER_SKIP;
				if (hasSvelteMeta(node as HTMLElement)) return NodeFilter.FILTER_ACCEPT;
				return NodeFilter.FILTER_SKIP;
			}
		}
	);

	const result = walker.nextNode();
	return result as HTMLElement | null;
}

/**
 * Find the next or previous sibling element with __svelte_meta.loc.
 * Searches among siblings of el's parent.
 */
export function findSvelteSibling(
	el: HTMLElement,
	direction: 'next' | 'prev'
): HTMLElement | null {
	const parent = el.parentElement;
	if (!parent) return null;

	const children = Array.from(parent.children) as HTMLElement[];
	const currentIdx = children.indexOf(el);
	if (currentIdx === -1) return null;

	if (direction === 'next') {
		for (let i = currentIdx + 1; i < children.length; i++) {
			if (hasSvelteMeta(children[i])) return children[i];
		}
	} else {
		for (let i = currentIdx - 1; i >= 0; i--) {
			if (hasSvelteMeta(children[i])) return children[i];
		}
	}

	return null;
}
