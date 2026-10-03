import { describe, it, expect } from 'vitest';
import { parseStackTrace } from '../src/lib/utils/error-parser.js';

/**
 * Parse a single line via the public parseStackTrace entry point and return the
 * single resulting frame (or undefined when the line is unparseable).
 */
function parseLine(line: string) {
	return parseStackTrace(line)[0];
}

describe('parseStackTrace - Chrome format (non-regression)', () => {
	it('parses "at fn (file:line:col)"', () => {
		const f = parseLine('    at handleClick (https://localhost:5173/src/App.svelte:42:13)');
		expect(f).toEqual({
			functionName: 'handleClick',
			file: 'https://localhost:5173/src/App.svelte',
			line: 42,
			column: 13
		});
	});

	it('parses an anonymous Chrome frame "at file:line:col"', () => {
		const f = parseLine('    at https://localhost:5173/src/main.ts:1:20');
		expect(f).toEqual({
			functionName: '(anonymous)',
			file: 'https://localhost:5173/src/main.ts',
			line: 1,
			column: 20
		});
	});

	it('keeps the port colon in the host as part of the file path', () => {
		const f = parseLine('    at fn (http://127.0.0.1:3000/a.js:5:6)');
		expect(f?.file).toBe('http://127.0.0.1:3000/a.js');
		expect(f?.line).toBe(5);
		expect(f?.column).toBe(6);
	});
});

describe('parseStackTrace - Firefox/Safari format (non-regression)', () => {
	it('parses "fn@file:line:col"', () => {
		const f = parseLine('handleClick@https://localhost:5173/src/App.svelte:42:13');
		expect(f).toEqual({
			functionName: 'handleClick',
			file: 'https://localhost:5173/src/App.svelte',
			line: 42,
			column: 13
		});
	});

	it('parses a bare "file:line:col" with no function name', () => {
		const f = parseLine('https://localhost:5173/src/main.ts:10:5');
		expect(f).toEqual({
			functionName: '(anonymous)',
			file: 'https://localhost:5173/src/main.ts',
			line: 10,
			column: 5
		});
	});

	it('parses an empty-function Firefox frame "@file:line:col"', () => {
		const f = parseLine('@https://localhost:5173/src/x.js:3:4');
		expect(f).toEqual({
			functionName: '(anonymous)',
			file: 'https://localhost:5173/src/x.js',
			line: 3,
			column: 4
		});
	});
});

describe('parseStackTrace - bug fix: @ in the path', () => {
	it('does NOT mis-split a bare URL whose path contains @', () => {
		// Regression target: lastIndexOf('@') / non-greedy "(.+?)@" would split the
		// URL at the '@' inside the path. The location must be anchored at the end.
		const f = parseLine('https://h/a@b.js:1:2');
		expect(f).toEqual({
			functionName: '(anonymous)',
			file: 'https://h/a@b.js',
			line: 1,
			column: 2
		});
	});

	it('keeps an @ inside the path when a real function name is present', () => {
		const f = parseLine('render@https://cdn/pkg@2.0.0/dist/index.js:120:9');
		expect(f).toEqual({
			functionName: 'render',
			file: 'https://cdn/pkg@2.0.0/dist/index.js',
			line: 120,
			column: 9
		});
	});

	it('handles a scoped package path with @ in Chrome format', () => {
		const f = parseLine('    at init (https://h/@scope/pkg/index.js:3:4)');
		expect(f).toEqual({
			functionName: 'init',
			file: 'https://h/@scope/pkg/index.js',
			line: 3,
			column: 4
		});
	});
});

describe('parseStackTrace - bug fix: spaces / parens in the path', () => {
	it('keeps spaces in the Chrome file path (location anchored at end)', () => {
		const f = parseLine('    at fn (webpack://./my file.js:3:4)');
		expect(f).toEqual({
			functionName: 'fn',
			file: 'webpack://./my file.js',
			line: 3,
			column: 4
		});
	});

	it('keeps a space-containing path in the Firefox format', () => {
		const f = parseLine('doThing@/Users/me/my project/app.js:8:2');
		expect(f).toEqual({
			functionName: 'doThing',
			file: '/Users/me/my project/app.js',
			line: 8,
			column: 2
		});
	});
});

describe('parseStackTrace - general behavior', () => {
	it('parses a multi-line stack and preserves order', () => {
		const stack = [
			'Error: boom',
			'    at a (https://h/a.js:1:1)',
			'    at b (https://h/b.js:2:2)'
		].join('\n');
		const frames = parseStackTrace(stack);
		// "Error: boom" is not a frame; only the two `at` lines parse.
		expect(frames.map((f) => f.functionName)).toEqual(['a', 'b']);
		expect(frames.map((f) => f.line)).toEqual([1, 2]);
	});

	it('returns [] for empty input', () => {
		expect(parseStackTrace('')).toEqual([]);
	});

	it('ignores lines without a trailing :line:col location', () => {
		expect(parseStackTrace('just some prose with no location')).toEqual([]);
	});
});
