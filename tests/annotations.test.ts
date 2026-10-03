import { describe, it, expect, vi } from 'vitest';
import {
	AnnotationStore,
	MAX_ANNOTATIONS,
	MAX_COMMENT_LENGTH,
	MAX_REFS_PER_ANNOTATION,
	formatAnnotationsForAgent,
	type AnnotationRef
} from '../src/lib/utils/annotations.js';
import {
	isAnnotationKey,
	isGrabHotkeyEnabled,
	toolHotkeysEnabled
} from '../src/lib/utils/hotkeys.js';

const ref = (n: number, extra: Partial<AnnotationRef> = {}): AnnotationRef => ({
	ref: `e${n}`,
	stableKey: `ui:///src/lib/Card.svelte:5:1#Card[role=,name=][${n}]`,
	component: 'Card',
	source: '/repo/src/lib/Card.svelte:5',
	...extra
});

describe('AnnotationStore', () => {
	it('numbers annotations #1, #2 and keeps targets out of list()', () => {
		const store = new AnnotationStore<string>();
		const a = store.add({ comment: '  make it bold  ', refs: [ref(1)], targets: ['el1'] }, 1000);
		const b = store.add({ comment: 'green', refs: [ref(2), ref(3)], targets: ['el2', 'el3'] }, 2000);
		expect(a).toEqual({ id: 1, comment: 'make it bold', refs: [ref(1)], createdAt: 1000 });
		expect(b!.id).toBe(2);
		expect(store.size).toBe(2);
		expect(store.list()).toEqual([a, b]);
		expect(store.list()[0]).not.toHaveProperty('targets');
		expect(store.targetsOf(2)).toEqual(['el2', 'el3']);
		expect(store.nextId).toBe(3);
	});

	it('list() returns copies (mutating them does not touch the store)', () => {
		const store = new AnnotationStore();
		store.add({ comment: 'x', refs: [ref(1)] }, 1);
		const [copy] = store.list();
		copy.comment = 'changed';
		copy.refs[0].ref = 'e99';
		expect(store.list()[0].comment).toBe('x');
		expect(store.list()[0].refs[0].ref).toBe('e1');
	});

	it('updates and removes by id; ids keep counting until the store is empty', () => {
		const store = new AnnotationStore();
		store.add({ comment: 'one', refs: [ref(1)] }, 1);
		store.add({ comment: 'two', refs: [ref(2)] }, 2);
		expect(store.update(1, ' first ')).toBe(true);
		expect(store.update(42, 'nope')).toBe(false);
		expect(store.remove(2)).toBe(true);
		expect(store.remove(2)).toBe(false);
		expect(store.list().map((a) => [a.id, a.comment])).toEqual([[1, 'first']]);
		// #2 was deleted but numbering does not reuse it while #1 is pending
		expect(store.add({ comment: 'three', refs: [ref(3)] }, 3)!.id).toBe(3);
		store.remove(1);
		store.remove(3);
		// Empty again: numbering restarts
		expect(store.add({ comment: 'fresh', refs: [ref(4)] }, 4)!.id).toBe(1);
	});

	it('clear() drops annotations and the instruction and restarts numbering', () => {
		const store = new AnnotationStore();
		store.add({ comment: 'one', refs: [ref(1)] }, 1);
		store.setInstruction('  keep it consistent ');
		expect(store.instruction).toBe('keep it consistent');
		store.clear();
		expect(store.size).toBe(0);
		expect(store.instruction).toBe('');
		expect(store.nextId).toBe(1);
	});

	it('caps comment length, refs per annotation and the number of annotations', () => {
		const store = new AnnotationStore();
		const many = Array.from({ length: MAX_REFS_PER_ANNOTATION + 5 }, (_, i) => ref(i));
		const a = store.add({ comment: 'x'.repeat(MAX_COMMENT_LENGTH + 10), refs: many }, 1)!;
		expect(a.comment).toHaveLength(MAX_COMMENT_LENGTH);
		expect(a.refs).toHaveLength(MAX_REFS_PER_ANNOTATION);
		for (let i = 1; i < MAX_ANNOTATIONS; i++) store.add({ comment: '', refs: [ref(i)] }, i);
		expect(store.size).toBe(MAX_ANNOTATIONS);
		expect(store.isFull).toBe(true);
		expect(store.add({ comment: 'overflow', refs: [ref(1)] }, 1)).toBe(null);
		expect(store.size).toBe(MAX_ANNOTATIONS);
	});

	it('refuses an annotation without refs', () => {
		const store = new AnnotationStore();
		expect(store.add({ comment: 'nothing selected', refs: [] }, 1)).toBe(null);
		expect(store.size).toBe(0);
	});

	it('replaceRefs swaps refs (and targets) after rebinding', () => {
		const store = new AnnotationStore<string>();
		store.add({ comment: 'x', refs: [ref(1)], targets: ['old'] }, 1);
		expect(store.replaceRefs(1, [ref(7)], ['new'])).toBe(true);
		expect(store.list()[0].refs).toEqual([ref(7)]);
		expect(store.targetsOf(1)).toEqual(['new']);
		expect(store.replaceRefs(9, [], [])).toBe(false);
	});

	it('notifies subscribers on every change and stops after unsubscribe', () => {
		const store = new AnnotationStore();
		const fn = vi.fn();
		const off = store.subscribe(fn);
		store.add({ comment: 'x', refs: [ref(1)] }, 1);
		store.update(1, 'y');
		store.setInstruction('do it');
		store.replaceRefs(1, [ref(2)]);
		store.remove(1);
		store.clear();
		expect(fn).toHaveBeenCalledTimes(6);
		off();
		store.add({ comment: 'z', refs: [ref(1)] }, 1);
		expect(fn).toHaveBeenCalledTimes(6);
	});
});

describe('formatAnnotationsForAgent', () => {
	it('lists each annotation with refs, stable keys, component, source and comment', () => {
		const store = new AnnotationStore();
		store.add({ comment: 'Make the card text bold', refs: [ref(1)] }, 1);
		store.add(
			{
				comment: 'These buttons\nshould be green',
				refs: [
					ref(5, { component: 'Button', source: '/repo/src/lib/Button.svelte:2' }),
					ref(6, { component: null, source: null })
				]
			},
			2
		);
		const text = formatAnnotationsForAgent(store.list(), 'Keep the palette consistent', (p) =>
			p.replace('/repo/', '')
		);
		expect(text).toBe(
			[
				'UI annotations: 2',
				'Instruction: Keep the palette consistent',
				'',
				'#1 (1 element): Make the card text bold',
				'  - e1 <Card> src/lib/Card.svelte:5',
				'    key: ui:///src/lib/Card.svelte:5:1#Card[role=,name=][1]',
				'#2 (2 elements): These buttons',
				'    should be green',
				'  - e5 <Button> src/lib/Button.svelte:2',
				'    key: ui:///src/lib/Card.svelte:5:1#Card[role=,name=][5]',
				'  - e6 (no component) (no source)',
				'    key: ui:///src/lib/Card.svelte:5:1#Card[role=,name=][6]',
				'',
				'Refs are stamped as data-sg-ref: locate with [data-sg-ref="<ref>"], or pass the ref or ui:// key to ui_inspect.'
			].join('\n')
		);
	});

	it('omits an empty instruction, marks empty comments and stale refs', () => {
		const store = new AnnotationStore();
		store.add({ comment: '', refs: [ref(1, { stale: true })] }, 1);
		const text = formatAnnotationsForAgent(store.list(), '');
		expect(text).not.toContain('Instruction:');
		expect(text).toContain('#1 (1 element): (no comment)');
		expect(text).toContain('  - e1 <Card> /repo/src/lib/Card.svelte:5 (element gone)');
	});

	it('says so when there is nothing pending', () => {
		expect(formatAnnotationsForAgent([], '')).toBe('No pending annotations.');
	});
});

describe('isAnnotationKey', () => {
	it('matches the N key by character, else by physical key (Option+N on macOS)', () => {
		expect(isAnnotationKey({ key: 'n', code: 'KeyN' })).toBe(true);
		expect(isAnnotationKey({ key: 'N', code: 'KeyN' })).toBe(true);
		// macOS Option+N produces a dead key
		expect(isAnnotationKey({ key: 'Dead', code: 'KeyN' })).toBe(true);
		expect(isAnnotationKey({ key: '˜', code: 'KeyN' })).toBe(true);
		// Layouts where the physical N key types another letter follow the letter
		expect(isAnnotationKey({ key: 'b', code: 'KeyN' })).toBe(false);
		expect(isAnnotationKey({ key: 'n', code: 'KeyL' })).toBe(true);
		expect(isAnnotationKey({ key: 'a', code: 'KeyA' })).toBe(false);
	});
});

describe('hotkeys gating', () => {
	it("'full' (and the default) keeps every SvelteGrab hotkey and tool trigger", () => {
		for (const mode of ['full', undefined] as const) {
			for (const key of ['point', 'multi', 'region', 'escape', 'annotate', 'prompt', 'open', 'screenshot', 'relayPrompt', 'help', 'arrows', 'copy', 'contextMenu'] as const) {
				expect(isGrabHotkeyEnabled(mode, key)).toBe(true);
			}
			expect(toolHotkeysEnabled(mode)).toBe(true);
		}
	});

	it("'minimal' keeps only point, multi, region, escape and annotate", () => {
		const on = ['point', 'multi', 'region', 'escape', 'annotate'] as const;
		const off = ['prompt', 'open', 'screenshot', 'relayPrompt', 'help', 'arrows', 'copy', 'contextMenu'] as const;
		for (const key of on) expect(isGrabHotkeyEnabled('minimal', key)).toBe(true);
		for (const key of off) expect(isGrabHotkeyEnabled('minimal', key)).toBe(false);
		expect(toolHotkeysEnabled('minimal')).toBe(false);
	});
});
