import { describe, it, expect } from 'vitest';
import {
	hasReservedModifier,
	resolveReservedModifiers,
	matchesSecondaryModifier,
	resolveA11yElementModifier,
	resolveReservedContextMenuModifiers,
	shouldYieldDoubleClick
} from '../src/lib/utils/hotkeys.js';

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

describe('matchesSecondaryModifier', () => {
	it('always matches without a secondary modifier (standalone default)', () => {
		expect(matchesSecondaryModifier(click({ altKey: true }), undefined)).toBe(true);
		expect(matchesSecondaryModifier(click({ altKey: true, shiftKey: true }), undefined)).toBe(true);
	});

	it('requires the secondary modifier when set', () => {
		expect(matchesSecondaryModifier(click({ altKey: true }), 'shift')).toBe(false);
		expect(matchesSecondaryModifier(click({ altKey: true, shiftKey: true }), 'shift')).toBe(true);
		expect(matchesSecondaryModifier(click({ altKey: true, ctrlKey: true }), 'shift')).toBe(false);
		expect(matchesSecondaryModifier(click({ altKey: true, metaKey: true }), 'meta')).toBe(true);
	});
});

describe('resolveA11yElementModifier', () => {
	const base = {
		hotkeys: 'full' as const,
		modifier: 'alt' as const,
		grabEnabled: true,
		showContextMenu: true
	};

	it('moves the element audit to Alt+Shift+RightClick next to the SvelteGrab context menu', () => {
		expect(resolveA11yElementModifier(base)).toBe('shift');
		expect(resolveA11yElementModifier({ ...base, hotkeys: undefined })).toBe('shift');
	});

	it('keeps plain Modifier+RightClick when there is no context menu to collide with', () => {
		expect(resolveA11yElementModifier({ ...base, grabEnabled: false })).toBeUndefined();
		expect(resolveA11yElementModifier({ ...base, showContextMenu: false })).toBeUndefined();
	});

	it('is undefined in minimal mode (both triggers are off)', () => {
		expect(resolveA11yElementModifier({ ...base, hotkeys: 'minimal' })).toBeUndefined();
	});

	it('never picks the primary modifier', () => {
		expect(resolveA11yElementModifier({ ...base, modifier: 'shift' })).toBe('meta');
	});
});

describe('resolveReservedContextMenuModifiers', () => {
	it('reserves the A11y element modifier while A11y is enabled', () => {
		expect(
			resolveReservedContextMenuModifiers({
				modifier: 'alt',
				a11yEnabled: true,
				a11yElementModifier: 'shift'
			})
		).toEqual(['shift']);
	});

	it('reserves nothing without A11y or without a secondary modifier', () => {
		expect(
			resolveReservedContextMenuModifiers({
				modifier: 'alt',
				a11yEnabled: false,
				a11yElementModifier: 'shift'
			})
		).toEqual([]);
		expect(
			resolveReservedContextMenuModifiers({
				modifier: 'alt',
				a11yEnabled: true,
				a11yElementModifier: undefined
			})
		).toEqual([]);
	});

	it('drops an entry equal to the primary modifier', () => {
		expect(
			resolveReservedContextMenuModifiers({
				modifier: 'shift',
				a11yEnabled: true,
				a11yElementModifier: 'shift'
			})
		).toEqual([]);
	});
});

describe('shouldYieldDoubleClick', () => {
	it('yields double-clicks to a live PropsTracer trigger', () => {
		expect(shouldYieldDoubleClick({ hotkeys: 'full', propsEnabled: true })).toBe(true);
		expect(shouldYieldDoubleClick({ hotkeys: undefined, propsEnabled: true })).toBe(true);
	});

	it('does not yield without the tracer or in minimal mode', () => {
		expect(shouldYieldDoubleClick({ hotkeys: 'full', propsEnabled: false })).toBe(false);
		expect(shouldYieldDoubleClick({ hotkeys: 'minimal', propsEnabled: true })).toBe(false);
	});
});
