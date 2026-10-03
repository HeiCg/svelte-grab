// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { uiSnapshot, type SnapshotNode } from '../src/lib/runtime/snapshot.js';
import { RefRegistry, REF_ATTR } from '../src/lib/runtime/refs.js';
import { hideFromThirdParties } from '../src/lib/utils/hide-from-third-parties.js';
import { buildFixture, h, meta, setBox } from './runtime-helpers.js';

let registry: RefRegistry;

beforeEach(() => {
	document.body.innerHTML = '';
	registry = new RefRegistry();
});

function nodes(result: { data?: Record<string, unknown> }): SnapshotNode[] {
	return (result.data as { nodes: SnapshotNode[] }).nodes;
}

describe('ui_snapshot', () => {
	it('lists Svelte elements as indented lines with ref, role/tag, name, component and file:line', () => {
		buildFixture();
		const res = uiSnapshot({ scope: 'page' }, registry);
		expect(res.text.split('\n')).toEqual([
			'e1 main App src/App.svelte:1',
			'  e2 heading "Title" App src/App.svelte:2',
			'  e3 div Card src/lib/Card.svelte:5',
			'    e4 p Card src/lib/Card.svelte:6',
			'    e5 button "a" Button src/lib/Button.svelte:2',
			'  e6 div Card src/lib/Card.svelte:5',
			'    e7 p Card src/lib/Card.svelte:6',
			'    e8 button "b" Button src/lib/Button.svelte:2'
		]);
		const data = nodes(res);
		expect(data).toHaveLength(8);
		expect(data[4]).toMatchObject({
			ref: 'e5',
			stableKey: 'ui:///src/lib/Button.svelte:2:1#Button[role=button,name=a][0]',
			role: 'button',
			name: 'a',
			component: 'Button',
			file: '/src/lib/Button.svelte',
			line: 2
		});
		expect(res.data?.truncated).toBe(false);
		expect(document.querySelector(`[${REF_ATTR}="e5"]`)?.textContent).toBe('a');
	});

	it('keeps elements without meta only when they are worth showing', () => {
		const main = meta(h('main'), '/src/App.svelte', 1, 1, null);
		main.append(
			h('div', {}, h('span', {}, 'plain')), // dropped
			h('a', { href: '/x' }, 'Docs'), // link -> kept
			h('img', { alt: 'Logo' }) // img with alt -> kept
		);
		document.body.append(main);
		const lines = uiSnapshot({ scope: 'page' }, registry).text.split('\n');
		expect(lines).toEqual([
			'e1 main App src/App.svelte:1',
			'  e2 link "Docs" App',
			'  e3 img "Logo" App'
		]);
	});

	it('normal detail adds box and up to 5 classes without svelte hashes', () => {
		const { cards } = buildFixture();
		setBox(cards[0], 10, 20, 300, 40);
		const res = uiSnapshot({ scope: 'page', detail: 'normal' }, registry);
		expect(res.text).toContain('e3 div Card src/lib/Card.svelte:5 box=10,20 300x40 .card');
		expect(nodes(res)[2].box).toEqual({ x: 10, y: 20, width: 300, height: 40 });
	});

	it('truncates with a trailing "more nodes" line', () => {
		buildFixture();
		const res = uiSnapshot({ scope: 'page', maxNodes: 3 }, registry);
		const lines = res.text.split('\n');
		expect(lines).toHaveLength(4);
		expect(lines[3]).toBe('… 5 more nodes (raise maxNodes or narrow scope)');
		expect(res.data?.truncated).toBe(true);
		expect(nodes(res)).toHaveLength(3);
	});

	it('scopes to a ref subtree', () => {
		const { cards } = buildFixture();
		const ref = registry.refFor(cards[1]);
		const lines = uiSnapshot({ scope: ref }, registry).text.split('\n');
		expect(lines).toEqual([
			`${ref} div Card src/lib/Card.svelte:5`,
			'  e2 p Card src/lib/Card.svelte:6',
			'  e3 button "b" Button src/lib/Button.svelte:2'
		]);
	});

	it('viewport scope skips invisible / offscreen elements', () => {
		const { main, h1, cards, buttons } = buildFixture();
		for (const el of [main, h1, cards[0], buttons[0]]) setBox(el, 0, 0, 100, 20);
		setBox(cards[1], 0, 5000, 100, 20); // below the fold
		const lines = uiSnapshot({}, registry).text.split('\n');
		expect(lines.map((l) => l.trim().split(' ').slice(1).join(' '))).toEqual([
			'main App src/App.svelte:1',
			'heading "Title" App src/App.svelte:2',
			'div Card src/lib/Card.svelte:5',
			'button "a" Button src/lib/Button.svelte:2'
		]);
	});

	it("skips svelte-grab's own overlay", () => {
		buildFixture();
		const overlay = h('div', {}, h('button', {}, 'Copy'));
		hideFromThirdParties(overlay);
		document.body.append(overlay);
		expect(uiSnapshot({ scope: 'page' }, registry).text).not.toContain('Copy');
	});

	it('rejects bad args', () => {
		buildFixture();
		expect(() => uiSnapshot({ scope: 'e404' }, registry)).toThrow(/Unknown scope/);
		expect(() => uiSnapshot({ detail: 'max' }, registry)).toThrow(/detail/);
		expect(() => uiSnapshot({ maxNodes: 'lots' }, registry)).toThrow(/maxNodes/);
	});
});
