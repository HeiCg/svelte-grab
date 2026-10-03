import { describe, it, expect } from 'vitest';
import { overflowAxes } from '../src/lib/utils/overflow';

describe('overflowAxes', () => {
	it('uses the longhands when the DOM expands the shorthand (browsers)', () => {
		expect(
			overflowAxes({ overflow: 'hidden auto', overflowX: 'hidden', overflowY: 'auto' })
		).toEqual({
			x: 'hidden',
			y: 'auto'
		});
	});

	it('falls back to the shorthand when longhands stay visible (jsdom)', () => {
		expect(
			overflowAxes({ overflow: 'hidden', overflowX: 'visible', overflowY: 'visible' })
		).toEqual({
			x: 'hidden',
			y: 'hidden'
		});
		expect(overflowAxes({ overflow: 'clip scroll', overflowX: '', overflowY: '' })).toEqual({
			x: 'clip',
			y: 'scroll'
		});
	});

	it('defaults to visible', () => {
		expect(overflowAxes({ overflow: '', overflowX: '', overflowY: '' })).toEqual({
			x: 'visible',
			y: 'visible'
		});
	});
});
