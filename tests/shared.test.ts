import { describe, it, expect } from 'vitest';
import {
	shortenPath,
	modifierKeyName,
	checkModifier,
	extractComponentName,
	isExcludedPath,
	DARK_THEME,
	LIGHT_THEME
} from '../src/lib/utils/shared.js';

/** Minimal event stub usable for both Mouse and Keyboard checks. */
function evt(opts: Partial<MouseEvent & KeyboardEvent>) {
	return {
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		...opts
	} as MouseEvent;
}

describe('shortenPath', () => {
	it('shortens an absolute path under /src/', () => {
		expect(shortenPath('/Users/x/project/src/lib/Foo.svelte')).toBe('src/lib/Foo.svelte');
	});

	it('shortens an absolute path under /lib/ when no /src/ present', () => {
		expect(shortenPath('/home/me/pkg/lib/Bar.ts')).toBe('lib/Bar.ts');
	});

	it('strips a leading slash from /src/ or /lib/ roots', () => {
		expect(shortenPath('/src/App.svelte')).toBe('src/App.svelte');
		expect(shortenPath('/lib/util.ts')).toBe('lib/util.ts');
	});

	it('returns the path unchanged when no marker matches', () => {
		expect(shortenPath('relative/path.ts')).toBe('relative/path.ts');
	});
});

describe('modifierKeyName', () => {
	it.each([
		['alt', 'Alt'],
		['ctrl', 'Control'],
		['meta', 'Meta'],
		['shift', 'Shift']
	])('maps "%s" -> "%s"', (mod, name) => {
		expect(modifierKeyName(mod)).toBe(name);
	});

	it('falls back to "Alt" for unknown modifiers', () => {
		expect(modifierKeyName('nope')).toBe('Alt');
	});
});

describe('checkModifier', () => {
	it('reads the matching modifier flag', () => {
		expect(checkModifier(evt({ altKey: true }), 'alt')).toBe(true);
		expect(checkModifier(evt({ ctrlKey: true }), 'ctrl')).toBe(true);
		expect(checkModifier(evt({ metaKey: true }), 'meta')).toBe(true);
		expect(checkModifier(evt({ shiftKey: true }), 'shift')).toBe(true);
	});

	it('returns false when the modifier is not held', () => {
		expect(checkModifier(evt({}), 'shift')).toBe(false);
	});

	it('falls back to altKey for an unknown modifier', () => {
		expect(checkModifier(evt({ altKey: true }), 'unknown')).toBe(true);
		expect(checkModifier(evt({ altKey: false }), 'unknown')).toBe(false);
	});
});

describe('extractComponentName', () => {
	it('extracts the component name from a .svelte path', () => {
		expect(extractComponentName('/src/lib/MyButton.svelte')).toBe('MyButton');
	});

	it('returns null for non-svelte paths', () => {
		expect(extractComponentName('/src/lib/util.ts')).toBe(null);
	});
});

describe('isExcludedPath', () => {
	it.each([
		'/proj/.svelte-kit/generated/root.js',
		'/proj/node_modules/svelte/index.js',
		'/proj/generated/thing.js',
		'/@vite/client',
		'something/__vite/deps'
	])('excludes %s', (p) => {
		expect(isExcludedPath(p)).toBe(true);
	});

	it('does not exclude regular source files', () => {
		expect(isExcludedPath('/proj/src/lib/App.svelte')).toBe(false);
	});
});

describe('theme constants', () => {
	it('exposes well-formed dark and light themes', () => {
		for (const theme of [DARK_THEME, LIGHT_THEME]) {
			expect(theme).toHaveProperty('background');
			expect(theme).toHaveProperty('border');
			expect(theme).toHaveProperty('text');
			expect(theme).toHaveProperty('accent');
		}
		expect(DARK_THEME).not.toEqual(LIGHT_THEME);
	});
});
