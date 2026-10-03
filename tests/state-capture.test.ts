// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
	collectStateValues,
	computeStateDiffs,
	extractComponentState,
	findInspectableInstances,
	formatStateForAgent,
	type InspectableLookup
} from '../src/lib/utils/state-capture.js';
import type { StateSnapshot } from '../src/lib/types.js';
import { component, h, meta } from './runtime-helpers.js';

/**
 * Pins the SvelteStateGrab capture + agent text (moved verbatim from
 * SvelteStateGrab.svelte into utils/state-capture.ts, shared with ui_inspect).
 */

function lookup(entries: Record<string, Record<string, unknown>[]>): InspectableLookup {
	return {
		getInstances: (name) =>
			(entries[name] ?? []).map((values, i) => ({
				label: `${name} #${i + 1}`,
				instance: i + 1,
				values
			})),
		getIds: () => Object.keys(entries).filter((k) => entries[k].length > 0)
	};
}

beforeEach(() => {
	document.body.innerHTML = '';
});

function buildCard(): HTMLElement {
	const inst = component('Card', '/src/App.svelte', 3);
	const card = meta(
		h('div', { class: 'card svelte-abc123', id: 'c1', 'data-testid': 'card', style: 'color: red;' }),
		'/src/lib/Card.svelte',
		5,
		1,
		inst
	);
	const btnInst = component('Button', '/src/lib/Card.svelte', 7, inst);
	const b1 = meta(h('button', {}, 'x'), '/src/lib/Button.svelte', 2, 1, btnInst);
	const b2 = meta(h('button', {}, 'y'), '/src/lib/Button.svelte', 2, 1, btnInst);
	const p = meta(h('p', {}, 'own'), '/src/lib/Card.svelte', 6, 3, inst);
	card.append(p, b1, b2);
	document.body.append(card);
	return card;
}

describe('extractComponentState', () => {
	it('collects props, attributes, data attributes, children and inspectable instances', () => {
		const card = buildCard();
		const info = extractComponentState(card, lookup({ card: [{ open: true }] }));
		expect(info).toEqual({
			componentName: 'Card',
			file: 'src/lib/Card.svelte',
			line: 5,
			props: { class: 'card svelte-abc123', style: 'color: red;' },
			attributes: { id: 'c1' },
			dataAttributes: { 'data-testid': 'card' },
			boundValues: {},
			inspectableState: { open: true },
			inspectableInstances: [{ label: 'card #1', instance: 1, values: { open: true } }],
			childComponentCount: 2,
			childComponents: [{ name: 'Button', file: 'src/lib/Button.svelte', count: 2 }],
			elementTag: 'div'
		});
	});

	it('reads form values and leaf text', () => {
		const input = meta(h('input', { name: 'q', value: 'hi' }), '/src/Form.svelte', 4, 1, null);
		document.body.append(input);
		const info = extractComponentState(input, lookup({}));
		expect(info.boundValues).toEqual({ value: 'hi', checked: false, type: 'text', name: 'q' });
		expect(info.inspectableInstances).toBeUndefined();

		const span = meta(h('span', {}, '  hello  '), '/src/Form.svelte', 5, 1, null);
		expect(extractComponentState(span, lookup({})).boundValues).toEqual({ textContent: 'hello' });
	});

	it('findInspectableInstances: exact name first, then case-insensitive', () => {
		const l = lookup({ Card: [{ a: 1 }], counter: [{ n: 1 }, { n: 2 }] });
		expect(findInspectableInstances('Card', l)).toHaveLength(1);
		expect(findInspectableInstances('Counter', l)?.map((i) => i.label)).toEqual([
			'counter #1',
			'counter #2'
		]);
		expect(findInspectableInstances('Nope', l)).toBeUndefined();
		expect(findInspectableInstances(null, l)).toBeUndefined();
	});
});

describe('formatStateForAgent (SvelteStateGrab output)', () => {
	it('renders the same sections and order as before the extraction', () => {
		const card = buildCard();
		const info = extractComponentState(card, lookup({ card: [{ open: true }] }));
		expect(formatStateForAgent(info)).toBe(
			[
				'=== Component State: Card ===\n',
				'\u{1F4E5} OBSERVABLE PROPS/ATTRIBUTES:',
				'  class: "card svelte-abc123"',
				'  style: "color: red;"',
				'',
				'\u{1F3F7}️ HTML ATTRIBUTES:',
				'  id: "c1"',
				'',
				'\u{1F4CA} DATA ATTRIBUTES:',
				'  data-testid: "card"',
				'',
				'\u{1F50D} INSPECTABLE STATE ($state):',
				'  open: true',
				'',
				'\u{1F333} CHILD COMPONENTS (2 total, 1 unique):',
				'  <Button> src/lib/Button.svelte (x2)',
				'',
				'\u{1F4CD} Location: src/lib/Card.svelte:5'
			].join('\n')
		);
	});

	it('lists every inspectable instance, diffs and snapshot history', () => {
		const card = buildCard();
		const info = extractComponentState(card, lookup({ Card: [{ n: 1 }, { n: 2 }] }));
		const diffs = computeStateDiffs({ 'props.a': 1, 'props.gone': 1 }, { 'props.a': 2, 'props.new': 3 });
		expect(diffs).toEqual([
			{ key: 'props.a', oldValue: 1, newValue: 2 },
			{ key: 'props.gone', oldValue: 1, newValue: undefined },
			{ key: 'props.new', oldValue: undefined, newValue: 3 }
		]);
		const snap = (t: number): StateSnapshot => ({
			timestamp: t,
			componentName: 'Card',
			file: info.file,
			state: { a: 1, b: 2 }
		});
		const text = formatStateForAgent(info, diffs, [snap(0), snap(1)]);
		expect(text).toContain(
			['\u{1F50D} INSPECTABLE STATE ($state, 2 instances):', '  [Card #1]', '    n: 1', '  [Card #2]', '    n: 2'].join(
				'\n'
			)
		);
		expect(text).toContain(
			[
				'\u{1F504} STATE CHANGES (since last capture):',
				'  props.a: 1 → 2',
				'  props.gone: 1 → (removed)',
				'  props.new: (new) → 3'
			].join('\n')
		);
		expect(text).toMatch(/\u{1F4F8} SNAPSHOT HISTORY \(2 captures for this component\):\n {2}\[.+\] 2 values/u);
	});

	it('collectStateValues prefixes props, bound values and per-instance state', () => {
		const card = buildCard();
		const info = extractComponentState(card, lookup({ Card: [{ n: 1 }, { n: 2 }] }));
		expect(collectStateValues(info)).toEqual({
			'props.class': 'card svelte-abc123',
			'props.style': 'color: red;',
			'state#1.n': 1,
			'state#2.n': 2
		});
	});
});
