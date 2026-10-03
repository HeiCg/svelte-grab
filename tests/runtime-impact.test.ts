// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { recommend, uiComponentImpact, type ImportersInfo } from '../src/lib/runtime/impact.js';
import { RefRegistry } from '../src/lib/runtime/refs.js';
import { runtimeTools } from '../src/lib/runtime/commands.js';
import type { VitePluginInfo } from '../src/lib/utils/vite-plugin-info.js';
import { buildFixture, component, h, meta } from './runtime-helpers.js';

let registry: RefRegistry;

const plugin: VitePluginInfo = {
	version: '1.0.0',
	root: '/app',
	hmrBridge: true,
	importersEndpoint: '/__svelte-grab/importers'
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
	document.body.innerHTML = '';
	registry = new RefRegistry();
});

/** buildFixture + a third Button used directly in App.svelte with a variant class. */
function fixtureWithThirdButton() {
	const f = buildFixture();
	const inst = component('Button', '/src/App.svelte', 9);
	const primary = meta(h('button', { class: 'btn primary svelte-zz9' }, 'Go'), '/src/lib/Button.svelte', 2, 1, inst);
	f.main.append(primary);
	for (const b of f.buttons) b.className = 'btn svelte-zz9';
	return { ...f, primary };
}

describe('ui_component_impact', () => {
	it('is registered as a page tool and validates args', async () => {
		expect(Object.keys(runtimeTools)).toContain('ui_component_impact');
		await expect(uiComponentImpact({}, { registry })).rejects.toThrow('ui_component_impact needs "ref"');
		await expect(uiComponentImpact({ ref: 'e404' }, { registry })).rejects.toThrow('Unknown ref "e404"');
		const plain = h('div');
		document.body.append(plain);
		await expect(uiComponentImpact({ ref: registry.refFor(plain) }, { registry, pluginInfo: () => null })).rejects.toThrow(
			'no Svelte component metadata'
		);
	});

	it('lists instances grouped by usage file, variants by root classes, and importers from the plugin', async () => {
		const { buttons } = fixtureWithThirdButton();
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				file: '/src/lib/Button.svelte',
				found: true,
				matches: ['src/lib/Button.svelte'],
				importers: [
					{ file: 'src/App.svelte', url: '/src/App.svelte' },
					{ file: 'src/lib/Card.svelte', url: '/src/lib/Card.svelte' }
				]
			})
		);
		const ref = registry.refFor(buttons[1]);
		const { text, data } = await uiComponentImpact({ ref }, { registry, pluginInfo: () => plugin, fetch: fetchMock });

		expect(fetchMock).toHaveBeenCalledWith(
			'/__svelte-grab/importers?file=%2Fsrc%2Flib%2FButton.svelte',
			expect.anything()
		);
		const lines = text.split('\n');
		expect(lines[0]).toBe('<Button> defined in src/lib/Button.svelte');
		expect(lines[1]).toBe(`${ref} button "b" (this instance is used at src/lib/Card.svelte:7)`);
		expect(text).toContain('INSTANCES on this page: 3');
		expect(text).toMatch(/\n {2}src\/lib\/Card\.svelte \(2\): line 7 x2 -> e\d+, e\d+ \(this\)\n/);
		expect(text).toMatch(/\n {2}src\/App\.svelte \(1\): line 9 -> e\d+\n/);
		expect(text).toContain('VARIANTS (root element classes, svelte-* hashes ignored): 2');
		expect(text).toMatch(/\n {2}btn x2 -> /);
		expect(text).toMatch(/\n {2}btn primary x1 -> /);
		expect(text).toContain('IMPORTERS (Vite module graph): 2\n  src/App.svelte\n  src/lib/Card.svelte');
		expect(lines[lines.length - 1]).toBe(
			'Recommendation: Changing src/lib/Button.svelte affects 3 instances on this page and 2 importing files; ' +
				'prefer a prop/variant or a local class at the usage site src/lib/Card.svelte:7 for a one-off change.'
		);

		expect(data).toMatchObject({
			component: 'Button',
			definitionFile: '/src/lib/Button.svelte',
			usedAt: { file: '/src/lib/Card.svelte', line: 7 },
			instances: { count: 3 },
			variants: [
				{ classes: 'btn', count: 2 },
				{ classes: 'btn primary', count: 1 }
			],
			variantCount: 2,
			importers: { status: 'ok', files: ['src/App.svelte', 'src/lib/Card.svelte'], truncated: false }
		});
		const byFile = (data!.instances as { byFile: { file: string; count: number }[] }).byFile;
		expect(byFile.map((f) => [f.file, f.count])).toEqual([
			['/src/lib/Card.svelte', 2],
			['/src/App.svelte', 1]
		]);
	});

	it('works from any element the component renders (child element -> owning component)', async () => {
		const { cards } = buildFixture();
		const p = cards[0].querySelector('p')!;
		const { text, data } = await uiComponentImpact({ ref: registry.refFor(p) }, { registry, pluginInfo: () => null });
		expect(text.split('\n')[0]).toBe('<Card> defined in src/lib/Card.svelte');
		expect(data).toMatchObject({ component: 'Card', instances: { count: 2 } });
		expect(text).toContain('src/App.svelte (2): line 3 -> e');
		expect(text).toContain('line 4 -> e');
	});

	it('without the plugin: importers unknown, still recommends against editing a multi-instance component', async () => {
		const { buttons } = buildFixture();
		const fetchMock = vi.fn();
		const { text, data } = await uiComponentImpact(
			{ ref: registry.refFor(buttons[0]) },
			{ registry, pluginInfo: () => null, fetch: fetchMock }
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(text).toContain('importers: unknown (install svelte-grab/vite)');
		expect(text).toContain(
			'Recommendation: Changing src/lib/Button.svelte affects 2 instances on this page and an unknown number of importing files;'
		);
		expect(data).toMatchObject({ importers: { status: 'unknown', files: [] } });
	});

	it('single usage: editing is safe (with importers known); notes unknown importers otherwise', async () => {
		const inst = component('Hero', '/src/App.svelte', 5);
		const hero = meta(h('section', { class: 'hero' }, 'Hi'), '/src/lib/Hero.svelte', 1, 1, inst);
		document.body.append(hero);
		const ref = registry.refFor(hero);
		const ok = await uiComponentImpact(
			{ ref },
			{
				registry,
				pluginInfo: () => plugin,
				fetch: async () => jsonResponse({ found: true, importers: [{ file: 'src/App.svelte', url: '/src/App.svelte' }] })
			}
		);
		expect(ok.text).toContain('INSTANCES on this page: 1');
		expect(ok.text.split('\n').pop()).toBe('Recommendation: Single usage; editing the component is safe.');

		const unknown = await uiComponentImpact({ ref }, { registry, pluginInfo: () => null });
		expect(unknown.text.split('\n').pop()).toMatch(/^Recommendation: Single usage; editing the component is safe \(importers unknown/);
	});

	it('one instance on this page but several importers -> shared', async () => {
		const inst = component('Hero', '/src/App.svelte', 5);
		const hero = meta(h('section', {}, 'Hi'), '/src/lib/Hero.svelte', 1, 1, inst);
		document.body.append(hero);
		const out = await uiComponentImpact(
			{ ref: registry.refFor(hero) },
			{
				registry,
				pluginInfo: () => plugin,
				fetch: async () =>
					jsonResponse({
						found: true,
						truncated: true,
						importers: [
							{ file: 'src/App.svelte', url: '' },
							{ file: 'src/routes/About.svelte', url: '' }
						]
					})
			}
		);
		expect(out.text.split('\n').pop()).toBe(
			'Recommendation: Changing src/lib/Hero.svelte affects 1 instance on this page and 2+ importing files; ' +
				'prefer a prop/variant or a local class at the usage site src/App.svelte:5 for a one-off change.'
		);
		expect(out.text).toContain('IMPORTERS (Vite module graph): 2+ (truncated)');
	});

	it('reports not-found and fetch errors without failing the tool', async () => {
		const { buttons } = buildFixture();
		const ref = registry.refFor(buttons[0]);
		const notFound = await uiComponentImpact(
			{ ref },
			{ registry, pluginInfo: () => plugin, fetch: async () => jsonResponse({ found: false, importers: [] }) }
		);
		expect(notFound.text).toContain('importers: src/lib/Button.svelte is not in the Vite module graph');

		const http = await uiComponentImpact(
			{ ref },
			{ registry, pluginInfo: () => plugin, fetch: async () => jsonResponse({ error: 'x' }, 403) }
		);
		expect(http.text).toContain('importers: unavailable (HTTP 403)');

		const thrown = await uiComponentImpact(
			{ ref },
			{
				registry,
				pluginInfo: () => plugin,
				fetch: async () => {
					throw new Error('network down');
				}
			}
		);
		expect(thrown.text).toContain('importers: unavailable (network down)');
		expect(thrown.data).toMatchObject({ importers: { status: 'error', error: 'network down' } });
	});

	it('recommend() phrasing', () => {
		const ok = (files: string[]): ImportersInfo => ({ status: 'ok', files, truncated: false });
		expect(recommend('a.svelte', 1, ok(['x']), 'x:1')).toBe('Single usage; editing the component is safe.');
		expect(recommend('a.svelte', 2, ok(['x']), null)).toBe(
			'Changing a.svelte affects 2 instances on this page and 1 importing file; prefer a prop/variant or a local class for a one-off change.'
		);
	});
});
