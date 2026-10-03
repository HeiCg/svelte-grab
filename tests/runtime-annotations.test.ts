// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { AnnotationStore } from '../src/lib/utils/annotations.js';
import {
	annotationStore,
	addAnnotation,
	describeAnnotationTargets,
	uiAnnotations
} from '../src/lib/runtime/annotations.js';
import { RefRegistry, REF_ATTR, refRegistry } from '../src/lib/runtime/refs.js';
import { dispatchRuntimeCommand, runtimeTools } from '../src/lib/runtime/commands.js';
import { buildFixture } from './runtime-helpers.js';

let registry: RefRegistry;
let store: AnnotationStore<Element>;

beforeEach(() => {
	document.body.innerHTML = '';
	registry = new RefRegistry();
	store = new AnnotationStore<Element>();
});

describe('describeAnnotationTargets', () => {
	it('registers refs (stamped as data-sg-ref) with stable key, component and source', () => {
		const { buttons, cards } = buildFixture();
		const refs = describeAnnotationTargets([cards[1], buttons[0]], registry);
		expect(refs).toEqual([
			{
				ref: 'e1',
				stableKey: 'ui:///src/lib/Card.svelte:5:1#Card[role=,name=][1]',
				component: 'Card',
				source: '/src/lib/Card.svelte:5'
			},
			{
				ref: 'e2',
				stableKey: 'ui:///src/lib/Button.svelte:2:1#Button[role=button,name=a][0]',
				component: 'Button',
				source: '/src/lib/Button.svelte:2'
			}
		]);
		expect(cards[1].getAttribute(REF_ATTR)).toBe('e1');
		expect(registry.resolve('e2')!.element).toBe(buttons[0]);
	});
});

describe('addAnnotation', () => {
	it('stores the comment, the refs and the live elements', () => {
		const { buttons } = buildFixture();
		const a = addAnnotation('make both green', buttons, store, registry, 123)!;
		expect(a).toMatchObject({ id: 1, comment: 'make both green', createdAt: 123 });
		expect(a.refs.map((r) => r.ref)).toEqual(['e1', 'e2']);
		expect(store.targetsOf(1)).toEqual(buttons);
	});

	it('returns null for an empty selection', () => {
		buildFixture();
		expect(addAnnotation('nothing', [], store, registry)).toBe(null);
	});
});

describe('ui_annotations', () => {
	it('returns pending annotations with refs and the instruction (text + data)', () => {
		const { buttons, h1 } = buildFixture();
		addAnnotation('bigger title', [h1], store, registry, 10);
		addAnnotation('green buttons', buttons, store, registry, 20);
		store.setInstruction('Polish the page');

		const out = uiAnnotations({}, store, registry);
		expect(out.data).toEqual({
			annotations: [
				{
					id: 1,
					comment: 'bigger title',
					createdAt: 10,
					refs: [
						{
							ref: 'e1',
							stableKey: 'ui:///src/App.svelte:2:3#App[role=heading,name=Title][0]',
							component: 'App',
							source: '/src/App.svelte:2'
						}
					]
				},
				{
					id: 2,
					comment: 'green buttons',
					createdAt: 20,
					refs: [
						expect.objectContaining({ ref: 'e2', component: 'Button' }),
						expect.objectContaining({ ref: 'e3', component: 'Button' })
					]
				}
			],
			instruction: 'Polish the page',
			cleared: false
		});
		expect(out.text).toContain('UI annotations: 2');
		expect(out.text).toContain('Instruction: Polish the page');
		expect(out.text).toContain('#2 (2 elements): green buttons');
		// Nothing consumed without clear
		expect(store.size).toBe(2);
	});

	it('clear: true returns them once and empties the store', () => {
		const { h1 } = buildFixture();
		addAnnotation('x', [h1], store, registry);
		const out = uiAnnotations({ clear: true }, store, registry);
		expect((out.data!.annotations as unknown[]).length).toBe(1);
		expect(out.data!.cleared).toBe(true);
		expect(out.text).toContain('marked as consumed');
		expect(store.size).toBe(0);
		expect(uiAnnotations({}, store, registry).text).toMatch(/^No pending annotations\./);
	});

	it('rejects a non-boolean clear', () => {
		expect(() => uiAnnotations({ clear: 'yes' }, store, registry)).toThrow('"clear" must be a boolean');
	});

	it('rebinds a re-rendered element by stable key and flags elements that are gone', () => {
		const { cards, h1 } = buildFixture();
		addAnnotation('card b', [cards[1]], store, registry);
		addAnnotation('title', [h1], store, registry);

		// Re-render card b: same source/role/name, new node.
		const clone = cards[1].cloneNode(true) as HTMLElement;
		Object.assign(clone, { __svelte_meta: (cards[1] as unknown as { __svelte_meta: unknown }).__svelte_meta });
		clone.removeAttribute(REF_ATTR);
		cards[1].replaceWith(clone);
		h1.remove();

		const out = uiAnnotations({}, store, registry);
		const [card, title] = out.data!.annotations as { refs: { ref: string; stale?: true }[] }[];
		expect(card.refs[0].ref).not.toBe('e1');
		expect(card.refs[0].stale).toBeUndefined();
		expect(clone.getAttribute(REF_ATTR)).toBe(card.refs[0].ref);
		expect(store.targetsOf(1)).toEqual([clone]);
		expect(title.refs[0]).toMatchObject({ ref: 'e2', stale: true });
		expect(out.text).toContain('(element gone)');
	});
});

describe('runtime dispatch', () => {
	it('registers ui_annotations on the page and serves the shared store', async () => {
		expect(Object.keys(runtimeTools)).toContain('ui_annotations');
		const { buttons } = buildFixture();
		annotationStore.clear();
		refRegistry.reset();
		addAnnotation('from the tray', [buttons[1]]);
		const outcome = await dispatchRuntimeCommand('ui_annotations', { clear: true });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.result.data!.annotations).toEqual([
			expect.objectContaining({ id: 1, comment: 'from the tray' })
		]);
		expect(annotationStore.size).toBe(0);
	});
});
