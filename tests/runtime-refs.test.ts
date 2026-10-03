// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
	RefRegistry,
	REF_ATTR,
	computeStableKey,
	computeStableKeys,
	findByStableKey
} from '../src/lib/runtime/refs.js';
import { computeName, computeRole } from '../src/lib/runtime/aria.js';
import { buildFixture, component, h, meta } from './runtime-helpers.js';

beforeEach(() => {
	document.body.innerHTML = '';
});

describe('computeRole / computeName', () => {
	it('uses explicit role, then implicit roles', () => {
		expect(computeRole(h('div', { role: 'tab' }))).toBe('tab');
		expect(computeRole(h('button'))).toBe('button');
		expect(computeRole(h('a', { href: '#' }))).toBe('link');
		expect(computeRole(h('a'))).toBe(null);
		expect(computeRole(h('input', { type: 'checkbox' }))).toBe('checkbox');
		expect(computeRole(h('input'))).toBe('textbox');
		expect(computeRole(h('h2'))).toBe('heading');
		expect(computeRole(h('nav'))).toBe('navigation');
		expect(computeRole(h('img', { alt: '' }))).toBe('presentation');
		expect(computeRole(h('div'))).toBe(null);
	});

	it('computes names from aria-label, labelledby, label[for], alt and content', () => {
		expect(computeName(h('button', { 'aria-label': 'Close' }, 'x'))).toBe('Close');
		const label = h('span', { id: 'lbl' }, 'Email address');
		document.body.append(label);
		expect(computeName(h('input', { 'aria-labelledby': 'lbl' }))).toBe('Email address');

		const forLabel = h('label', { for: 'name' }, 'Your name');
		const input = h('input', { id: 'name' });
		document.body.append(forLabel, input);
		expect(computeName(input)).toBe('Your name');

		expect(computeName(h('img', { alt: 'Logo' }))).toBe('Logo');
		expect(computeName(h('button', {}, '  Save\n  draft '))).toBe('Save draft');
		// generic containers do not take their name from content
		expect(computeName(h('div', {}, 'lots of text'))).toBe('');
	});
});

describe('stable keys', () => {
	it('builds ui://<file>:<line>:<col>#<componentTag>[role,name][i]', () => {
		const { buttons, cards, h1 } = buildFixture();
		expect(computeStableKey(buttons[0])).toBe(
			'ui:///src/lib/Button.svelte:2:1#Button[role=button,name=a][0]'
		);
		expect(computeStableKey(h1)).toBe('ui:///src/App.svelte:2:3#App[role=heading,name=Title][0]');
		// Same loc + same role/name -> index disambiguates the two card instances.
		expect(computeStableKey(cards[0])).toBe('ui:///src/lib/Card.svelte:5:1#Card[role=,name=][0]');
		expect(computeStableKey(cards[1])).toBe('ui:///src/lib/Card.svelte:5:1#Card[role=,name=][1]');
	});

	it('computes several keys in one pass with the same result', () => {
		const { cards, buttons } = buildFixture();
		const keys = computeStableKeys([...cards, ...buttons]);
		for (const el of [...cards, ...buttons]) expect(keys.get(el)).toBe(computeStableKey(el));
	});

	it('finds the element by key', () => {
		const { cards } = buildFixture();
		expect(findByStableKey(computeStableKey(cards[1]))).toBe(cards[1]);
		expect(findByStableKey('ui:///nope.svelte:1:1#X[role=,name=][0]')).toBe(null);
		expect(findByStableKey('not-a-key')).toBe(null);
	});
});

describe('RefRegistry', () => {
	let registry: RefRegistry;
	beforeEach(() => {
		registry = new RefRegistry();
	});

	it('assigns incrementing refs, stamps data-sg-ref and reuses refs per element', () => {
		const { buttons } = buildFixture();
		expect(registry.refFor(buttons[0])).toBe('e1');
		expect(registry.refFor(buttons[1])).toBe('e2');
		expect(registry.refFor(buttons[0])).toBe('e1');
		expect(buttons[0].getAttribute(REF_ATTR)).toBe('e1');
		expect(document.querySelector(`[${REF_ATTR}="e2"]`)).toBe(buttons[1]);
	});

	it('resolves refs and stable keys to live elements', () => {
		const { buttons } = buildFixture();
		const ref = registry.refFor(buttons[1]);
		expect(registry.resolve(ref)?.element).toBe(buttons[1]);
		const key = registry.stableKeyOf(ref)!;
		const byKey = registry.resolve(key)!;
		expect(byKey.element).toBe(buttons[1]);
		expect(byKey.ref).toBe(ref);
		expect(byKey.rebound).toBeUndefined();
	});

	it('re-resolves a disconnected element by stable key and reports rebound', () => {
		const { cards, buttons } = buildFixture();
		const oldRef = registry.refFor(buttons[0]);

		// Simulate a re-render: the button is replaced by a fresh element with
		// the same source location / component / role / name.
		const inst = component('Button', '/src/lib/Card.svelte', 7);
		const fresh = meta(h('button', {}, 'a'), '/src/lib/Button.svelte', 2, 1, inst);
		buttons[0].replaceWith(fresh);

		const res = registry.resolve(oldRef)!;
		expect(res.element).toBe(fresh);
		expect(res.rebound).toBe(true);
		expect(res.previous).toBe(oldRef);
		expect(res.ref).not.toBe(oldRef);
		expect(fresh.getAttribute(REF_ATTR)).toBe(res.ref);
		expect(cards[0].contains(fresh)).toBe(true);
	});

	it('returns null for unknown refs and refs whose element is gone for good', () => {
		const { buttons } = buildFixture();
		expect(registry.resolve('e99')).toBe(null);
		expect(registry.resolve('garbage')).toBe(null);
		const ref = registry.refFor(buttons[0]);
		buttons[0].remove();
		expect(registry.resolve(ref)).toBe(null);
	});

	it('picks up refs stamped by an earlier registry instance', () => {
		const { buttons } = buildFixture();
		new RefRegistry().refFor(buttons[0]);
		expect(registry.resolve('e1')?.element).toBe(buttons[0]);
	});
});
