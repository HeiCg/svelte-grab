import { describe, it, expect } from 'vitest';
import { calculateSpecificity, compareSpecificity } from '../src/lib/utils/css-analyzer.js';

describe('calculateSpecificity - basics (non-regression)', () => {
	const cases: Array<[string, [number, number, number]]> = [
		['div', [0, 0, 1]],
		['.btn', [0, 1, 0]],
		['#main', [1, 0, 0]],
		['div.btn', [0, 1, 1]],
		['#main .btn span', [1, 1, 1]],
		['#main div span', [1, 0, 2]],
		['a:hover', [0, 1, 1]],
		['[type="text"]', [0, 1, 0]],
		['input[type="text"]', [0, 1, 1]],
		['ul > li', [0, 0, 2]],
		['h1 + p', [0, 0, 2]],
		['div::before', [0, 0, 2]] // element + pseudo-element both count as type
	];

	for (const [selector, expected] of cases) {
		it(`${selector} => ${expected.join(',')}`, () => {
			expect(calculateSpecificity(selector)).toEqual(expected);
		});
	}
});

describe('calculateSpecificity - :where() contributes 0 (bug fix)', () => {
	it(':where(.a) adds nothing', () => {
		// Previously :where counted as a class via the pseudo-class alternation.
		expect(calculateSpecificity(':where(.a)')).toEqual([0, 0, 0]);
	});

	it(':where() internals (ids, classes, types) are all ignored', () => {
		expect(calculateSpecificity(':where(#x .y div)')).toEqual([0, 0, 0]);
	});

	it('a :where() compound only counts the part outside :where', () => {
		// .btn => one class; :where(...) => 0
		expect(calculateSpecificity('.btn:where(.active, #id)')).toEqual([0, 1, 0]);
	});

	it('type selector before :where keeps its type count', () => {
		expect(calculateSpecificity('div:where(.a)')).toEqual([0, 0, 1]);
	});
});

describe('calculateSpecificity - :is()/:has() use max of args (bug fix)', () => {
	it(':is(.a, #b) takes the highest arg specificity (the id)', () => {
		// Old code: flat +1 class. New: max(.a=[0,1,0], #b=[1,0,0]) = [1,0,0].
		expect(calculateSpecificity(':is(.a, #b)')).toEqual([1, 0, 0]);
	});

	it(':is(div, span) takes a type when all args are types', () => {
		expect(calculateSpecificity(':is(div, span)')).toEqual([0, 0, 1]);
	});

	it(':has(.a) counts the inner class', () => {
		expect(calculateSpecificity('div:has(.a)')).toEqual([0, 1, 1]);
	});

	it(':has(> .child) max counts the inner class, ignoring the combinator', () => {
		expect(calculateSpecificity('ul:has(> .child)')).toEqual([0, 1, 1]);
	});

	it(':not(.a) contributes its argument (class)', () => {
		expect(calculateSpecificity('div:not(.a)')).toEqual([0, 1, 1]);
	});

	it(':not(#a, .b) takes the max argument (the id)', () => {
		expect(calculateSpecificity(':not(#a, .b)')).toEqual([1, 0, 0]);
	});
});

describe('calculateSpecificity - no double-counting of types (bug fix)', () => {
	it('a class does not also get counted as a type', () => {
		// ".btn" must be [0,1,0], not [0,1,1].
		expect(calculateSpecificity('.btn')).toEqual([0, 1, 0]);
	});

	it('a pseudo-class name is not re-counted as a type selector', () => {
		// "button:focus-visible" => 1 type (button) + 1 class (:focus-visible).
		expect(calculateSpecificity('button:focus-visible')).toEqual([0, 1, 1]);
	});

	it('functional pseudo args do not leak type counts', () => {
		// :nth-child(2n+1) => one pseudo-class, the "2n" must not count as a type.
		expect(calculateSpecificity('li:nth-child(2n+1)')).toEqual([0, 1, 1]);
	});
});

describe('compareSpecificity - WON determination still works', () => {
	it('id beats class beats type', () => {
		expect(compareSpecificity([1, 0, 0], [0, 9, 9])).toBeGreaterThan(0);
		expect(compareSpecificity([0, 1, 0], [0, 0, 9])).toBeGreaterThan(0);
	});

	it('a :where()-wrapped selector loses to a plain class', () => {
		const whereSel = calculateSpecificity(':where(.a)'); // [0,0,0]
		const classSel = calculateSpecificity('.b'); // [0,1,0]
		expect(compareSpecificity(classSel, whereSel)).toBeGreaterThan(0);
	});

	it(':is(#id) beats a plain class (max-of-args fix)', () => {
		const isSel = calculateSpecificity(':is(#id)'); // [1,0,0]
		const classSel = calculateSpecificity('.b'); // [0,1,0]
		expect(compareSpecificity(isSel, classSel)).toBeGreaterThan(0);
	});

	it('equal specificity compares to 0', () => {
		expect(compareSpecificity([0, 1, 1], [0, 1, 1])).toBe(0);
	});
});
