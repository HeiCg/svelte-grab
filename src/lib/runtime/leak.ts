/**
 * Page side of `ui_leak_check` and `ui_perf_metrics` (docs/agent-runtime-spec.md,
 * Phase 8b). Internal runtime commands driven by the MCP server, not MCP tools
 * themselves:
 *
 * - `ui_leak_track_start`: a MutationObserver (document subtree, childList)
 *   records a `WeakRef` + source (`__svelte_meta.loc`, owning component) of
 *   every element with Svelte meta that gets removed, the removed node and its
 *   whole subtree. Only `WeakRef`s and strings are kept, so tracking never
 *   retains an element itself. Replaces a running session; auto-stops after
 *   {@link LEAK_TRACK_MAX_MS}.
 * - `ui_run_actions`: performs `actions` (`{ ref, type: click|input|scroll,
 *   value? }`, the `ui_profile` action dispatch, `isTrusted=false`) in order,
 *   `iterations` times (e.g. open then close). One frame after each action, and
 *   a settle (2 frames + `waitMs`) after each iteration. With no actions it
 *   only settles once.
 * - `ui_leak_track_report`: stops tracking and reports which tracked elements
 *   are still alive (`WeakRef.deref()`) but disconnected, grouped by the source
 *   `file:line` + component of the root of their detached subtree. Meaningful after a forced GC (the server does it
 *   over CDP before calling this); without one, garbage that was simply not
 *   collected yet looks the same.
 */
import { extractComponentName, getSvelteLoc } from '../utils/component-stack.js';
import { shortenPath } from '../utils/shared.js';
import { optionalInt } from './args.js';
import { OWN_UI_SELECTOR, isInOwnUi } from './node-info.js';
import { parseActionObject, performAction, type ParsedAction } from './profile.js';
import { refRegistry, type RefRegistry } from './refs.js';
import type { RuntimeToolResult } from './types.js';

/** Command names; must match src/mcp/runtime/cdp-tools.ts. */
export const LEAK_TRACK_START_TOOL = 'ui_leak_track_start';
export const LEAK_TRACK_REPORT_TOOL = 'ui_leak_track_report';
export const RUN_ACTIONS_TOOL = 'ui_run_actions';

/** Cap on tracked elements (bounds memory). */
export const MAX_TRACKED_ELEMENTS = 20_000;
/** A forgotten session stops itself after this long. */
export const LEAK_TRACK_MAX_MS = 120_000;
/** `ui_run_actions` limits; must match src/mcp/runtime/cdp-tools.ts. */
export const MAX_RUN_ITERATIONS = 20;
export const MAX_RUN_ACTIONS = 10;
export const DEFAULT_SETTLE_MS = 300;
export const MAX_SETTLE_MS = 5_000;
/** Groups listed in the report text. */
const MAX_TEXT_GROUPS = 15;
/** A frame wait never blocks longer than this (hidden tabs do not paint). */
const FRAME_FALLBACK_MS = 100;

interface WeakElementRef {
	deref(): Element | undefined;
}

interface TrackedElement {
	element: WeakElementRef;
	file: string;
	line: number;
	component: string | null;
}

/** Elements of one source location still alive and detached. */
export interface RetainedGroup extends Record<string, unknown> {
	component: string | null;
	file: string;
	line: number;
	/** `file:line` with the file shortened (`src/...`). */
	source: string;
	/** Retained elements (with Svelte meta) in subtrees rooted here. */
	count: number;
	/** Detached subtrees (roots) rooted at this source, e.g. one per leaked instance. */
	roots: number;
}

export interface LeakReport {
	/** Svelte-meta elements removed while tracking. */
	tracked: number;
	/** Of those, still alive and disconnected. */
	retained: number;
	groups: RetainedGroup[];
	/** The cap was hit; later removals were not tracked. */
	truncated: boolean;
	durationMs: number;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function weakRef(el: Element): WeakElementRef {
	if (typeof WeakRef !== 'function')
		throw new Error('Leak tracking needs WeakRef (not available in this browser)');
	return new WeakRef(el);
}

/** Records removed Svelte-meta elements as WeakRefs. */
export class LeakTracker {
	private observer: MutationObserver | null = null;
	private tracked: TrackedElement[] = [];
	private seen = new WeakSet<Element>();
	private truncated = false;
	private startedAt = 0;

	constructor(private readonly doc: Document = document) {}

	get running(): boolean {
		return this.observer !== null;
	}

	get size(): number {
		return this.tracked.length;
	}

	start(): void {
		this.stop();
		const MO = this.doc.defaultView?.MutationObserver ?? MutationObserver;
		this.observer = new MO((records) => this.record(records));
		this.observer.observe(this.doc.documentElement, { childList: true, subtree: true });
		this.startedAt = now();
	}

	/** Stop observing (pending records are processed first). */
	stop(): void {
		if (!this.observer) return;
		this.record(this.observer.takeRecords());
		this.observer.disconnect();
		this.observer = null;
	}

	/**
	 * Stop and report the tracked elements still alive but disconnected. Each
	 * one is grouped under the top of its detached subtree (the element whose
	 * reference keeps the rest alive), keyed by that root's source; elements
	 * of a root without Svelte meta fall back to their own source.
	 */
	report(): LeakReport {
		this.stop();
		const byElement = new Map<Element, TrackedElement>();
		const alive: [Element, TrackedElement][] = [];
		for (const t of this.tracked) {
			const el = t.element.deref();
			if (!el || el.isConnected) continue;
			byElement.set(el, t);
			alive.push([el, t]);
		}
		const groups = new Map<string, RetainedGroup & { rootSet: Set<Element> }>();
		for (const [el, own] of alive) {
			let top: Element = el;
			while (top.parentElement) top = top.parentElement;
			const rootInfo = byElement.get(top) ?? rootSource(top) ?? own;
			const key = `${rootInfo.file}:${rootInfo.line}`;
			let group = groups.get(key);
			if (!group) {
				group = {
					component: rootInfo.component,
					file: shortenPath(rootInfo.file),
					line: rootInfo.line,
					source: `${shortenPath(rootInfo.file)}:${rootInfo.line}`,
					count: 0,
					roots: 0,
					rootSet: new Set()
				};
				groups.set(key, group);
			}
			group.count++;
			group.rootSet.add(top);
		}
		const list: RetainedGroup[] = [...groups.values()].map(({ rootSet, ...g }) => ({
			...g,
			roots: rootSet.size
		}));
		return {
			tracked: this.tracked.length,
			retained: alive.length,
			groups: list.sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)),
			truncated: this.truncated,
			durationMs: Math.round(now() - this.startedAt)
		};
	}

	private record(records: MutationRecord[]): void {
		for (const record of records) {
			if (record.removedNodes.length === 0) continue;
			const target = record.target;
			if (target.nodeType === 1 && isInOwnUi(target as Element)) continue;
			for (const node of Array.from(record.removedNodes)) {
				if (node.nodeType !== 1) continue;
				const el = node as Element;
				if (el.closest(OWN_UI_SELECTOR)) continue;
				this.add(el);
				for (const child of Array.from(el.querySelectorAll('*'))) this.add(child);
			}
		}
	}

	private add(el: Element): void {
		if (this.seen.has(el)) return;
		this.seen.add(el);
		const loc = getSvelteLoc(el);
		if (!loc) return;
		if (this.tracked.length >= MAX_TRACKED_ELEMENTS) {
			this.truncated = true;
			return;
		}
		this.tracked.push({
			element: weakRef(el),
			file: loc.file,
			line: loc.line,
			component: extractComponentName(loc.file)
		});
	}
}

function rootSource(el: Element): Pick<TrackedElement, 'file' | 'line' | 'component'> | null {
	const loc = getSvelteLoc(el);
	return loc ? { file: loc.file, line: loc.line, component: extractComponentName(loc.file) } : null;
}

let active: { tracker: LeakTracker; timer: ReturnType<typeof setTimeout> } | null = null;

function stopActive(): LeakTracker | null {
	if (!active) return null;
	const { tracker, timer } = active;
	clearTimeout(timer);
	active = null;
	tracker.stop();
	return tracker;
}

/** `ui_leak_track_start`: start (or restart) recording removed Svelte elements. */
export function uiLeakTrackStart(
	_args: Record<string, unknown> = {},
	doc: Document = document
): RuntimeToolResult {
	const restarted = stopActive() !== null;
	const tracker = new LeakTracker(doc);
	tracker.start();
	const timer = setTimeout(() => {
		if (active?.tracker === tracker) stopActive();
	}, LEAK_TRACK_MAX_MS);
	active = { tracker, timer };
	return {
		text: `Leak tracking started${restarted ? ' (previous session discarded)' : ''}: recording removed Svelte elements as WeakRefs.`,
		data: { tracking: true, restarted }
	};
}

/** `ui_leak_track_report`: stop tracking; elements still alive and detached, grouped by source. */
export function uiLeakTrackReport(): RuntimeToolResult {
	const tracker = active?.tracker;
	if (!tracker) throw new Error('No leak tracking session: call ui_leak_track_start first');
	const report = tracker.report();
	stopActive();
	const lines = [
		`${report.retained} of ${report.tracked} removed Svelte elements still alive and detached` +
			(report.truncated ? ` (tracking capped at ${MAX_TRACKED_ELEMENTS})` : '')
	];
	for (const g of report.groups.slice(0, MAX_TEXT_GROUPS)) {
		lines.push(
			`  ${g.component ?? '?'} ${g.source} ${g.count} element${g.count === 1 ? '' : 's'} in ${g.roots} subtree${g.roots === 1 ? '' : 's'}`
		);
	}
	if (report.groups.length > MAX_TEXT_GROUPS)
		lines.push(`  ... ${report.groups.length - MAX_TEXT_GROUPS} more locations`);
	return { text: lines.join('\n'), data: { ...report } };
}

/** Test seam: whether a session is running. */
export function isLeakTracking(): boolean {
	return active !== null;
}

export interface RunActionsOptions {
	registry?: RefRegistry;
	sleep?: (ms: number) => Promise<void>;
	/** Waits one frame (test seam). */
	frame?: () => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function defaultFrame(): Promise<void> {
	return new Promise<void>((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			resolve();
		};
		if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => finish());
		setTimeout(finish, FRAME_FALLBACK_MS);
	});
}

function parseActions(args: Record<string, unknown>): ParsedAction[] {
	const raw = args.actions;
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) throw new Error('"actions" must be an array of { ref, type, value? }');
	if (raw.length > MAX_RUN_ACTIONS)
		throw new Error(`"actions" takes at most ${MAX_RUN_ACTIONS} actions per iteration`);
	return raw.map((a, i) => parseActionObject(a, `actions[${i}]`));
}

/** `ui_run_actions`: perform the actions `iterations` times, settling after each iteration. */
export async function uiRunActions(
	args: Record<string, unknown>,
	options: RunActionsOptions = {}
): Promise<RuntimeToolResult> {
	const registry = options.registry ?? refRegistry;
	const sleep = options.sleep ?? defaultSleep;
	const frame = options.frame ?? defaultFrame;
	const actions = parseActions(args);
	const iterations = optionalInt(args, 'iterations', 1, 1, MAX_RUN_ITERATIONS);
	const waitMs = optionalInt(args, 'waitMs', DEFAULT_SETTLE_MS, 0, MAX_SETTLE_MS);

	// Fail fast on refs that do not resolve at all, before anything runs.
	for (const [i, action] of actions.entries()) {
		if (!registry.resolve(action.ref)) {
			throw new Error(
				`Unknown ref "${action.ref}" in actions[${i}]: the element is gone or the ref is invalid. Run ui_find or ui_snapshot for fresh refs.`
			);
		}
	}

	const settle = async () => {
		await frame();
		await frame();
		if (waitMs > 0) await sleep(waitMs);
	};

	let performed = 0;
	const skipped: string[] = [];
	const rebound = new Set<string>();
	const runs = actions.length > 0 ? iterations : 1;
	for (let it = 0; it < runs; it++) {
		for (const [i, action] of actions.entries()) {
			const resolved = registry.resolve(action.ref);
			const label = `iteration ${it + 1}, actions[${i}]`;
			if (!resolved) {
				skipped.push(`${label}: ref ${action.ref} no longer resolves`);
				continue;
			}
			if (resolved.rebound) rebound.add(`${action.ref} -> ${resolved.ref}`);
			try {
				performAction(resolved.element, action);
				performed++;
			} catch (err) {
				skipped.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
			}
			await Promise.resolve();
			await frame();
		}
		await settle();
	}

	const described = actions.map((a) => `${a.type} ${a.ref}`).join(' -> ');
	const lines = [
		actions.length > 0
			? `Ran ${iterations} iteration${iterations === 1 ? '' : 's'} of [${described}]: ${performed} action${performed === 1 ? '' : 's'} performed (isTrusted=false), settled 2 frames + ${waitMs}ms after each`
			: `No actions; settled 2 frames + ${waitMs}ms`
	];
	if (rebound.size > 0) lines.push(`rebound: ${[...rebound].join(', ')}`);
	for (const s of skipped.slice(0, 10)) lines.push(`skipped ${s}`);
	return {
		text: lines.join('\n'),
		data: {
			iterations: actions.length > 0 ? iterations : 0,
			actions: actions.map((a) => ({
				ref: a.ref,
				type: a.type,
				...(a.value !== undefined ? { value: a.value } : {})
			})),
			performed,
			expected: actions.length * (actions.length > 0 ? iterations : 0),
			skipped,
			waitMs,
			isTrusted: false
		}
	};
}
