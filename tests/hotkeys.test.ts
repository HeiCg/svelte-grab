import { describe, it, expect } from 'vitest';
import { hasReservedModifier, resolveReservedModifiers } from '../src/lib/utils/hotkeys.js';

function click(opts: Partial<Pick<MouseEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>>) {
	return { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...opts };
}

describe('hasReservedModifier', () => {
	it('never matches with no reserved modifiers (standalone SvelteGrab)', () => {
		expect(hasReservedModifier(click({ altKey: true, ctrlKey: true }), [], 'alt')).toBe(false);
		expect(hasReservedModifier(click({ altKey: true, metaKey: true }), undefined, 'alt')).toBe(
			false
		);
		expect(hasReservedModifier(click({ altKey: true, shiftKey: true }), [], 'alt')).toBe(false);
	});

	it('matches when the click carries a reserved extra modifier', () => {
		const reserved = ['ctrl', 'meta'] as const;
		expect(hasReservedModifier(click({ altKey: true, ctrlKey: true }), reserved, 'alt')).toBe(true);
		expect(hasReservedModifier(click({ altKey: true, metaKey: true }), reserved, 'alt')).toBe(true);
		expect(
			hasReservedModifier(click({ altKey: true, shiftKey: true, metaKey: true }), reserved, 'alt')
		).toBe(true);
	});

	it('leaves plain and unreserved extra modifiers alone', () => {
		const reserved = ['ctrl', 'meta'] as const;
		expect(hasReservedModifier(click({ altKey: true }), reserved, 'alt')).toBe(false);
		expect(hasReservedModifier(click({ altKey: true, shiftKey: true }), reserved, 'alt')).toBe(
			false
		);
	});

	it('matches shift only when shift is reserved', () => {
		expect(hasReservedModifier(click({ altKey: true, shiftKey: true }), ['shift'], 'alt')).toBe(
			true
		);
	});

	it('ignores a reserved entry equal to the primary modifier', () => {
		// modifier='ctrl' + reserved 'ctrl' would otherwise block every grab.
		expect(hasReservedModifier(click({ ctrlKey: true }), ['ctrl'], 'ctrl')).toBe(false);
		expect(
			hasReservedModifier(click({ ctrlKey: true, metaKey: true }), ['ctrl', 'meta'], 'ctrl')
		).toBe(true);
	});
});

describe('resolveReservedModifiers', () => {
	const base = {
		hotkeys: 'full' as const,
		modifier: 'alt' as const,
		enableMultiSelect: true,
		stateEnabled: true,
		stateModifier: 'meta' as const,
		styleEnabled: true,
		styleModifier: 'ctrl' as const
	};

	it('reserves StateGrab and StyleGrab secondary modifiers in full mode', () => {
		expect(resolveReservedModifiers(base).sort()).toEqual(['ctrl', 'meta']);
	});

	it('reserves nothing in minimal mode (other tool triggers are off)', () => {
		expect(resolveReservedModifiers({ ...base, hotkeys: 'minimal' })).toEqual([]);
	});

	it('treats an undefined hotkeys mode as full', () => {
		expect(resolveReservedModifiers({ ...base, hotkeys: undefined }).sort()).toEqual([
			'ctrl',
			'meta'
		]);
	});

	it('skips disabled tools', () => {
		expect(resolveReservedModifiers({ ...base, stateEnabled: false })).toEqual(['ctrl']);
		expect(resolveReservedModifiers({ ...base, styleEnabled: false })).toEqual(['meta']);
		expect(resolveReservedModifiers({ ...base, stateEnabled: false, styleEnabled: false })).toEqual(
			[]
		);
	});

	it('never reserves shift while multi-select is on', () => {
		expect(resolveReservedModifiers({ ...base, stateModifier: 'shift' })).toEqual(['ctrl']);
	});

	it('reserves shift when multi-select is off and StateGrab uses it', () => {
		expect(
			resolveReservedModifiers({ ...base, enableMultiSelect: false, stateModifier: 'shift' }).sort()
		).toEqual(['ctrl', 'shift']);
	});

	it('deduplicates and drops the primary modifier', () => {
		expect(resolveReservedModifiers({ ...base, stateModifier: 'ctrl' })).toEqual(['ctrl']);
		expect(resolveReservedModifiers({ ...base, modifier: 'ctrl' })).toEqual(['meta']);
	});
});
