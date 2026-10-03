// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { safeSerialize, getTypeDescription, inlinePreview } from '../src/lib/utils/serializer.js';

/**
 * safeSerialize returns a JSON string (pretty-printed). To assert on the
 * structured shape we parse it back where convenient.
 */
function parse(value: unknown, maxDepth?: number, maxStringLength?: number) {
	return JSON.parse(safeSerialize(value, maxDepth, maxStringLength));
}

describe('safeSerialize', () => {
	it('serializes primitives', () => {
		expect(parse(42)).toBe(42);
		expect(parse(true)).toBe(true);
		expect(parse('hello')).toBe('hello');
		expect(parse(null)).toBe(null);
	});

	it('serializes undefined as the literal string "undefined"', () => {
		// JSON.stringify(undefined) === undefined, so the function falls back.
		expect(safeSerialize(undefined)).toBe('undefined');
	});

	it('represents functions with their name', () => {
		function namedFn() {}
		expect(parse({ fn: namedFn }).fn).toBe('[Function: namedFn]');
		expect(parse({ fn: () => {} }).fn).toMatch(/^\[Function: /);
	});

	it('represents anonymous functions', () => {
		const anon = (function () {
			return function () {};
		})();
		// Strip the inferred name so it is truly anonymous-ish; either way prefixed.
		expect(parse({ fn: anon }).fn).toMatch(/^\[Function: /);
	});

	it('handles circular object references', () => {
		const obj: Record<string, unknown> = { a: 1 };
		obj.self = obj;
		const result = parse(obj);
		expect(result.a).toBe(1);
		expect(result.self).toBe('[Circular]');
	});

	it('handles circular array references', () => {
		const arr: unknown[] = [1, 2];
		arr.push(arr);
		const result = parse(arr);
		expect(result[0]).toBe(1);
		expect(result[2]).toBe('[Circular Array]');
	});

	it('serializes a Map into a { "[Map]": {...} } wrapper', () => {
		const map = new Map<string, number>([
			['a', 1],
			['b', 2]
		]);
		const result = parse({ m: map });
		expect(result.m).toEqual({ '[Map]': { a: 1, b: 2 } });
	});

	it('serializes a Set into a { "[Set]": [...] } wrapper', () => {
		const set = new Set([1, 2, 3]);
		const result = parse({ s: set });
		expect(result.s).toEqual({ '[Set]': [1, 2, 3] });
	});

	it('respects the maxDepth limit', () => {
		const deep = { a: { b: { c: { d: { e: 1 } } } } };
		const result = parse(deep, 2);
		// depth 0: deep, 1: a, 2: b, 3 (>maxDepth) -> '[max depth]'
		expect(result.a.b.c).toBe('[max depth]');
	});

	it('truncates long strings to maxStringLength with an ellipsis', () => {
		const long = 'x'.repeat(50);
		const result = parse({ s: long }, 3, 10);
		expect(result.s).toBe('xxxxxxx...');
		expect(result.s.length).toBe(10);
	});

	it('does not truncate strings at or under the limit', () => {
		const result = parse({ s: 'short' }, 3, 10);
		expect(result.s).toBe('short');
	});

	it('truncates large arrays (>20 items) to first 10 plus a summary', () => {
		const big = Array.from({ length: 25 }, (_, i) => i);
		const result = parse(big);
		expect(result.length).toBe(11);
		expect(result[10]).toBe('... (15 more items)');
	});

	it('caps object keys at 30 and notes the remainder', () => {
		const obj: Record<string, number> = {};
		for (let i = 0; i < 35; i++) obj['k' + i] = i;
		const result = parse(obj);
		expect(result['...']).toBe('(5 more keys)');
		// 30 real keys + 1 summary key
		expect(Object.keys(result).length).toBe(31);
	});

	it('serializes Date to ISO string', () => {
		const d = new Date('2026-01-01T00:00:00.000Z');
		expect(parse({ d }).d).toBe('2026-01-01T00:00:00.000Z');
	});

	it('serializes RegExp and Error', () => {
		const result = parse({ re: /abc/gi, err: new Error('boom') });
		expect(result.re).toBe('/abc/gi');
		expect(result.err).toBe('[Error: boom]');
	});

	it('serializes bigint and symbol', () => {
		expect(parse({ b: 10n }).b).toBe('10n');
		expect(parse({ s: Symbol('tag') }).s).toBe('[Symbol: tag]');
	});

	it('serializes HTMLElement to a tag+id descriptor', () => {
		const el = document.createElement('div');
		el.id = 'main';
		expect(parse({ el }).el).toBe('[div#main]');
	});
});

describe('getTypeDescription', () => {
	it('describes common types', () => {
		expect(getTypeDescription(null)).toBe('null');
		expect(getTypeDescription(undefined)).toBe('undefined');
		expect(getTypeDescription([1, 2, 3])).toBe('Array(3)');
		expect(getTypeDescription(new Map([['a', 1]]))).toBe('Map(1)');
		expect(getTypeDescription(new Set([1, 2]))).toBe('Set(2)');
		expect(getTypeDescription(new Date())).toBe('Date');
		expect(getTypeDescription(/x/)).toBe('RegExp');
		expect(getTypeDescription(new Error('e'))).toBe('Error');
		expect(getTypeDescription({ a: 1, b: 2 })).toBe('Object(2 keys)');
		expect(getTypeDescription(7)).toBe('number');
	});

	it('describes functions by name', () => {
		function foo() {}
		expect(getTypeDescription(foo)).toBe('Function(foo)');
	});
});

describe('inlinePreview', () => {
	it('quotes strings and truncates long ones', () => {
		expect(inlinePreview('hi')).toBe('"hi"');
		const long = 'a'.repeat(100);
		const out = inlinePreview(long, 10);
		expect(out.startsWith('"')).toBe(true);
		expect(out.includes('...')).toBe(true);
	});

	it('previews objects with up to 3 keys', () => {
		expect(inlinePreview({})).toBe('{}');
		expect(inlinePreview({ a: 1, b: 2 })).toBe('{ a, b }');
		expect(inlinePreview({ a: 1, b: 2, c: 3, d: 4 })).toBe('{ a, b, c, ... }');
	});

	it('previews arrays and primitives', () => {
		expect(inlinePreview([1, 2, 3])).toBe('[...] (3 items)');
		expect(inlinePreview(null)).toBe('null');
		expect(inlinePreview(undefined)).toBe('undefined');
		expect(inlinePreview(true)).toBe('true');
	});
});
