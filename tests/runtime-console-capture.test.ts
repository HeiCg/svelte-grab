// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	CONSOLE_CAPTURE_SIZE,
	ConsoleCapture,
	formatConsoleArgs,
	sourceFromStack
} from '../src/lib/runtime/console-capture.js';

let clock = 1_000;
let capture: ConsoleCapture;
let originalError: typeof console.error;
let originalWarn: typeof console.warn;
let errorSpy: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	clock = 1_000;
	originalError = console.error;
	originalWarn = console.warn;
	errorSpy = vi.fn();
	warnSpy = vi.fn();
	console.error = errorSpy;
	console.warn = warnSpy;
	capture = new ConsoleCapture({ target: window, now: () => clock });
});

afterEach(() => {
	while (capture.active) capture.release();
	console.error = originalError;
	console.warn = originalWarn;
});

const CHROME_STACK = [
	'TypeError: Cannot read properties of undefined',
	'    at ConsoleCapture.wrapped (http://localhost:5173/@fs/repo/src/lib/runtime/console-capture.ts:180:20)',
	'    at handler (http://localhost:5173/node_modules/.vite/deps/svelte.js?v=1:10:5)',
	'    at onclick (http://localhost:5173/src/components/Card.svelte?t=123:22:14)',
	'    at main (http://localhost:5173/src/main.ts:3:1)'
].join('\n');

describe('sourceFromStack', () => {
	it('skips own frames and node_modules, prefers a .svelte frame, strips host and query', () => {
		expect(sourceFromStack(CHROME_STACK)).toEqual({ file: 'src/components/Card.svelte', line: 22, column: 14 });
	});

	it('falls back to the first useful frame, null without one', () => {
		expect(sourceFromStack('Error\n    at main (http://localhost:5173/src/main.ts:3:1)')).toEqual({
			file: 'src/main.ts',
			line: 3,
			column: 1
		});
		expect(sourceFromStack(undefined)).toBeNull();
		// Code evaluated by devtools / Playwright has no file.
		expect(
			sourceFromStack('Error\n    at eval (eval at evaluate (:303:30), <anonymous>:3:44)\n    at <anonymous>:1:2')
		).toBeNull();
		expect(sourceFromStack('Error: no frames')).toBeNull();
	});
});

describe('formatConsoleArgs', () => {
	it('joins args, formats errors and objects, drops %c styles', () => {
		expect(formatConsoleArgs(['a', 1, { b: 2 }])).toBe('a 1 {"b":2}');
		expect(formatConsoleArgs([new TypeError('bad')])).toBe('TypeError: bad');
		expect(formatConsoleArgs(['%cstyled%c text', 'color:red', 'color:blue', 'tail'])).toBe('styled text tail');
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(formatConsoleArgs([cyclic])).toBe('[object Object]');
	});

	it('caps long messages', () => {
		const out = formatConsoleArgs(['x'.repeat(5_000)]);
		expect(out.length).toBe(1_000);
		expect(out.endsWith('…')).toBe(true);
	});
});

describe('ConsoleCapture', () => {
	it('wraps console.error/warn once while retained, forwards calls, restores on last release', () => {
		capture.retain();
		capture.retain();
		const wrappedError = console.error;
		expect(wrappedError).not.toBe(errorSpy);

		console.error('boom', 42);
		console.warn('careful');
		expect(errorSpy).toHaveBeenCalledWith('boom', 42);
		expect(warnSpy).toHaveBeenCalledWith('careful');
		expect(capture.entries()).toMatchObject([
			{ level: 'error', origin: 'console', message: 'boom 42', at: 1_000 },
			{ level: 'warn', origin: 'console', message: 'careful', at: 1_000 }
		]);

		capture.release();
		expect(console.error).toBe(wrappedError);
		capture.release();
		expect(console.error).toBe(errorSpy);
		expect(console.warn).toBe(warnSpy);

		console.error('after');
		expect(capture.entries()).toHaveLength(2);
	});

	it('takes the source from an Error argument', () => {
		capture.retain();
		const err = new TypeError('Cannot read properties of undefined');
		err.stack = CHROME_STACK;
		console.error('render failed', err);
		expect(capture.entries()[0]).toMatchObject({
			message: 'render failed TypeError: Cannot read properties of undefined',
			source: { file: 'src/components/Card.svelte', line: 22, column: 14 }
		});
	});

	it('captures uncaught errors and unhandled rejections', () => {
		capture.retain();
		const err = new Error('kaput');
		err.stack = CHROME_STACK;
		window.dispatchEvent(new ErrorEvent('error', { error: err, message: 'kaput' }));
		window.dispatchEvent(
			new ErrorEvent('error', { message: 'Script error', filename: 'http://localhost:5173/src/App.svelte?t=1', lineno: 7, colno: 3 })
		);
		const rejection = new Event('unhandledrejection') as Event & { reason?: unknown };
		rejection.reason = new Error('nope');
		window.dispatchEvent(rejection);

		const entries = capture.entries();
		expect(entries).toHaveLength(3);
		expect(entries[0]).toMatchObject({ level: 'error', origin: 'uncaught', message: 'Uncaught Error: kaput', source: { file: 'src/components/Card.svelte', line: 22 } });
		expect(entries[1]).toMatchObject({ origin: 'uncaught', message: 'Uncaught Script error', source: { file: 'src/App.svelte', line: 7, column: 3 } });
		expect(entries[2]).toMatchObject({ origin: 'unhandledrejection', message: 'Unhandled rejection: Error: nope' });

		capture.release();
		window.dispatchEvent(new ErrorEvent('error', { message: 'after release' }));
		expect(capture.entries()).toHaveLength(3);
	});

	it(`keeps a ring buffer of the last ${CONSOLE_CAPTURE_SIZE} entries and filters by time`, () => {
		capture.retain();
		for (let i = 0; i < CONSOLE_CAPTURE_SIZE + 10; i++) {
			clock = 2_000 + i;
			console.warn(`w${i}`);
		}
		const all = capture.entries();
		expect(all).toHaveLength(CONSOLE_CAPTURE_SIZE);
		expect(all[0].message).toBe('w10');
		expect(capture.entries(2_000 + CONSOLE_CAPTURE_SIZE + 5).map((e) => e.message)).toEqual([
			`w${CONSOLE_CAPTURE_SIZE + 5}`,
			`w${CONSOLE_CAPTURE_SIZE + 6}`,
			`w${CONSOLE_CAPTURE_SIZE + 7}`,
			`w${CONSOLE_CAPTURE_SIZE + 8}`,
			`w${CONSOLE_CAPTURE_SIZE + 9}`
		]);
	});

	it('notifies subscribers, tracks startedAt per capture period', () => {
		expect(capture.startedAt).toBeNull();
		clock = 5_000;
		capture.retain();
		expect(capture.startedAt).toBe(5_000);
		const seen: string[] = [];
		const off = capture.subscribe((e) => seen.push(`${e.level}:${e.message}`));
		console.error('a');
		off();
		console.error('b');
		expect(seen).toEqual(['error:a']);
		capture.release();
		expect(capture.startedAt).toBeNull();
	});

	it('leaves a later patcher in place on release (inert wrapper stays in their chain)', () => {
		capture.retain();
		const ours = console.error;
		const later = vi.fn((...args: unknown[]) => ours(...args));
		console.error = later;
		capture.release();
		expect(console.error).toBe(later);
		console.error('x');
		expect(errorSpy).toHaveBeenCalledWith('x');
		expect(capture.entries()).toHaveLength(0);
	});
});
