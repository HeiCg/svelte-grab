// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
	getSvelteMeta,
	getSvelteLoc,
	hasSvelteLoc,
	findMetaElement,
	walkDevStack,
	extractComponentName,
	getComponentStack
} from '../src/lib/utils/component-stack.js';
import type { DevStackEntry, SvelteMeta } from '../src/lib/types.js';

type WithMeta = HTMLElement & { __svelte_meta?: SvelteMeta };

function entry(
	type: string,
	file: string,
	line: number,
	parent: DevStackEntry | null,
	componentTag?: string
): DevStackEntry {
	const e: DevStackEntry = { type, file, line, column: 2, parent };
	if (componentTag) e.componentTag = componentTag;
	return e;
}

function attach(
	el: HTMLElement,
	file: string,
	line: number,
	parent: DevStackEntry | null
): HTMLElement {
	(el as WithMeta).__svelte_meta = { loc: { file, line, column: 4 }, parent };
	return el;
}

/**
 * Fake tree, mirroring what Svelte >= 5.35.1 produces for:
 *
 *   App.svelte:       line 10  <Layout> ... </Layout>
 *   Layout.svelte:    line 3   {#if open}
 *                     line 4     <Card />
 *   Card.svelte:      line 7   {#each items as item}
 *                     line 8     <button>   <- the grabbed element
 *
 * The parent chain of the button's meta (nearest first):
 *   each (Card.svelte:7) -> component Card (Layout.svelte:4)
 *   -> if (Layout.svelte:3) -> component Layout (App.svelte:10) -> null
 */
function buildChain(): DevStackEntry {
	const layout = entry('component', '/src/App.svelte', 10, null, 'Layout');
	const ifBlock = entry('if', '/src/lib/Layout.svelte', 3, layout);
	const card = entry('component', '/src/lib/Layout.svelte', 4, ifBlock, 'Card');
	return entry('each', '/src/lib/Card.svelte', 7, card);
}

describe('extractComponentName', () => {
	it('derives the name from a .svelte file path', () => {
		expect(extractComponentName('/src/lib/MyButton.svelte')).toBe('MyButton');
	});

	it('returns null for non-svelte files', () => {
		expect(extractComponentName('/src/lib/util.ts')).toBe(null);
	});
});

describe('getSvelteMeta / getSvelteLoc / hasSvelteLoc', () => {
	it('returns null for elements without meta', () => {
		const el = document.createElement('div');
		expect(getSvelteMeta(el)).toBe(null);
		expect(getSvelteLoc(el)).toBe(null);
		expect(hasSvelteLoc(el)).toBe(false);
	});

	it('returns null for null/undefined input', () => {
		expect(getSvelteMeta(null)).toBe(null);
		expect(getSvelteMeta(undefined)).toBe(null);
		expect(hasSvelteLoc(null)).toBe(false);
	});

	it('reads meta and loc when present', () => {
		const el = attach(document.createElement('div'), '/src/lib/Card.svelte', 8, null);
		expect(getSvelteMeta(el)?.parent).toBe(null);
		expect(getSvelteLoc(el)).toEqual({ file: '/src/lib/Card.svelte', line: 8, column: 4 });
		expect(hasSvelteLoc(el)).toBe(true);
	});

	it('ignores malformed meta objects', () => {
		const el = document.createElement('div');
		(el as unknown as { __svelte_meta: unknown }).__svelte_meta = 'nope';
		expect(getSvelteMeta(el)).toBe(null);

		const el2 = document.createElement('div');
		(el2 as unknown as { __svelte_meta: unknown }).__svelte_meta = { parent: null };
		expect(getSvelteMeta(el2)).not.toBe(null);
		expect(getSvelteLoc(el2)).toBe(null);
		expect(hasSvelteLoc(el2)).toBe(false);
	});
});

describe('findMetaElement', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	it('returns the element itself when it has meta.loc', () => {
		const el = attach(document.createElement('button'), '/src/lib/Card.svelte', 8, null);
		document.body.appendChild(el);
		expect(findMetaElement(el)).toBe(el);
	});

	it('walks up to the nearest ancestor with meta.loc', () => {
		const outer = attach(document.createElement('section'), '/src/lib/Card.svelte', 5, null);
		const plain = document.createElement('span');
		const leaf = document.createElement('i');
		outer.appendChild(plain);
		plain.appendChild(leaf);
		document.body.appendChild(outer);
		expect(findMetaElement(leaf)).toBe(outer);
	});

	it('returns null when no ancestor has meta', () => {
		const el = document.createElement('div');
		document.body.appendChild(el);
		expect(findMetaElement(el)).toBe(null);
		expect(findMetaElement(null)).toBe(null);
	});

	it('requireLoc: false accepts meta without loc', () => {
		const el = document.createElement('div');
		(el as unknown as { __svelte_meta: unknown }).__svelte_meta = { parent: null };
		document.body.appendChild(el);
		expect(findMetaElement(el)).toBe(null);
		expect(findMetaElement(el, { requireLoc: false })).toBe(el);
	});
});

describe('walkDevStack', () => {
	it('returns [] for missing meta or null-parent root', () => {
		expect(walkDevStack(null)).toEqual([]);
		expect(walkDevStack(undefined)).toEqual([]);
		expect(
			walkDevStack({ loc: { file: '/src/App.svelte', line: 1, column: 0 }, parent: null })
		).toEqual([]);
	});

	it('tags component vs block entries, nearest first', () => {
		const meta: SvelteMeta = {
			loc: { file: '/src/lib/Card.svelte', line: 8, column: 4 },
			parent: buildChain()
		};
		const items = walkDevStack(meta);

		expect(items.map((i) => [i.kind, i.type])).toEqual([
			['block', 'each'],
			['component', 'component'],
			['block', 'if'],
			['component', 'component']
		]);
	});

	it('names components from componentTag, not from the usage-site file', () => {
		const meta: SvelteMeta = {
			loc: { file: '/src/lib/Card.svelte', line: 8, column: 4 },
			parent: buildChain()
		};
		const components = walkDevStack(meta).filter((i) => i.kind === 'component');

		expect(components.map((c) => c.componentName)).toEqual(['Card', 'Layout']);
		// file/line is where <Card /> is written (the parent file)
		expect(components[0].usageSite).toEqual({ file: '/src/lib/Layout.svelte', line: 4, column: 2 });
		expect(components[1].usageSite).toEqual({ file: '/src/App.svelte', line: 10, column: 2 });
	});

	it('names blocks after the component file they live in', () => {
		const meta: SvelteMeta = {
			loc: { file: '/src/lib/Card.svelte', line: 8, column: 4 },
			parent: buildChain()
		};
		const blocks = walkDevStack(meta).filter((i) => i.kind === 'block');
		expect(blocks.map((b) => b.componentName)).toEqual(['Card', 'Layout']);
	});

	it('falls back to the file name when componentTag is missing', () => {
		const meta: SvelteMeta = {
			loc: { file: '/src/lib/Card.svelte', line: 1, column: 0 },
			parent: entry('component', '/src/routes/Page.svelte', 12, null)
		};
		expect(walkDevStack(meta)[0].componentName).toBe('Page');
	});

	it('skips entries without file/line and stops on cycles', () => {
		const a = entry('component', '/src/A.svelte', 1, null, 'B');
		const bad = { type: 'if', file: '', line: 0, column: 0, parent: a } as DevStackEntry;
		a.parent = bad; // cycle: a -> bad -> a
		const meta: SvelteMeta = { loc: { file: '/src/B.svelte', line: 1, column: 0 }, parent: a };
		const items = walkDevStack(meta);
		expect(items).toHaveLength(1);
		expect(items[0].componentName).toBe('B');
	});
});

describe('getComponentStack', () => {
	const notExcluded = () => false;

	beforeEach(() => {
		document.body.innerHTML = '';
	});

	it('returns [] for elements without meta anywhere up the tree', () => {
		const el = document.createElement('div');
		document.body.appendChild(el);
		expect(getComponentStack(el, notExcluded)).toEqual([]);
	});

	it('builds element + parent-chain entries with correct component names', () => {
		const button = attach(
			document.createElement('button'),
			'/src/lib/Card.svelte',
			8,
			buildChain()
		);
		document.body.appendChild(button);

		const stack = getComponentStack(button, notExcluded);
		expect(stack.map((s) => [s.type, s.file, s.line, s.componentName])).toEqual([
			['element', '/src/lib/Card.svelte', 8, 'Card'],
			['each', '/src/lib/Card.svelte', 7, 'Card'],
			['component', '/src/lib/Layout.svelte', 4, 'Card'],
			['if', '/src/lib/Layout.svelte', 3, 'Layout'],
			['component', '/src/App.svelte', 10, 'Layout']
		]);
	});

	it('starts from the nearest ancestor with meta', () => {
		const button = attach(document.createElement('button'), '/src/lib/Card.svelte', 8, null);
		const icon = document.createElement('svg-icon');
		button.appendChild(icon);
		document.body.appendChild(button);
		expect(getComponentStack(icon, notExcluded)).toHaveLength(1);
	});

	it('filters excluded paths and reports accepted files once each', () => {
		const chain = entry(
			'component',
			'/node_modules/lib/Wrap.svelte',
			2,
			entry('component', '/src/App.svelte', 3, null, 'Wrap'),
			'Inner'
		);
		const el = attach(document.createElement('div'), '/src/lib/Inner.svelte', 1, chain);
		document.body.appendChild(el);

		const files: string[] = [];
		const stack = getComponentStack(
			el,
			(f) => f.includes('node_modules/'),
			(f) => files.push(f)
		);
		expect(stack.map((s) => s.file)).toEqual(['/src/lib/Inner.svelte', '/src/App.svelte']);
		expect(files).toEqual(['/src/lib/Inner.svelte', '/src/App.svelte']);
	});

	it('de-duplicates by file:line', () => {
		const chain = entry('component', '/src/lib/Card.svelte', 8, null, 'Other');
		const el = attach(document.createElement('div'), '/src/lib/Card.svelte', 8, chain);
		document.body.appendChild(el);
		expect(getComponentStack(el, notExcluded)).toHaveLength(1);
	});
});
