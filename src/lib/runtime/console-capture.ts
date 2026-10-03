/**
 * Console capture for the agent runtime (docs/agent-runtime-spec.md, Phase 5).
 *
 * While retained, wraps `console.error` / `console.warn` and listens to the
 * window `error` and `unhandledrejection` events, keeping the last
 * {@link CONSOLE_CAPTURE_SIZE} entries in a ring buffer. One wrapper per
 * window, shared by `ui_wait_for_hmr` (errors since an update) and `ui_verify`
 * (errors/warnings since an update): reference-counted, so the console is
 * patched once and restored on the last `release()` (runtime stop).
 *
 * Each entry carries the source location when one can be parsed from a stack
 * (the Error passed to console.error, the uncaught error, or the caller's
 * stack for a plain console call), via `utils/error-parser.ts`.
 */
import {
	filterFrames,
	findSvelteFrame,
	parseStackTrace,
	shortenFramePath
} from '../utils/error-parser.js';

export const CONSOLE_CAPTURE_SIZE = 100;
const MAX_MESSAGE_LENGTH = 1_000;

export type ConsoleLevel = 'error' | 'warn';
/** Where the entry came from. */
export type ConsoleOrigin = 'console' | 'uncaught' | 'unhandledrejection';

export interface ConsoleSource {
	/** Shortened path (`src/App.svelte`), Vite query stripped. */
	file: string;
	line: number;
	column: number;
}

export interface ConsoleEntry {
	level: ConsoleLevel;
	origin: ConsoleOrigin;
	message: string;
	source: ConsoleSource | null;
	/** Epoch ms. */
	at: number;
}

export type ConsoleListener = (entry: ConsoleEntry) => void;

export interface ConsoleCaptureOptions {
	/** Window whose console and error events are captured. Defaults to `window`. */
	target?: Window | null;
	now?: () => number;
	size?: number;
}

/** Frames of this module (the wrapper itself) never count as the source. */
const OWN_FRAME = /console-capture\.(?:ts|js)/;
/**
 * Frames with no real file: `eval` / devtools-evaluated code, e.g. Chrome's
 * `at eval (eval at evaluate (:303:30), <anonymous>:3:44)`.
 */
const NO_FILE_FRAME = /<anonymous>|^:|\), /;

/** `file:line:col` of the first useful frame of a stack, or `null`. */
export function sourceFromStack(stack: string | undefined): ConsoleSource | null {
	if (!stack) return null;
	const frames = filterFrames(parseStackTrace(stack)).filter(
		(f) => !OWN_FRAME.test(f.file) && !NO_FILE_FRAME.test(f.file)
	);
	const frame = findSvelteFrame(frames) ?? frames[0];
	if (!frame) return null;
	return { file: shortenFramePath(frame.file), line: frame.line, column: frame.column };
}

function stringifyArg(arg: unknown): string {
	if (typeof arg === 'string') return arg;
	if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
	if (arg === undefined) return 'undefined';
	if (typeof arg === 'function') return `[function ${arg.name || 'anonymous'}]`;
	if (typeof Element !== 'undefined' && arg instanceof Element) return `<${arg.localName}>`;
	try {
		return JSON.stringify(arg) ?? String(arg);
	} catch {
		return String(arg);
	}
}

/** One-line message for console args (`%c` styling args dropped). */
export function formatConsoleArgs(args: unknown[]): string {
	let parts = args;
	if (typeof args[0] === 'string' && args[0].includes('%c')) {
		const styles = (args[0].match(/%c/g) ?? []).length;
		parts = [args[0].replace(/%c/g, ''), ...args.slice(1 + styles)];
	}
	const message = parts.map(stringifyArg).join(' ').replace(/\s+/g, ' ').trim();
	return message.length > MAX_MESSAGE_LENGTH ? message.slice(0, MAX_MESSAGE_LENGTH - 1) + '…' : message;
}

function errorStack(value: unknown): string | undefined {
	return value instanceof Error && typeof value.stack === 'string' ? value.stack : undefined;
}

export class ConsoleCapture {
	private buffer: ConsoleEntry[] = [];
	private listeners = new Set<ConsoleListener>();
	private retainCount = 0;
	private cleanup: (() => void)[] = [];
	private started: number | null = null;
	private readonly opts: ConsoleCaptureOptions;

	constructor(options: ConsoleCaptureOptions = {}) {
		this.opts = options;
	}

	private get target(): Window | null {
		if (this.opts.target !== undefined) return this.opts.target;
		return typeof window === 'undefined' ? null : window;
	}

	private now(): number {
		return (this.opts.now ?? Date.now)();
	}

	/** Whether the console is currently wrapped. */
	get active(): boolean {
		return this.retainCount > 0;
	}

	/** Epoch ms when the current capture period started (first retain), or `null`. */
	get startedAt(): number | null {
		return this.started;
	}

	retain(): void {
		this.retainCount++;
		if (this.retainCount === 1) this.install();
	}

	release(): void {
		if (this.retainCount === 0) return;
		this.retainCount--;
		if (this.retainCount === 0) this.uninstall();
	}

	/** Entries with `at >= after` (all when omitted), oldest first. */
	entries(after?: number): ConsoleEntry[] {
		const list = after === undefined ? this.buffer : this.buffer.filter((e) => e.at >= after);
		return list.map((e) => ({ ...e, source: e.source ? { ...e.source } : null }));
	}

	/** Called for every new entry. Returns an unsubscribe function. */
	subscribe(listener: ConsoleListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Add an entry (the wrappers call this; also a test seam). */
	record(entry: Omit<ConsoleEntry, 'at'> & { at?: number }): ConsoleEntry {
		const full: ConsoleEntry = { ...entry, at: entry.at ?? this.now() };
		this.buffer.push(full);
		const size = this.opts.size ?? CONSOLE_CAPTURE_SIZE;
		if (this.buffer.length > size) this.buffer.splice(0, this.buffer.length - size);
		for (const listener of [...this.listeners]) {
			try {
				listener(full);
			} catch {
				// a listener must never break the page's console
			}
		}
		return full;
	}

	/** Forget every entry (tests). */
	clear(): void {
		this.buffer = [];
	}

	private install(): void {
		this.started = this.now();
		const target = this.target;
		if (!target) return;

		const onError = (event: Event) => {
			const e = event as ErrorEvent;
			const err: unknown = e.error;
			let source = sourceFromStack(errorStack(err));
			if (!source && typeof e.filename === 'string' && e.filename) {
				source = { file: shortenFramePath(e.filename), line: e.lineno || 0, column: e.colno || 0 };
			}
			const message =
				err instanceof Error
					? `Uncaught ${err.name}: ${err.message}`
					: `Uncaught ${typeof e.message === 'string' && e.message ? e.message : 'error'}`;
			this.record({ level: 'error', origin: 'uncaught', message: formatConsoleArgs([message]), source });
		};
		const onRejection = (event: Event) => {
			const reason: unknown = (event as PromiseRejectionEvent).reason;
			this.record({
				level: 'error',
				origin: 'unhandledrejection',
				message: formatConsoleArgs(['Unhandled rejection:', reason]),
				source: sourceFromStack(errorStack(reason))
			});
		};
		target.addEventListener('error', onError);
		target.addEventListener('unhandledrejection', onRejection);
		this.cleanup.push(() => {
			target.removeEventListener('error', onError);
			target.removeEventListener('unhandledrejection', onRejection);
		});

		const con = (target as unknown as { console?: Console }).console;
		if (!con) return;
		for (const level of ['error', 'warn'] as const) {
			const original = con[level];
			if (typeof original !== 'function') continue;
			let enabled = true;
			const capture = (args: unknown[]) => {
				try {
					const fromArg = args.find((a): a is Error => a instanceof Error);
					this.record({
						level,
						origin: 'console',
						message: formatConsoleArgs(args),
						source: sourceFromStack(errorStack(fromArg) ?? new Error().stack)
					});
				} catch {
					// never break the page's console
				}
			};
			const wrapped = function (this: Console, ...args: unknown[]) {
				if (enabled) capture(args);
				return original.apply(this, args);
			};
			con[level] = wrapped;
			this.cleanup.push(() => {
				enabled = false;
				// Someone patched after us: leave the (now inert) wrapper in their chain.
				if (con[level] === wrapped) con[level] = original;
			});
		}
	}

	private uninstall(): void {
		this.started = null;
		for (const fn of this.cleanup.splice(0)) {
			try {
				fn();
			} catch {
				// best effort
			}
		}
	}
}

/** The tab's capture. `startAgentRuntime` retains it while the runtime runs. */
export const consoleCapture = new ConsoleCapture();
