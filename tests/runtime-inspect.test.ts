// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { MAX_INSPECT_TEXT, uiInspect } from '../src/lib/runtime/inspect.js';
import { RefRegistry, REF_ATTR, refRegistry } from '../src/lib/runtime/refs.js';
import { dispatchRuntimeCommand } from '../src/lib/runtime/commands.js';
import type { InspectableLookup } from '../src/lib/utils/state-capture.js';
import { buildFixture, component, h, meta, setBox } from './runtime-helpers.js';

let registry: RefRegistry;

const noState: InspectableLookup = { getInstances: () => [], getIds: () => [] };

function lookup(entries: Record<string, Record<string, unknown>[]>): InspectableLookup {
	return {
		getInstances: (name) =>
			(entries[name] ?? []).map((values, i) => ({ label: `${name} #${i + 1}`, instance: i + 1, values })),
		getIds: () => Object.keys(entries)
	};
}

function inspect(args: Record<string, unknown>, inspectables: InspectableLookup = noState) {
	return uiInspect(args, { registry, inspectables });
}

/** Section headings in output order. */
function headings(text: string): string[] {
	return text.split('\n').filter((l) => /^[A-Z][A-Z0-9/]+$/.test(l));
}

/** Body lines of one section (without the 2-space indent). */
function section(text: string, title: string): string[] {
	const lines = text.split('\n');
	const start = lines.indexOf(title);
	if (start < 0) return [];
	const body: string[] = [];
	for (const l of lines.slice(start + 1)) {
		if (!l.startsWith('  ')) break;
		body.push(l.slice(2));
	}
	return body;
}

beforeEach(() => {
	document.head.innerHTML = '';
	document.body.innerHTML = '';
	registry = new RefRegistry();
});

describe('ui_inspect', () => {
	it('returns every section for a component element, in a fixed order', () => {
		const { buttons } = buildFixture();
		const ref = registry.refFor(buttons[1]);
		const { text, data } = inspect({ ref });

		expect(headings(text)).toEqual([
			'COMPONENT',
			'SOURCE',
			'STACK',
			'PROPS/ATTRIBUTES',
			'STATE',
			'LAYOUT',
			'STYLES',
			'A11Y',
			'USAGE'
		]);
		const lines = text.split('\n');
		expect(lines[0]).toBe(`${ref} button "b" Button src/lib/Button.svelte:2`);
		expect(lines[1]).toBe(`Locator: [${REF_ATTR}="${ref}"]`);
		expect(lines[2]).toMatch(/^Stable key: ui:\/\/\/src\/lib\/Button\.svelte:2:1#Button\[role=button,name=b\]\[0\]$/);

		expect(section(text, 'COMPONENT')).toEqual([
			'<Button> defined in src/lib/Button.svelte',
			'this instance is used at src/lib/Card.svelte:7:1'
		]);
		expect(section(text, 'SOURCE')).toEqual(['src/lib/Button.svelte:2:1']);

		const stack = section(text, 'STACK').join('\n');
		expect(stack).toContain('Component: <Button>');
		expect(stack).toContain('1. Button (src/lib/Button.svelte:2)');
		expect(stack).toContain('2. Button (src/lib/Card.svelte:7)');
		expect(stack).toContain('3. Card (src/App.svelte:4)');

		const usage = section(text, 'USAGE');
		expect(usage[0]).toBe('2 instances of <Button> on the page:');
		expect(usage[1]).toMatch(/^ {2}e\d+ used at src\/lib\/Card\.svelte:7:1 box=/);
		expect(usage[2]).toMatch(new RegExp(`^ {2}${ref} \\(this\\) used at src/lib/Card\\.svelte:7:1 box=`));

		expect(data).toMatchObject({
			ref,
			locator: `[${REF_ATTR}="${ref}"]`,
			element: { tag: 'button', role: 'button', name: 'b' },
			component: { name: 'Button', instance: 'Button', usedAt: { file: '/src/lib/Card.svelte', line: 7 } },
			source: { file: '/src/lib/Button.svelte', line: 2, column: 1 },
			usage: { component: 'Button', count: 2 },
			truncated: false
		});
		expect((data!.stack as unknown[]).length).toBe(3);
	});

	it('include limits the sections (COMPONENT and SOURCE always stay)', () => {
		const { buttons } = buildFixture();
		const { text, data } = inspect({ ref: registry.refFor(buttons[0]), include: ['usage', 'layout'] });
		expect(headings(text)).toEqual(['COMPONENT', 'SOURCE', 'LAYOUT', 'USAGE']);
		expect(data).not.toHaveProperty('styles');
		expect(data).toHaveProperty('layout');
	});

	it('accepts a ui:// stable key and reports a rebound ref at the top', () => {
		const { cards, buttons } = buildFixture();
		const ref = registry.refFor(buttons[0]);
		const key = registry.stableKeyOf(ref)!;
		expect(inspect({ ref: key, include: [] }).text.split('\n')[0]).toMatch(new RegExp(`^${ref} button`));

		// Re-render: the button is replaced by an equivalent element.
		const old = buttons[0];
		const fresh = meta(h('button', {}, 'a'), '/src/lib/Button.svelte', 2, 1, (old as any).__svelte_meta.parent);
		old.replaceWith(fresh);
		expect(cards[0].contains(fresh)).toBe(true);

		const { text, data } = inspect({ ref, include: [] });
		const [note, head] = text.split('\n');
		expect(note).toMatch(new RegExp(`^# ${ref} was stale; rebound to e\\d+$`));
		expect(head).toMatch(/^e\d+ button "a" Button/);
		expect(data).toMatchObject({ rebound: true, previous: ref });
		expect(data!.ref).not.toBe(ref);
		expect(fresh.getAttribute(REF_ATTR)).toBe(data!.ref);
	});

	it('rejects a missing/unknown ref and bad include values', () => {
		buildFixture();
		expect(() => inspect({})).toThrow(/needs "ref"/);
		expect(() => inspect({ ref: 'e999' })).toThrow(/Unknown ref "e999"/);
		const ref = registry.refFor(document.querySelector('button')!);
		expect(() => inspect({ ref, include: 'styles' })).toThrow(/"include" must be an array/);
		expect(() => inspect({ ref, include: ['events'] })).toThrow(/Unknown include section "events"/);
	});

	it('PROPS/ATTRIBUTES reuses the StateGrab capture (minus the data-sg-ref stamp)', () => {
		const inst = component('Field', '/src/App.svelte', 9);
		const input = meta(
			h('input', { id: 'q', name: 'q', value: 'hi', 'data-testid': 'field', class: 'f svelte-x1' }),
			'/src/lib/Field.svelte',
			3,
			1,
			inst
		);
		const label = meta(h('label', { for: 'q' }, 'Query'), '/src/lib/Field.svelte', 2, 1, inst);
		document.body.append(label, input);
		const { text, data } = inspect({ ref: registry.refFor(input), include: ['props'] });
		const body = section(text, 'PROPS/ATTRIBUTES');
		expect(body).toContain('props (class/style):');
		expect(body).toContain('  class: "f svelte-x1"');
		expect(body).toContain('  id: "q"');
		expect(body).toContain('  data-testid: "field"');
		expect(body.join('\n')).not.toContain(REF_ATTR);
		expect(body).toContain('bound/observable values:');
		expect(body).toContain('  value: "hi"');
		expect((data!.props as { boundValues: Record<string, unknown> }).boundValues).toMatchObject({
			value: 'hi',
			name: 'q'
		});
	});

	it('STATE lists inspectable() instances, or says how to expose state', () => {
		const { buttons } = buildFixture();
		const ref = registry.refFor(buttons[0]);
		const none = section(inspect({ ref, include: ['state'] }).text, 'STATE');
		expect(none[0]).toBe('no inspectable() state registered for <Button>');
		expect(none[1]).toContain("inspectable('Button'");

		const { text, data } = inspect(
			{ ref, include: ['state'] },
			lookup({ Button: [{ count: 1, fn: () => 1 }, { count: 2 }] })
		);
		expect(section(text, 'STATE')).toEqual([
			'inspectable() state for <Button> (2 live instances; not tied to this element):',
			'  [Button #1]',
			'    count: 1',
			'    fn: "[Function: fn]"',
			'  [Button #2]',
			'    count: 2'
		]);
		// structuredContent stays JSON-safe.
		expect(JSON.parse(JSON.stringify(data))).toMatchObject({
			state: { component: 'Button', instances: [{ values: { count: 1, fn: '[Function: fn]' } }, { values: { count: 2 } }] }
		});
	});

	it('LAYOUT reports box, display and clipped overflow', () => {
		const { cards } = buildFixture();
		const card = cards[0];
		card.style.overflow = 'hidden';
		setBox(card.parentElement!, 0, 0, 300, 200);
		setBox(card, 10, 20, 320, 40);
		Object.defineProperty(card, 'scrollWidth', { value: 500 });
		Object.defineProperty(card, 'clientWidth', { value: 320 });
		Object.defineProperty(card, 'scrollHeight', { value: 40 });
		Object.defineProperty(card, 'clientHeight', { value: 40 });

		const { text, data } = inspect({ ref: registry.refFor(card), include: ['layout'] });
		const body = section(text, 'LAYOUT');
		expect(body[0]).toBe('box: 10,20 320x40 (viewport px, x,y wxh)');
		expect(body[1]).toMatch(/^display: block, position: /);
		expect(body).toContain(
			'OVERFLOW: content is wider (scrollWidth 500 > clientWidth 320); overflow: hidden/hidden -> content is CLIPPED'
		);
		expect(body).toContain('extends outside its parent <main>: right 30px');
		expect(data!.layout).toMatchObject({
			box: { x: 10, y: 20, width: 320, height: 40 },
			overflowing: { x: true, y: false },
			clipped: true,
			outsideParent: { right: 30 }
		});
	});

	it('STYLES lists matched rules and authored declarations with their source', () => {
		const style = document.createElement('style');
		style.textContent = '.card { color: rgb(255, 0, 0); } .other { color: blue; }';
		document.head.append(style);
		const { cards } = buildFixture();
		const { text, data } = inspect({ ref: registry.refFor(cards[0]), include: ['styles'] });
		const body = section(text, 'STYLES');
		expect(body[0]).toBe('matched rules: 1 (stylesheet 1)');
		expect(body[1]).toBe('classes: card svelte-abc123; svelte-scoped: svelte-abc123; tailwind: none');
		expect(body).toContain('  .card → stylesheet (.card)');
		expect(body).toContain('  color: rgb(255, 0, 0) -> stylesheet (.card)');
		expect(data!.styles).toMatchObject({ matchedRuleCount: 1, declarationsTruncated: false });
	});

	it('STYLES caps the declaration list and says so', () => {
		const props = [
			'width: 10px', 'height: 10px', 'min-width: 1px', 'min-height: 1px', 'max-width: 99px',
			'max-height: 99px', 'padding-top: 1px', 'padding-right: 1px', 'padding-bottom: 1px',
			'padding-left: 1px', 'margin-top: 1px', 'margin-right: 1px', 'margin-bottom: 1px',
			'margin-left: 1px', 'color: red', 'opacity: 0.5', 'cursor: pointer', 'font-size: 12px',
			'font-weight: 700', 'line-height: 2', 'letter-spacing: 1px', 'text-align: center',
			'text-transform: uppercase', 'white-space: nowrap', 'position: relative', 'top: 1px',
			'left: 1px', 'z-index: 3', 'float: left'
		];
		const style = document.createElement('style');
		style.textContent = `.card { ${props.join('; ')} }`;
		document.head.append(style);
		const { cards } = buildFixture();
		const { text, data } = inspect({ ref: registry.refFor(cards[0]), include: ['styles'] });
		const styles = data!.styles as { declarationCount: number; declarationsTruncated: boolean; declarations: unknown[] };
		expect(styles.declarationCount).toBeGreaterThan(25);
		expect(styles.declarations).toHaveLength(25);
		expect(styles.declarationsTruncated).toBe(true);
		expect(text).toContain(`showing 25 of ${styles.declarationCount} (capped)`);
	});

	it('A11Y reports role/name, contrast and element-level issues', () => {
		const inst = component('Icon', '/src/App.svelte', 2);
		const empty = meta(h('button'), '/src/lib/Icon.svelte', 1, 1, inst);
		const text = meta(
			h('p', { style: 'color: rgb(119, 119, 119); background-color: rgb(255, 255, 255)' }, 'Muted'),
			'/src/lib/Icon.svelte',
			2,
			1,
			inst
		);
		document.body.append(empty, text);

		const a = inspect({ ref: registry.refFor(empty), include: ['a11y'] });
		const body = section(a.text, 'A11Y');
		expect(body[0]).toBe('role: button, name: (none), focusable: yes (tabIndex 0)');
		expect(body).toContain('issues (1):');
		expect(body.join('\n')).toContain('[critical] button-label: Button without accessible text');

		const b = inspect({ ref: registry.refFor(text), include: ['a11y'] });
		const pBody = section(b.text, 'A11Y');
		expect(pBody[1]).toMatch(/^contrast: 4\.48:1 \(needs 4\.5:1\) FAIL, fg rgb\(119, 119, 119\) on bg rgb\(255, 255, 255\)$/);
		expect(b.data!.a11y).toMatchObject({ contrast: { pass: false, required: 4.5 } });
	});

	it('keeps the text under the cap with a truncation note', () => {
		const { buttons } = buildFixture();
		const big: Record<string, unknown> = {};
		for (let i = 0; i < 20; i++) big[`key${i}`] = 'x'.repeat(300);
		const { text, data } = inspect(
			{ ref: registry.refFor(buttons[0]) },
			lookup({ Button: [big, big, big, big, big] })
		);
		expect(text.length).toBeLessThanOrEqual(MAX_INSPECT_TEXT);
		expect(text).toMatch(/… output truncated at 8000 chars .*Pass include/);
		expect(data!.truncated).toBe(true);
	});

	it('is dispatched as ui_inspect', async () => {
		const { buttons } = buildFixture();
		refRegistry.reset();
		const ref = refRegistry.refFor(buttons[0]);
		const out = await dispatchRuntimeCommand('ui_inspect', { ref, include: ['stack'] });
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.result.text).toContain('STACK');
		const bad = await dispatchRuntimeCommand('ui_inspect', { ref: 'e424242' });
		expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/Unknown ref/) });
	});
});
