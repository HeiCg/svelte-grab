// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
	findSvelteParent,
	findSvelteChild,
	findSvelteSibling
} from '../src/lib/core/dom-navigation.js';

type WithMeta = HTMLElement & { __svelte_meta?: { loc?: unknown } };

/** Tag an element with fake __svelte_meta so the navigation helpers find it. */
function tag(el: HTMLElement, file = 'src/App.svelte', line = 1): HTMLElement {
	(el as WithMeta).__svelte_meta = { loc: { file, line, char: 0 } };
	return el;
}

describe('dom-navigation', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	describe('findSvelteParent', () => {
		it('finds the nearest ancestor with svelte meta, skipping plain ones', () => {
			const grandparent = tag(document.createElement('div'));
			const parent = document.createElement('div'); // no meta
			const child = document.createElement('span');
			grandparent.appendChild(parent);
			parent.appendChild(child);
			document.body.appendChild(grandparent);

			expect(findSvelteParent(child)).toBe(grandparent);
		});

		it('does not return the element itself', () => {
			const self = tag(document.createElement('div'));
			document.body.appendChild(self);
			// self has meta but findSvelteParent starts from parentElement.
			expect(findSvelteParent(self)).toBe(null);
		});

		it('returns null when no ancestor has meta', () => {
			const parent = document.createElement('div');
			const child = document.createElement('span');
			parent.appendChild(child);
			document.body.appendChild(parent);
			expect(findSvelteParent(child)).toBe(null);
		});
	});

	describe('findSvelteChild', () => {
		it('finds the first descendant with svelte meta (depth-first)', () => {
			const root = document.createElement('div');
			const plainMid = document.createElement('div');
			const tagged = tag(document.createElement('span'));
			plainMid.appendChild(tagged);
			root.appendChild(plainMid);
			document.body.appendChild(root);

			expect(findSvelteChild(root)).toBe(tagged);
		});

		it('skips the root itself even if it has meta', () => {
			const root = tag(document.createElement('div'));
			const child = tag(document.createElement('span'), 'src/Child.svelte', 5);
			root.appendChild(child);
			document.body.appendChild(root);

			expect(findSvelteChild(root)).toBe(child);
		});

		it('returns null when no descendant has meta', () => {
			const root = document.createElement('div');
			root.appendChild(document.createElement('span'));
			document.body.appendChild(root);
			expect(findSvelteChild(root)).toBe(null);
		});
	});

	describe('findSvelteSibling', () => {
		it('finds the next sibling with meta', () => {
			const parent = document.createElement('div');
			const a = document.createElement('div');
			const b = document.createElement('div'); // plain
			const c = tag(document.createElement('div'));
			parent.append(a, b, c);
			document.body.appendChild(parent);

			expect(findSvelteSibling(a, 'next')).toBe(c);
		});

		it('finds the previous sibling with meta', () => {
			const parent = document.createElement('div');
			const a = tag(document.createElement('div'));
			const b = document.createElement('div'); // plain
			const c = document.createElement('div');
			parent.append(a, b, c);
			document.body.appendChild(parent);

			expect(findSvelteSibling(c, 'prev')).toBe(a);
		});

		it('returns null when there is no matching sibling', () => {
			const parent = document.createElement('div');
			const a = document.createElement('div');
			const b = document.createElement('div');
			parent.append(a, b);
			document.body.appendChild(parent);

			expect(findSvelteSibling(a, 'next')).toBe(null);
		});

		it('returns null when the element has no parent', () => {
			const orphan = document.createElement('div');
			expect(findSvelteSibling(orphan, 'next')).toBe(null);
		});
	});
});
