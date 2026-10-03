// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { uiFind, type FindMatch } from '../src/lib/runtime/find.js';
import { RefRegistry, REF_ATTR } from '../src/lib/runtime/refs.js';
import { dispatchRuntimeCommand } from '../src/lib/runtime/commands.js';
import { buildFixture, h, setBox } from './runtime-helpers.js';

let registry: RefRegistry;

beforeEach(() => {
	document.body.innerHTML = '';
	registry = new RefRegistry();
});

function matches(result: { data?: Record<string, unknown> }): FindMatch[] {
	return (result.data as { matches: FindMatch[] }).matches;
}

describe('ui_find', () => {
	it('component: one result per instance, with refs stamped', () => {
		const { cards } = buildFixture();
		const res = uiFind({ component: 'Card' }, registry);
		const found = matches(res);
		expect(found.map((m) => m.ref)).toEqual(['e1', 'e2']);
		expect(found[0]).toMatchObject({
			component: 'Card',
			source: '/src/lib/Card.svelte:5',
			stableKey: 'ui:///src/lib/Card.svelte:5:1#Card[role=,name=][0]',
			visible: false
		});
		expect(cards[0].getAttribute(REF_ATTR)).toBe('e1');
		expect(cards[1].getAttribute(REF_ATTR)).toBe('e2');
		expect(res.text.split('\n')[0]).toBe('2 matches. Locator: [data-sg-ref="<ref>"]');
		expect(res.data?.total).toBe(2);
	});

	it('component matching is case-insensitive and covers the root component', () => {
		buildFixture();
		expect(matches(uiFind({ component: 'button' }, registry))).toHaveLength(2);
		const app = matches(uiFind({ component: 'App' }, registry));
		expect(app.map((m) => m.source)).toEqual(['/src/App.svelte:1']);
	});

	it('text: case-insensitive substring, innermost matches only', () => {
		const { buttons } = buildFixture();
		const found = matches(uiFind({ text: 'CARD B' }, registry));
		expect(found).toHaveLength(1);
		expect(found[0].source).toBe('/src/lib/Card.svelte:6');
		expect(buttons[1].hasAttribute(REF_ATTR)).toBe(false);
	});

	it('role + name AND-combined', () => {
		buildFixture();
		const found = matches(uiFind({ role: 'button', name: 'B' }, registry));
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ role: 'button', name: 'b', component: 'Button' });
		expect(matches(uiFind({ role: 'button', component: 'Card' }, registry))).toHaveLength(0);
	});

	it('file matches by suffix; selector narrows the candidates', () => {
		buildFixture();
		expect(matches(uiFind({ file: 'Button.svelte' }, registry))).toHaveLength(2);
		expect(matches(uiFind({ file: 'lib/Card.svelte' }, registry))).toHaveLength(4);
		expect(matches(uiFind({ selector: '.card', text: 'card b' }, registry))).toHaveLength(1);
	});

	it('reports box and visibility', () => {
		const { buttons } = buildFixture();
		setBox(buttons[0], 5, 6, 70, 30);
		const [first] = matches(uiFind({ role: 'button', name: 'a' }, registry));
		expect(first.box).toEqual({ x: 5, y: 6, width: 70, height: 30 });
		expect(first.visible).toBe(true);
	});

	it('limit truncates and says so', () => {
		buildFixture();
		const res = uiFind({ file: '.svelte', limit: 2 }, registry);
		expect(matches(res)).toHaveLength(2);
		expect(res.data).toMatchObject({ total: 8, truncated: true });
		expect(res.text.split('\n')[0]).toContain('showing 2');
	});

	it('errors on no criteria and invalid selectors', () => {
		expect(() => uiFind({}, registry)).toThrow(/at least one/);
		expect(() => uiFind({ selector: '::::' }, registry)).toThrow(/Invalid CSS selector/);
	});

	it('skips svelte-grab overlay elements', () => {
		buildFixture();
		const overlay = h('div', { 'data-svelte-grab-ui': '' }, h('button', {}, 'a'));
		document.body.append(overlay);
		expect(matches(uiFind({ role: 'button', name: 'a' }, registry))).toHaveLength(1);
		expect(matches(uiFind({ selector: 'button' }, registry))).toHaveLength(2);
	});
});

describe('dispatchRuntimeCommand', () => {
	it('routes to ui_find / ui_snapshot', async () => {
		buildFixture();
		const out = await dispatchRuntimeCommand('ui_find', { component: 'Card' });
		expect(out.ok).toBe(true);
		const snap = await dispatchRuntimeCommand('ui_snapshot', { scope: 'page' });
		expect(snap.ok && snap.result.text).toContain('Card');
	});

	it('unknown tool and handler errors become ok:false', async () => {
		expect(await dispatchRuntimeCommand('ui_click', {})).toEqual({
			ok: false,
			error: 'Unknown tool'
		});
		expect(await dispatchRuntimeCommand('toString', {})).toEqual({
			ok: false,
			error: 'Unknown tool'
		});
		expect(await dispatchRuntimeCommand('ui_find', {})).toEqual({
			ok: false,
			error: 'ui_find needs at least one of: text, role, name, component, file, selector'
		});
		const boom = await dispatchRuntimeCommand('x', null, {
			x: () => {
				throw new Error('boom');
			}
		});
		expect(boom).toEqual({ ok: false, error: 'boom' });
	});
});
