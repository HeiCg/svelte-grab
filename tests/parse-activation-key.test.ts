import { describe, it, expect } from 'vitest';
import {
	parseActivationKey,
	parseActivationKeyForMouse,
	formatActivationKeyLabel,
	MODIFIER_MAP
} from '../src/lib/utils/parse-activation-key.js';

/** Minimal KeyboardEvent-shaped stub (avoids needing a DOM). */
function kbd(opts: Partial<KeyboardEvent>): KeyboardEvent {
	return {
		key: '',
		metaKey: false,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		...opts
	} as KeyboardEvent;
}

/** Minimal MouseEvent-shaped stub. */
function mouse(opts: Partial<MouseEvent>): MouseEvent {
	return {
		metaKey: false,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		...opts
	} as MouseEvent;
}

describe('MODIFIER_MAP', () => {
	it.each([
		['meta', 'metaKey'],
		['cmd', 'metaKey'],
		['command', 'metaKey'],
		['win', 'metaKey'],
		['windows', 'metaKey'],
		['ctrl', 'ctrlKey'],
		['control', 'ctrlKey'],
		['shift', 'shiftKey'],
		['alt', 'altKey'],
		['option', 'altKey'],
		['opt', 'altKey']
	])('maps "%s" to %s', (alias, prop) => {
		expect(MODIFIER_MAP[alias]).toBe(prop);
	});
});

describe('parseActivationKey', () => {
	it('returns a function activation key unchanged', () => {
		const fn = (e: KeyboardEvent) => e.key === 'z';
		expect(parseActivationKey(fn)).toBe(fn);
	});

	describe('modifier-only shortcuts', () => {
		const matcher = parseActivationKey('alt+shift');

		it('matches when both modifiers are held', () => {
			expect(matcher(kbd({ altKey: true, shiftKey: true }))).toBe(true);
		});

		it('matches when one modifier is the key being pressed', () => {
			// Pressing Shift while Alt already held: shiftKey may not be set yet.
			expect(matcher(kbd({ altKey: true, key: 'Shift' }))).toBe(true);
		});

		it('does not match when a required modifier is missing', () => {
			expect(matcher(kbd({ altKey: true }))).toBe(false);
		});

		it('ignores extra modifiers not in the shortcut', () => {
			expect(matcher(kbd({ altKey: true, shiftKey: true, ctrlKey: true }))).toBe(true);
		});
	});

	describe('key + modifier shortcuts', () => {
		const matcher = parseActivationKey('alt+k');

		it('matches the key with the modifier (case-insensitive)', () => {
			expect(matcher(kbd({ key: 'K', altKey: true }))).toBe(true);
			expect(matcher(kbd({ key: 'k', altKey: true }))).toBe(true);
		});

		it('does not match the right key without the modifier', () => {
			expect(matcher(kbd({ key: 'k' }))).toBe(false);
		});

		it('does not match the wrong key', () => {
			expect(matcher(kbd({ key: 'j', altKey: true }))).toBe(false);
		});
	});

	describe('bare key shortcuts (no modifiers)', () => {
		const matcher = parseActivationKey('e');

		it('matches when no modifiers are held', () => {
			expect(matcher(kbd({ key: 'e' }))).toBe(true);
		});

		it('rejects when any modifier is held', () => {
			expect(matcher(kbd({ key: 'e', ctrlKey: true }))).toBe(false);
		});
	});
});

describe('parseActivationKeyForMouse', () => {
	it('defaults to alt for a function activation key', () => {
		const matcher = parseActivationKeyForMouse(() => true);
		expect(matcher(mouse({ altKey: true }))).toBe(true);
		expect(matcher(mouse({ altKey: false }))).toBe(false);
	});

	it('matches any event when no modifiers are specified (key-only string)', () => {
		const matcher = parseActivationKeyForMouse('e');
		expect(matcher(mouse({}))).toBe(true);
	});

	it('checks all specified modifiers', () => {
		const matcher = parseActivationKeyForMouse('alt+shift');
		expect(matcher(mouse({ altKey: true, shiftKey: true }))).toBe(true);
		expect(matcher(mouse({ altKey: true }))).toBe(false);
	});

	it('ignores the non-modifier key portion for mouse events', () => {
		const matcher = parseActivationKeyForMouse('alt+k');
		expect(matcher(mouse({ altKey: true }))).toBe(true);
	});
});

describe('formatActivationKeyLabel', () => {
	it.each([
		['alt+shift+k', 'Alt + Shift + K'],
		['cmd+s', 'Cmd + S'],
		['ctrl+alt+p', 'Ctrl + Alt + P'],
		['option+e', 'Option + E'],
		['e', 'E']
	])('formats "%s" as "%s"', (input, expected) => {
		expect(formatActivationKeyLabel(input)).toBe(expected);
	});

	it('returns "Custom" for a function', () => {
		expect(formatActivationKeyLabel(() => true)).toBe('Custom');
	});
});
