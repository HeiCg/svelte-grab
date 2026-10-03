/**
 * HMR awareness for the agent runtime (docs/agent-runtime-spec.md, Phase 4).
 *
 * Event sources, best first:
 *
 * 1. `vite-hmr`: `import.meta.hot` of this module. Vite injects it into every
 *    module it serves in dev that mentions `import.meta.hot`, including
 *    pre-bundled dependencies (see the spec's Phase 4 notes).
 * 2. `plugin`: the `svelte-grab/vite` plugin's client module forwards the same
 *    Vite events as `svelte-grab:hmr` window CustomEvents. Used only when (1)
 *    is unavailable, so events are never counted twice.
 * 3. `heuristic`: neither is reachable. `ui_wait_for_hmr` then resolves on the
 *    next burst of DOM mutations, with an empty file list.
 *
 * The tracker keeps a ring buffer of the last {@link HMR_LOG_SIZE} updates
 * (persisted in sessionStorage so a full reload keeps its record) and counts
 * console errors since the latest update, read from the shared
 * {@link ConsoleCapture} (it never wraps the console itself).
 */
import { optionalInt } from './args.js';
import { ConsoleCapture, consoleCapture } from './console-capture.js';
import { isInOwnUi } from './node-info.js';
import { refRegistry, type RebindReport, type RefRegistry } from './refs.js';
import type { RuntimeToolResult } from './types.js';
import {
	HMR_BRIDGE_EVENT,
	getVitePluginInfo,
	type HmrBridgeDetail
} from '../utils/vite-plugin-info.js';

export const HMR_LOG_SIZE = 20;
export const HMR_LOG_STORAGE_KEY = 'svelte-grab-hmr-log';
export const DEFAULT_HMR_TIMEOUT_MS = 15_000;
export const MAX_HMR_TIMEOUT_MS = 55_000;
/** Quiet period that ends a DOM-mutation burst (heuristic source). */
export const HEURISTIC_QUIET_MS = 150;
/** Upper bound on waiting for an animation frame (hidden tabs never paint). */
const FRAME_FALLBACK_MS = 100;
/** How long a full reload is held so a pending result can still be posted. */
export const FULL_RELOAD_HOLD_MS = 250;
const MAX_FILES_PER_RECORD = 50;
const MAX_ERROR_LENGTH = 2_000;

export type HmrSource = 'vite-hmr' | 'plugin' | 'heuristic';
export type HmrRecordKind = 'update' | 'full-reload' | 'error';

export interface HmrRecord {
	kind: HmrRecordKind;
	/** Epoch ms when the update finished applying (or the error/reload arrived). */
	at: number;
	/**
	 * Epoch ms of the matching `vite:beforeUpdate` (updates only): console
	 * errors raised while the new modules run land between this and `at`.
	 */
	startedAt?: number;
	/** Updated files, as Vite reports them (root-relative `/src/...`, no query). */
	files: string[];
	/** `vite:error` messages. */
	errors: string[];
	/** Console errors seen since this record (until the next one). */
	consoleErrors: number;
	source: HmrSource;
}

/** Structural subset of Vite's `ViteHotContext`. */
export interface HotContextLike {
	on(event: string, cb: (payload: unknown) => unknown): void;
	off?(event: string, cb: (payload: unknown) => unknown): void;
}

/** `import.meta.hot`, when Vite served this module in dev; `undefined` otherwise. */
function getImportMetaHot(): HotContextLike | undefined {
	try {
		// Must stay the literal `import.meta.hot`: Vite only injects the hot
		// context into modules whose source contains that exact expression.
		// @ts-expect-error -- `hot` is Vite's ImportMeta augmentation (vite/client types).
		return import.meta.hot as HotContextLike | undefined;
	} catch {
		return undefined;
	}
}

const VITE_EVENTS = [
	'vite:beforeUpdate',
	'vite:afterUpdate',
	'vite:beforeFullReload',
	'vite:error'
] as const;

/** Strip `/@fs`, query and hash; forward slashes; no leading `./`. */
export function normalizeHmrPath(path: string): string {
	let p = String(path).replace(/\\/g, '/');
	p = p.replace(/[?#].*$/, '');
	if (p.startsWith('/@fs/')) p = p.slice(4);
	if (p.startsWith('./')) p = p.slice(2);
	return p;
}

/**
 * Boundary-aware suffix match in both directions, so `Card.svelte`,
 * `src/lib/Card.svelte` and `/abs/project/src/lib/Card.svelte` all match the
 * update path `/src/lib/Card.svelte`, but `Card.svelte` does not match
 * `FixtureCard.svelte`.
 */
export function hmrPathMatches(updatePath: string, wanted: string): boolean {
	const a = normalizeHmrPath(updatePath).replace(/^\/+/, '');
	const b = normalizeHmrPath(wanted).replace(/^\/+/, '');
	if (!a || !b) return false;
	return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** Whether a record satisfies a `files` filter (no filter: anything does). */
export function recordMatches(record: HmrRecord, files: readonly string[] | undefined): boolean {
	if (!files || files.length === 0) return true;
	// A full reload replaces the page whatever triggered it; an error without a
	// file is surfaced rather than waited past.
	if (record.kind === 'full-reload' || record.files.length === 0) return true;
	return record.files.some((f) => files.some((w) => hmrPathMatches(f, w)));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function capFiles(files: string[]): string[] {
	return Array.from(new Set(files.map(normalizeHmrPath).filter(Boolean))).slice(
		0,
		MAX_FILES_PER_RECORD
	);
}

function updateFiles(payload: unknown): string[] {
	if (!isObject(payload) || !Array.isArray(payload.updates)) return [];
	const out: string[] = [];
	for (const u of payload.updates) {
		if (isObject(u) && typeof u.path === 'string') out.push(u.path);
	}
	return capFiles(out);
}

function errorRecordParts(payload: unknown): { files: string[]; message: string } {
	const err = isObject(payload) && isObject(payload.err) ? payload.err : {};
	const loc = isObject(err.loc) ? err.loc : {};
	const file =
		typeof err.id === 'string' ? err.id : typeof loc.file === 'string' ? loc.file : '';
	let message = typeof err.message === 'string' ? err.message : 'Unknown Vite error';
	if (typeof err.plugin === 'string') message = `[${err.plugin}] ${message}`;
	if (file && !message.includes(file)) {
		const line = typeof loc.line === 'number' ? `:${loc.line}` : '';
		message = `${message} (${normalizeHmrPath(file)}${line})`;
	}
	return {
		files: file ? capFiles([file]) : [],
		message: message.slice(0, MAX_ERROR_LENGTH)
	};
}

function reloadFiles(payload: unknown): string[] {
	if (!isObject(payload)) return [];
	if (typeof payload.triggeredBy === 'string') return capFiles([payload.triggeredBy]);
	if (typeof payload.path === 'string' && payload.path !== '*') return capFiles([payload.path]);
	return [];
}

interface Waiter {
	after: number;
	files: string[] | undefined;
	resolve: (record: HmrRecord) => void;
}

export interface WaitForOptions {
	/** Only records with `at >= after` count. */
	after: number;
	files?: string[];
	timeoutMs: number;
}

export interface HmrTrackerOptions {
	/** Defaults to this module's `import.meta.hot`; `null` forces it off. */
	hot?: HotContextLike | null;
	/** Window for the plugin bridge events. Defaults to `window`. */
	target?: Window | null;
	/**
	 * Console capture errors are counted from. Defaults to the tab's shared
	 * `consoleCapture`, or a private one for `target` when `target` is given;
	 * `null` disables counting.
	 */
	capture?: ConsoleCapture | null;
	/** Defaults to `sessionStorage`; `null` disables persistence. */
	storage?: Storage | null;
	now?: () => number;
	/** Plugin marker lookup (test seam). */
	pluginInfo?: () => { hmrBridge: boolean } | null;
	/** Document observed by the heuristic source. Defaults to `document`. */
	doc?: () => Document | null;
}

/**
 * Collects Vite HMR events. Reference-counted: every `retain()` needs a
 * `release()`; listeners are installed on the first retain and removed on the
 * last release.
 */
export class HmrTracker {
	private records: HmrRecord[] = [];
	private waiters = new Set<Waiter>();
	private retainCount = 0;
	private pending: { files: string[]; at: number } | null = null;
	private bridgeSeen = false;
	private cleanup: (() => void)[] = [];
	private loaded = false;
	private readonly opts: HmrTrackerOptions;
	private readonly capture: ConsoleCapture | null;

	constructor(options: HmrTrackerOptions = {}) {
		this.opts = options;
		this.capture =
			options.capture !== undefined
				? options.capture
				: options.target !== undefined
					? new ConsoleCapture({ target: options.target })
					: consoleCapture;
	}

	private get hot(): HotContextLike | null {
		return this.opts.hot === undefined ? (getImportMetaHot() ?? null) : this.opts.hot;
	}

	private get target(): Window | null {
		if (this.opts.target !== undefined) return this.opts.target;
		return typeof window === 'undefined' ? null : window;
	}

	private now(): number {
		return (this.opts.now ?? Date.now)();
	}

	get active(): boolean {
		return this.retainCount > 0;
	}

	/** Which source `ui_wait_for_hmr` relies on right now. */
	get source(): HmrSource {
		if (this.hot) return 'vite-hmr';
		const info = this.opts.pluginInfo ? this.opts.pluginInfo() : getVitePluginInfo();
		if (this.bridgeSeen || info?.hmrBridge) return 'plugin';
		return 'heuristic';
	}

	/** Copy of the ring buffer, oldest first. */
	log(): HmrRecord[] {
		this.load();
		return this.records.map((r) => ({ ...r, files: [...r.files], errors: [...r.errors] }));
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

	/** Records with `at >= after` that match `files`, oldest first. */
	since(after: number, files?: readonly string[]): HmrRecord[] {
		this.load();
		return this.records.filter((r) => r.at >= after && recordMatches(r, files));
	}

	/**
	 * The first matching record at or after `after`. With the heuristic source it
	 * resolves on the next DOM-mutation burst instead. Rejects on timeout.
	 */
	waitFor(options: WaitForOptions): Promise<HmrRecord> {
		const existing = this.since(options.after, options.files);
		if (existing.length > 0) return Promise.resolve(existing[existing.length - 1]);
		if (this.source === 'heuristic') return this.waitForMutations(options.timeoutMs);

		return new Promise<HmrRecord>((resolve, reject) => {
			const waiter: Waiter = {
				after: options.after,
				files: options.files,
				resolve: (record) => {
					clearTimeout(timer);
					this.waiters.delete(waiter);
					resolve(record);
				}
			};
			const timer = setTimeout(() => {
				this.waiters.delete(waiter);
				reject(new Error(this.timeoutText(options)));
			}, options.timeoutMs);
			this.waiters.add(waiter);
		});
	}

	/** Number of pending `waitFor` calls (tests). */
	get waiterCount(): number {
		return this.waiters.size;
	}

	/**
	 * Feed one Vite event. Returns a promise when the caller (the Vite client)
	 * should hold off briefly, i.e. a full reload with a waiter to answer.
	 */
	ingest(type: string, payload: unknown, source: HmrSource): Promise<void> | undefined {
		switch (type) {
			case 'vite:beforeUpdate':
				this.pending = { files: updateFiles(payload), at: this.now() };
				return undefined;
			case 'vite:afterUpdate': {
				const files = updateFiles(payload);
				const at = this.now();
				const startedAt = this.pending ? Math.min(this.pending.at, at) : at;
				this.pending = null;
				this.push({ kind: 'update', at, startedAt, files, errors: [], consoleErrors: 0, source });
				return undefined;
			}
			case 'vite:error': {
				const { files, message } = errorRecordParts(payload);
				this.push({
					kind: 'error',
					at: this.now(),
					files,
					errors: [message],
					consoleErrors: 0,
					source
				});
				return undefined;
			}
			case 'vite:beforeFullReload': {
				const hadWaiters = this.waiters.size > 0;
				this.push({
					kind: 'full-reload',
					at: this.now(),
					files: reloadFiles(payload),
					errors: [],
					consoleErrors: 0,
					source
				});
				return hadWaiters
					? new Promise((resolve) => setTimeout(resolve, FULL_RELOAD_HOLD_MS))
					: undefined;
			}
			default:
				return undefined;
		}
	}

	/** Count one console error / uncaught error against the latest record. */
	noteConsoleError(): void {
		const latest = this.records[this.records.length - 1];
		if (latest) latest.consoleErrors++;
	}

	/** Forget everything (tests). */
	reset(): void {
		this.records = [];
		this.pending = null;
		this.bridgeSeen = false;
		this.loaded = true;
		try {
			this.storage()?.removeItem(HMR_LOG_STORAGE_KEY);
		} catch {
			// storage unavailable
		}
	}

	private storage(): Storage | null {
		if (this.opts.storage !== undefined) return this.opts.storage;
		try {
			return typeof sessionStorage === 'undefined' ? null : sessionStorage;
		} catch {
			return null;
		}
	}

	private load(): void {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const raw = this.storage()?.getItem(HMR_LOG_STORAGE_KEY);
			if (!raw) return;
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) return;
			const restored = parsed.filter(
				(r): r is HmrRecord =>
					isObject(r) &&
					typeof r.at === 'number' &&
					(r.kind === 'update' || r.kind === 'full-reload' || r.kind === 'error') &&
					Array.isArray(r.files) &&
					Array.isArray(r.errors)
			);
			this.records = [...restored, ...this.records].slice(-HMR_LOG_SIZE);
		} catch {
			// corrupt or unavailable storage: start empty
		}
	}

	private persist(): void {
		try {
			this.storage()?.setItem(HMR_LOG_STORAGE_KEY, JSON.stringify(this.records));
		} catch {
			// quota / private mode
		}
	}

	private push(record: HmrRecord): void {
		this.load();
		this.records.push(record);
		if (this.records.length > HMR_LOG_SIZE) this.records.splice(0, this.records.length - HMR_LOG_SIZE);
		this.persist();
		for (const waiter of [...this.waiters]) {
			if (record.at >= waiter.after && recordMatches(record, waiter.files)) waiter.resolve(record);
		}
	}

	private install(): void {
		this.load();
		const hot = this.hot;
		if (hot) {
			for (const event of VITE_EVENTS) {
				const cb = (payload: unknown) => this.ingest(event, payload, 'vite-hmr');
				hot.on(event, cb);
				this.cleanup.push(() => hot.off?.(event, cb));
			}
		}

		this.watchConsole();

		const target = this.target;
		if (!target) return;

		const onBridge = (event: Event) => {
			const detail = (event as CustomEvent<HmrBridgeDetail>).detail;
			if (!detail || typeof detail.type !== 'string') return;
			this.bridgeSeen = true;
			// import.meta.hot delivers the same events: never count them twice.
			if (this.hot) return;
			const hold = this.ingest(detail.type, detail.payload, 'plugin');
			if (hold && typeof detail.waitUntil === 'function') detail.waitUntil(hold);
		};
		target.addEventListener(HMR_BRIDGE_EVENT, onBridge);
		this.cleanup.push(() => target.removeEventListener(HMR_BRIDGE_EVENT, onBridge));
	}

	/** Count console errors / uncaught errors from the shared capture while installed. */
	private watchConsole(): void {
		const capture = this.capture;
		if (!capture) return;
		capture.retain();
		const unsubscribe = capture.subscribe((entry) => {
			if (entry.level === 'error') this.noteConsoleError();
		});
		this.cleanup.push(() => {
			unsubscribe();
			capture.release();
		});
	}

	private uninstall(): void {
		for (const fn of this.cleanup.splice(0)) {
			try {
				fn();
			} catch {
				// best effort
			}
		}
	}

	private waitForMutations(timeoutMs: number): Promise<HmrRecord> {
		const doc = this.opts.doc ? this.opts.doc() : typeof document === 'undefined' ? null : document;
		const MO = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
		if (!doc?.body || !MO) {
			return Promise.reject(
				new Error('No HMR source available: no import.meta.hot, no svelte-grab/vite plugin, no DOM.')
			);
		}
		return new Promise<HmrRecord>((resolve, reject) => {
			let quiet: ReturnType<typeof setTimeout> | null = null;
			const observer = new MO((mutations) => {
				const relevant = mutations.some((m) => {
					const node = m.target;
					const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
					return el ? !isInOwnUi(el) : false;
				});
				if (!relevant) return;
				if (quiet) clearTimeout(quiet);
				quiet = setTimeout(done, HEURISTIC_QUIET_MS);
			});
			const timer = setTimeout(() => {
				observer.disconnect();
				if (quiet) clearTimeout(quiet);
				reject(new Error(this.timeoutText({ after: 0, timeoutMs })));
			}, timeoutMs);
			const done = () => {
				clearTimeout(timer);
				observer.disconnect();
				const record: HmrRecord = {
					kind: 'update',
					at: this.now(),
					files: [],
					errors: [],
					consoleErrors: 0,
					source: 'heuristic'
				};
				this.push(record);
				resolve(record);
			};
			observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
		});
	}

	private timeoutText(options: Pick<WaitForOptions, 'files' | 'timeoutMs' | 'after'>): string {
		const seconds = Number((options.timeoutMs / 1000).toFixed(3));
		const what =
			options.files && options.files.length > 0
				? `touching ${options.files.join(', ')}`
				: 'at all';
		const source = this.source;
		let text = `No HMR update ${what} within ${seconds}s (source: ${source}).`;
		if (source === 'heuristic') {
			text +=
				' No Vite HMR API is reachable (import.meta.hot is undefined and the svelte-grab/vite plugin is not installed), so the wait listens for DOM changes.';
		}
		const recent = this.records.slice(-3);
		if (recent.length > 0) {
			text += ` Recent updates: ${recent
				.map((r) => `${r.kind} ${r.files.join(', ') || '(no files)'} at ${new Date(r.at).toISOString()}`)
				.join('; ')}.`;
		}
		if (this.pending) text += ' An update is still being applied.';
		return text;
	}
}

/** The tab's tracker. `startAgentRuntime` retains it while the runtime runs. */
export const hmrTracker = new HmrTracker();

/** One animation frame (bounded, hidden tabs never paint) then a microtask flush. */
export async function settleFrame(): Promise<void> {
	await new Promise<void>((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			resolve();
		};
		if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => finish());
		setTimeout(finish, FRAME_FALLBACK_MS);
	});
	await Promise.resolve();
	await new Promise<void>((resolve) => queueMicrotask(resolve));
}

function optionalFiles(args: Record<string, unknown>): string[] | undefined {
	const value = args.files;
	if (value === undefined || value === null) return undefined;
	if (typeof value === 'string') return value ? [value] : undefined;
	if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
		throw new Error('"files" must be an array of strings');
	}
	const files = (value as string[]).map((f) => f.trim()).filter(Boolean);
	return files.length > 0 ? files : undefined;
}

function optionalSince(args: Record<string, unknown>): number | undefined {
	const value = args.since;
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error('"since" must be a number (epoch ms)');
	}
	return value;
}

export interface WaitForHmrData extends Record<string, unknown> {
	status: 'updated' | 'full-reload' | 'error';
	updated: string[];
	errors: string[];
	rebound: { from: string; to: string }[];
	lost: string[];
	kept: number;
	consoleErrors: number;
	source: HmrSource;
	/** Epoch ms of the (latest) matching update. */
	at: number;
}

export interface WaitForHmrDeps {
	tracker?: HmrTracker;
	registry?: RefRegistry;
	now?: () => number;
	settle?: () => Promise<void>;
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values));
}

function formatRebind(report: RebindReport): string {
	const parts = [`${report.kept} kept`];
	const rebound = report.rebound.map((r) => `${r.from} -> ${r.to}`);
	parts.push(
		`${report.rebound.length} rebound${rebound.length ? ` (${rebound.slice(0, 20).join(', ')}${rebound.length > 20 ? ', ...' : ''})` : ''}`
	);
	parts.push(
		`${report.lost.length} lost${report.lost.length ? ` (${report.lost.slice(0, 20).join(', ')}${report.lost.length > 20 ? ', ...' : ''})` : ''}`
	);
	return `Refs: ${parts.join(', ')}`;
}

/**
 * `ui_wait_for_hmr`: wait for the HMR update that follows a file edit, then
 * re-resolve every live ref.
 *
 * Args: `files?: string[]` (suffix match; any update when omitted),
 * `timeoutMs?` (default 15000, max 55000), `since?` (epoch ms: also accept an
 * update that already happened at or after that time, from the last 20).
 */
export async function uiWaitForHmr(
	args: Record<string, unknown>,
	deps: WaitForHmrDeps = {}
): Promise<RuntimeToolResult> {
	const tracker = deps.tracker ?? hmrTracker;
	const registry = deps.registry ?? refRegistry;
	const now = deps.now ?? Date.now;
	const settle = deps.settle ?? settleFrame;

	const files = optionalFiles(args);
	const timeoutMs = optionalInt(args, 'timeoutMs', DEFAULT_HMR_TIMEOUT_MS, 1, MAX_HMR_TIMEOUT_MS);
	const since = optionalSince(args);
	const arrived = now();
	const after = since !== undefined ? Math.min(since, arrived) : arrived;

	// Keep listeners (and console error counting) installed until the refs are
	// rebound, even when the runtime itself did not retain the tracker.
	tracker.retain();
	try {
		const already = since !== undefined ? tracker.since(after, files) : [];
		const records =
			already.length > 0 ? already : [await tracker.waitFor({ after, files, timeoutMs })];
		return await summarize(records, arrived, registry, settle);
	} finally {
		tracker.release();
	}
}

async function summarize(
	records: HmrRecord[],
	arrived: number,
	registry: RefRegistry,
	settle: () => Promise<void>
): Promise<RuntimeToolResult> {
	const source = records[records.length - 1].source;
	const at = records[records.length - 1].at;
	const fullReload = records.some((r) => r.kind === 'full-reload');
	const updated = unique(records.flatMap((r) => r.files));
	const errors = unique(records.flatMap((r) => r.errors));
	const status: WaitForHmrData['status'] = fullReload
		? 'full-reload'
		: records.every((r) => r.kind === 'error')
			? 'error'
			: 'updated';

	if (fullReload && records[records.length - 1].kind === 'full-reload' && at >= arrived) {
		// The page is about to reload: refs die with it. Answer right away.
		const data: WaitForHmrData = {
			status,
			updated,
			errors,
			rebound: [],
			lost: [],
			kept: 0,
			consoleErrors: 0,
			source,
			at
		};
		const by = updated.length ? ` (triggered by ${updated.join(', ')})` : '';
		return {
			text:
				`Full page reload${by} (source: ${source}). The page is reloading: every ref is gone. ` +
				'Wait for the tab to reconnect (ui_tabs), then call ui_snapshot / ui_find again.',
			data
		};
	}

	await settle();
	const report = registry.rebindAll();
	const consoleErrors = records.reduce((n, r) => n + r.consoleErrors, 0);
	const data: WaitForHmrData = {
		status,
		updated,
		errors,
		rebound: report.rebound,
		lost: report.lost,
		kept: report.kept,
		consoleErrors,
		source,
		at
	};

	const lines: string[] = [];
	if (status === 'error') {
		lines.push(`Vite reported an error instead of an update (source: ${source}):`);
	} else if (status === 'full-reload') {
		lines.push(
			`The page was fully reloaded at ${new Date(at).toISOString()} (source: ${source}); refs from before the reload are gone.`
		);
	} else if (source === 'heuristic') {
		lines.push(
			'DOM changed (source: heuristic). No Vite HMR API is reachable (import.meta.hot is undefined and the ' +
				'svelte-grab/vite plugin is not installed), so the updated files are unknown and any DOM change counts. ' +
				'Add svelte-grab/vite to your Vite plugins for exact HMR tracking.'
		);
	} else {
		lines.push(`HMR update applied (source: ${source}): ${updated.join(', ') || '(no files reported)'}`);
	}
	for (const e of errors) lines.push(`  error: ${e}`);
	lines.push(formatRebind(report));
	lines.push(`Console errors since the update: ${consoleErrors}`);
	return { text: lines.join('\n'), data };
}
