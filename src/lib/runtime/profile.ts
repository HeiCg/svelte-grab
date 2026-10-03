/**
 * `ui_profile` (docs/agent-runtime-spec.md, Phase 8a): record which components
 * update the DOM, and how often, for `durationMs`, optionally while performing
 * an in-page action. Meant to follow `ui_verify`: did the change make a
 * component hot?
 *
 * Svelte 5 has no component re-render: what is counted is DOM mutations
 * (childList / attributes / characterData) attributed to the component whose
 * markup was changed (nearest element with `__svelte_meta.loc`), exactly like
 * the Alt+P profiler (`utils/profiler-tracker.ts`).
 *
 * - Tracker: a fresh, headless `ProfilerTracker` per call (own
 *   MutationObserver, no UI). A human Alt+P session runs its own instance, so
 *   the two never share or reset each other's data. svelte-grab's own UI and
 *   `data-sg-ref` stamps are ignored by the tracker.
 * - Scope: `component` keeps mutations inside instances of that component
 *   (its own markup and everything it renders, children included); `ref`
 *   keeps mutations inside that element's subtree.
 * - Action (best effort, `isTrusted=false`): `click` dispatches pointerdown,
 *   mousedown, pointerup, mouseup, click; `input` sets the value and dispatches
 *   input + change; `scroll` scrolls the element into view, or by `value`
 *   ("dy" or "dx,dy" px). `repeat` (default 1) runs are spread evenly over the
 *   window: run i starts at i * durationMs / repeat, the first right after
 *   recording starts. Each run re-resolves the ref (stable key rebinding).
 * - FPS from `utils/fps-meter.ts` (avg over the window, min over whole-second
 *   readings); long frames from PerformanceObserver `long-animation-frame`,
 *   else `longtask`, else omitted with a note.
 * - Verdict: `HOT <Component> N mutations in Xs (burst xK)` per component with
 *   at least one burst (the tracker's threshold: 20 mutation batches within
 *   1000ms, the Alt+P defaults), else `QUIET`.
 */
import { extractComponentName, findMetaElement, getSvelteLoc, getSvelteMeta, walkDevStack } from '../utils/component-stack.js';
import { createFpsMeter, type FpsMeter } from '../utils/fps-meter.js';
import { ProfilerTracker } from '../utils/profiler-tracker.js';
import { shortenPath } from '../utils/shared.js';
import { optionalInt, optionalString } from './args.js';
import { getClasses } from './node-info.js';
import { computeStableKeys, refRegistry, type RefRegistry } from './refs.js';
import type { RuntimeToolResult } from './types.js';

export const DEFAULT_PROFILE_MS = 3_000;
export const MIN_PROFILE_MS = 100;
export const MAX_PROFILE_MS = 30_000;
export const MAX_ACTION_REPEAT = 50;
/** Same defaults as the Alt+P profiler (SvelteRenderProfiler props). */
export const PROFILE_BURST_THRESHOLD = 20;
export const PROFILE_BURST_WINDOW_MS = 1_000;
/** Components listed in the text. */
export const MAX_TEXT_COMPONENTS = 15;
/** Components kept in `data`. */
const MAX_DATA_COMPONENTS = 50;
/** Most-mutated elements listed per component. */
export const TOP_ELEMENTS = 3;

export const PROFILE_ACTION_TYPES = ['click', 'input', 'scroll'] as const;
export type ProfileActionType = (typeof PROFILE_ACTION_TYPES)[number];

export type LongFrameEntryType = 'long-animation-frame' | 'longtask';

/** A running long-frame observation. `type: null` when the browser has neither entry type. */
export interface LongFrameWatch {
	type: LongFrameEntryType | null;
	stop(): { count: number; worstMs: number };
}

export interface ProfileOptions {
	registry?: RefRegistry;
	/** Waits `ms` (test seam). Defaults to `setTimeout`. */
	sleep?: (ms: number) => Promise<void>;
	/** Starts the FPS meter (test seam). Defaults to `createFpsMeter`. */
	fpsMeter?: (onSample: (fps: number) => void) => FpsMeter;
	/** Starts the long-frame observer (test seam). Defaults to {@link observeLongFrames}. */
	longFrames?: () => LongFrameWatch;
	/** Clock in ms (test seam). Defaults to `performance.now`. */
	now?: () => number;
}

/** A validated in-page action (also used by `ui_run_actions` in leak.ts). */
export interface ParsedAction {
	ref: string;
	type: ProfileActionType;
	value?: string;
	repeat: number;
	/** `scroll` with a value: the delta. */
	delta?: { x: number; y: number };
}

export interface ProfileTopElement extends Record<string, unknown> {
	ref: string;
	tag: string;
	/** `file:line` of the element. */
	source: string | null;
	count: number;
}

export interface ProfileComponent extends Record<string, unknown> {
	name: string;
	file: string;
	mutations: number;
	perSecond: number;
	/** MutationObserver batches that touched this component. */
	batches: number;
	bursts: number;
	hot: boolean;
	kinds: { childList: number; attributes: number; characterData: number };
	topElements: ProfileTopElement[];
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Observe long frames with the best entry type the browser supports. */
export function observeLongFrames(): LongFrameWatch {
	const none: LongFrameWatch = { type: null, stop: () => ({ count: 0, worstMs: 0 }) };
	const PO = typeof PerformanceObserver === 'function' ? PerformanceObserver : undefined;
	const supported: readonly string[] = PO?.supportedEntryTypes ?? [];
	const type: LongFrameEntryType | null = supported.includes('long-animation-frame')
		? 'long-animation-frame'
		: supported.includes('longtask')
			? 'longtask'
			: null;
	if (!PO || !type) return none;

	let count = 0;
	let worst = 0;
	const record = (entries: PerformanceEntryList) => {
		for (const e of entries) {
			count++;
			if (e.duration > worst) worst = e.duration;
		}
	};
	let observer: PerformanceObserver;
	try {
		observer = new PO((list) => record(list.getEntries()));
		observer.observe({ type, buffered: false });
	} catch {
		return none;
	}
	return {
		type,
		stop() {
			try {
				record(observer.takeRecords());
			} catch {
				/* takeRecords unsupported: keep what the callback saw */
			}
			observer.disconnect();
			return { count, worstMs: Math.round(worst) };
		}
	};
}

function parseAction(args: Record<string, unknown>): ParsedAction | null {
	const raw = args.action;
	if (raw === undefined || raw === null) return null;
	return parseActionObject(raw);
}

/**
 * Validate one action object `{ ref, type, value?, repeat? }`. `label` names
 * it in error messages (e.g. `actions[1]`). Exported for leak.ts.
 */
export function parseActionObject(raw: unknown, label = 'action'): ParsedAction {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error(`"${label}" must be an object { ref, type: "click"|"input"|"scroll", value?, repeat? }`);
	}
	const a = raw as Record<string, unknown>;
	const ref = optionalString(a, 'ref');
	if (!ref) throw new Error(`"${label}.ref" is required: an eN ref or a ui:// stable key from ui_find/ui_snapshot`);
	const type = a.type;
	if (typeof type !== 'string' || !(PROFILE_ACTION_TYPES as readonly string[]).includes(type)) {
		throw new Error(`"${label}.type" must be one of ${PROFILE_ACTION_TYPES.join(', ')}`);
	}
	const value = a.value === undefined || a.value === null ? undefined : a.value;
	if (value !== undefined && typeof value !== 'string') throw new Error(`"${label}.value" must be a string`);
	const repeat = optionalInt(a, 'repeat', 1, 1, MAX_ACTION_REPEAT);
	const action: ParsedAction = { ref, type: type as ProfileActionType, repeat };
	if (value !== undefined) action.value = value;
	if (action.type === 'input' && value === undefined) {
		throw new Error(`"${label}.value" is required for an input action (the text to set)`);
	}
	if (action.type === 'scroll' && value !== undefined && value.trim() !== '') {
		const parts = value.split(',').map((p) => Number(p.trim()));
		if (parts.length > 2 || parts.some((n) => !Number.isFinite(n))) {
			throw new Error(`"${label}.value" for scroll must be "dy" or "dx,dy" in px (omit it to scroll into view)`);
		}
		action.delta = parts.length === 2 ? { x: parts[0], y: parts[1] } : { x: 0, y: parts[0] };
	}
	return action;
}

function center(el: Element): { clientX: number; clientY: number } {
	const r = el.getBoundingClientRect();
	return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
}

function dispatchClick(el: Element): void {
	const view = el.ownerDocument.defaultView;
	// No `view` in the init: it must be the event constructor's own Window, which
	// is not guaranteed across realms (iframes, test environments).
	const base = { bubbles: true, cancelable: true, composed: true, button: 0, ...center(el) };
	const PE = view && typeof view.PointerEvent === 'function' ? view.PointerEvent : undefined;
	const ME = view?.MouseEvent ?? MouseEvent;
	const pointer = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
	if (PE) el.dispatchEvent(new PE('pointerdown', { ...base, ...pointer, buttons: 1 }));
	el.dispatchEvent(new ME('mousedown', { ...base, buttons: 1, detail: 1 }));
	(el as HTMLElement).focus?.({ preventScroll: true });
	if (PE) el.dispatchEvent(new PE('pointerup', { ...base, ...pointer, buttons: 0 }));
	el.dispatchEvent(new ME('mouseup', { ...base, buttons: 0, detail: 1 }));
	el.dispatchEvent(new ME('click', { ...base, buttons: 0, detail: 1 }));
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
	// The prototype setter, so frameworks that shadow `value` still see the change.
	const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
	if (setter) setter.call(el, value);
	else el.value = value;
}

function dispatchInput(el: Element, value: string): void {
	const tag = el.localName;
	if (tag === 'input' || tag === 'textarea' || tag === 'select') {
		const field = el as HTMLInputElement;
		if (tag === 'input' && (field.type === 'checkbox' || field.type === 'radio')) {
			field.checked = value !== '' && value !== 'false';
		} else {
			setNativeValue(field, value);
		}
	} else if ((el as HTMLElement).isContentEditable || el.getAttribute('contenteditable') === 'true') {
		el.textContent = value;
	} else {
		throw new Error(`input action needs an <input>, <textarea>, <select> or contenteditable element, got <${tag}>`);
	}
	const view = el.ownerDocument.defaultView;
	const IE = view && typeof view.InputEvent === 'function' ? view.InputEvent : undefined;
	el.dispatchEvent(
		IE
			? new IE('input', { bubbles: true, composed: true, inputType: 'insertText', data: value })
			: new Event('input', { bubbles: true, composed: true })
	);
	el.dispatchEvent(new Event('change', { bubbles: true }));
}

function dispatchScroll(el: Element, delta: { x: number; y: number } | undefined): void {
	if (!delta) {
		if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'nearest' });
		return;
	}
	const scrollable = el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth;
	const target = scrollable ? el : el.ownerDocument.scrollingElement;
	if (!target) return;
	if (typeof target.scrollBy === 'function') {
		target.scrollBy({ left: delta.x, top: delta.y });
	} else {
		target.scrollLeft += delta.x;
		target.scrollTop += delta.y;
	}
}

/** Perform one in-page action on `el` (exported for tests). */
export function performAction(el: Element, action: Pick<ParsedAction, 'type' | 'value' | 'delta'>): void {
	switch (action.type) {
		case 'click':
			dispatchClick(el);
			break;
		case 'input':
			dispatchInput(el, action.value ?? '');
			break;
		case 'scroll':
			dispatchScroll(el, action.delta);
			break;
	}
}

/** Start offsets (ms from recording start) of `repeat` runs spread over `durationMs`. */
export function actionOffsets(durationMs: number, repeat: number): number[] {
	const step = Math.floor(durationMs / repeat);
	return Array.from({ length: repeat }, (_, i) => i * step);
}

/**
 * Filter for the `component` scope: the mutated element is written in
 * `<component>.svelte` or renders inside an instance of it. Cached per element
 * with meta for the run.
 */
export function componentScopeFilter(component: string): (target: HTMLElement) => boolean {
	const wanted = component.toLowerCase();
	const cache = new WeakMap<Element, boolean>();
	return (target) => {
		const metaEl = findMetaElement(target, { requireLoc: false });
		if (!metaEl) return false;
		const cached = cache.get(metaEl);
		if (cached !== undefined) return cached;
		const loc = getSvelteLoc(metaEl);
		const own = loc ? extractComponentName(loc.file)?.toLowerCase() === wanted : false;
		const inside =
			own ||
			walkDevStack(getSvelteMeta(metaEl)).some(
				(item) => item.kind === 'component' && item.componentName?.toLowerCase() === wanted
			);
		cache.set(metaEl, inside);
		return inside;
	};
}

/** `1.5s`, `3s`. */
export function formatSeconds(ms: number): string {
	const s = Math.round(ms / 100) / 10;
	return `${Number.isInteger(s) ? s.toFixed(0) : s.toFixed(1)}s`;
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function formatKinds(k: ProfileComponent['kinds']): string {
	const parts: string[] = [];
	if (k.characterData) parts.push(`characterData ${k.characterData}`);
	if (k.childList) parts.push(`childList ${k.childList}`);
	if (k.attributes) parts.push(`attributes ${k.attributes}`);
	return parts.join(', ');
}

/** The verdict lines for a profile (exported for tests). */
export function verdictLines(components: ProfileComponent[], elapsedMs: number): string[] {
	const hot = components.filter((c) => c.hot);
	if (hot.length === 0) {
		const busiest = components[0];
		return [
			`QUIET no component above the burst threshold (${PROFILE_BURST_THRESHOLD} mutation batches within ${PROFILE_BURST_WINDOW_MS}ms)` +
				(busiest ? `; busiest: ${busiest.name} ${plural(busiest.mutations, 'mutation')} in ${formatSeconds(elapsedMs)}` : '; no DOM mutations')
		];
	}
	return hot.map(
		(c) => `HOT ${c.name} ${plural(c.mutations, 'mutation')} in ${formatSeconds(elapsedMs)} (burst x${c.bursts})`
	);
}

export async function uiProfile(
	args: Record<string, unknown>,
	options: ProfileOptions = {}
): Promise<RuntimeToolResult> {
	const registry = options.registry ?? refRegistry;
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? defaultNow;
	const durationMs = optionalInt(args, 'durationMs', DEFAULT_PROFILE_MS, MIN_PROFILE_MS, MAX_PROFILE_MS);
	const component = optionalString(args, 'component');
	const scopeRefArg = optionalString(args, 'ref');
	if (component && scopeRefArg) throw new Error('Pass either "component" or "ref" as the scope, not both');
	const action = parseAction(args);

	const notes: string[] = [];

	// Resolve everything before recording, so ref stamps are not in the profile.
	let scopeEl: Element | null = null;
	let scopeRef: string | null = null;
	if (scopeRefArg) {
		const resolved = registry.resolve(scopeRefArg);
		if (!resolved) {
			throw new Error(`Unknown ref "${scopeRefArg}": the element is gone or the ref is invalid. Run ui_find or ui_snapshot for fresh refs.`);
		}
		scopeEl = resolved.element;
		scopeRef = resolved.ref;
		if (resolved.rebound) notes.push(`scope ${resolved.previous} was stale; rebound to ${resolved.ref}`);
	}
	let actionEl: Element | null = null;
	let actionRef: string | null = null;
	if (action) {
		const resolved = registry.resolve(action.ref);
		if (!resolved) {
			throw new Error(`Unknown action ref "${action.ref}": the element is gone or the ref is invalid. Run ui_find or ui_snapshot for fresh refs.`);
		}
		actionEl = resolved.element;
		actionRef = resolved.ref;
		if (resolved.rebound) notes.push(`action ${resolved.previous} was stale; rebound to ${resolved.ref}`);
	}

	const filter = component
		? componentScopeFilter(component)
		: scopeEl
			? (target: HTMLElement) => scopeEl!.contains(target)
			: undefined;
	const tracker = new ProfilerTracker(PROFILE_BURST_THRESHOLD, PROFILE_BURST_WINDOW_MS, null, {
		filter,
		trackElements: true
	});

	const fpsSamples: number[] = [];
	const meter = (options.fpsMeter ?? ((onSample) => createFpsMeter(60, { onSample })))((fps) => fpsSamples.push(fps));
	const longFrames = (options.longFrames ?? observeLongFrames)();
	tracker.start();
	const started = now();

	let performed = 0;
	const skipped: string[] = [];
	try {
		if (action && actionEl) {
			const offsets = actionOffsets(durationMs, action.repeat);
			let at = 0;
			for (let i = 0; i < offsets.length; i++) {
				if (offsets[i] > at) {
					await sleep(offsets[i] - at);
					at = offsets[i];
				}
				let el: Element | null = actionEl;
				if (i > 0 || !el.isConnected) el = registry.resolve(action.ref)?.element ?? null;
				if (!el) {
					skipped.push(`run ${i + 1}/${action.repeat}: ref ${action.ref} no longer resolves`);
					continue;
				}
				try {
					performAction(el, action);
					performed++;
				} catch (err) {
					skipped.push(`run ${i + 1}/${action.repeat}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			if (durationMs > at) await sleep(durationMs - at);
		} else {
			await sleep(durationMs);
		}
	} finally {
		tracker.stop();
	}
	const measured = now() - started;
	// Never shorter than asked for (a fake/frozen clock in tests reads ~0).
	const elapsedMs = Math.max(measured, durationMs);
	meter.stop();
	const frames = meter.frames;
	const longFrameStats = longFrames.stop();

	// ---- aggregate
	const profiles = tracker.getProfiles();
	const batchesByFile = new Map<string, number>();
	for (const e of tracker.getEvents()) batchesByFile.set(e.componentFile, (batchesByFile.get(e.componentFile) ?? 0) + 1);

	const kept = profiles.slice(0, MAX_DATA_COMPONENTS);
	const tops = kept.map((p) => tracker.getTopElements(p.file, TOP_ELEMENTS * 2).filter((t) => t.element.isConnected).slice(0, TOP_ELEMENTS));
	const doc = (actionEl ?? scopeEl)?.ownerDocument ?? document;
	const keys = computeStableKeys(
		tops.flat().map((t) => t.element),
		doc
	);

	const components: ProfileComponent[] = kept.map((p, i) => {
		const bursts = p.burstCount;
		return {
			name: p.name || extractComponentName(p.file) || 'unknown',
			file: p.file,
			mutations: p.renderCount,
			perSecond: Math.round((p.renderCount / (elapsedMs / 1000)) * 10) / 10,
			batches: batchesByFile.get(p.file) ?? 0,
			bursts,
			hot: bursts > 0,
			kinds: tracker.getMutationKinds(p.file),
			topElements: tops[i].map(({ element, count }) => {
				const loc = getSvelteLoc(element);
				const classes = getClasses(element, 2);
				return {
					ref: registry.refFor(element, keys.get(element)),
					tag: `${element.localName}${classes.length ? '.' + classes.join('.') : ''}`,
					source: loc ? `${shortenPath(loc.file)}:${loc.line}` : null,
					count
				};
			})
		};
	});

	const fps =
		frames > 0 || fpsSamples.length > 0
			? {
					avg: Math.round((frames * 1000) / elapsedMs),
					min: fpsSamples.length > 0 ? Math.min(...fpsSamples) : null,
					samples: fpsSamples.length
				}
			: null;
	if (!fps) notes.push('FPS unavailable: no animation frames painted (tab hidden or requestAnimationFrame missing)');
	if (!longFrames.type) {
		notes.push('long frames unavailable: PerformanceObserver supports neither long-animation-frame nor longtask here');
	}
	notes.push(...skipped);

	// ---- text
	const lines = verdictLines(components, elapsedMs);
	const scopeText = component ? `component ${component}` : scopeRef ? `ref ${scopeRef} subtree` : 'page';
	const actionText = action
		? `, action: ${action.type} ${actionRef}${action.value !== undefined ? ` ${JSON.stringify(action.value)}` : ''} x${action.repeat}` +
			`${performed !== action.repeat ? ` (${performed} performed)` : ''} (isTrusted=false)`
		: '';
	lines.push(`ui_profile ${formatSeconds(elapsedMs)}, scope: ${scopeText}${actionText}`);

	if (components.length === 0) {
		lines.push('No DOM mutations attributed to Svelte components during the window.');
	} else {
		const shown = components.slice(0, MAX_TEXT_COMPONENTS);
		lines.push(`COMPONENTS by mutations (${shown.length} of ${profiles.length}):`);
		for (const c of shown) {
			lines.push(
				`  ${c.name} ${plural(c.mutations, 'mutation')}, ${c.perSecond}/s, ${plural(c.bursts, 'burst')}, ` +
					`${c.batches} ${c.batches === 1 ? 'batch' : 'batches'} [${formatKinds(c.kinds)}] ${shortenPath(c.file)}`
			);
			if (c.topElements.length > 0) {
				lines.push(
					`    top: ${c.topElements.map((t) => [t.ref, t.tag, t.source, `x${t.count}`].filter(Boolean).join(' ')).join('; ')}`
				);
			}
		}
		if (profiles.length > shown.length) lines.push(`  … ${profiles.length - shown.length} more components`);
	}

	if (fps) lines.push(`FPS avg ${fps.avg}${fps.min !== null ? `, min ${fps.min}` : ''} (${plural(fps.samples, 'whole-second sample')})`);
	if (longFrames.type) {
		lines.push(
			`LONG FRAMES ${longFrameStats.count}${longFrameStats.count > 0 ? `, worst ${longFrameStats.worstMs}ms` : ''} (${longFrames.type}, > 50ms)`
		);
	}
	for (const n of notes) lines.push(`Note: ${n}`);
	lines.push(
		'Svelte 5 has no component re-renders: counts are DOM mutations attributed to the component whose markup changed. ' +
			`A burst = ${PROFILE_BURST_THRESHOLD}+ mutation batches within ${PROFILE_BURST_WINDOW_MS}ms.`
	);

	return {
		text: lines.join('\n'),
		data: {
			verdict: components.some((c) => c.hot) ? 'HOT' : 'QUIET',
			hot: components.filter((c) => c.hot).map((c) => c.name),
			durationMs,
			elapsedMs: Math.round(elapsedMs),
			scope: component ? { component } : scopeRef ? { ref: scopeRef } : { page: true },
			...(action
				? {
						action: {
							ref: actionRef,
							type: action.type,
							...(action.value !== undefined ? { value: action.value } : {}),
							repeat: action.repeat,
							offsetsMs: actionOffsets(durationMs, action.repeat),
							performed,
							skipped,
							isTrusted: false
						}
					}
				: {}),
			burst: { threshold: PROFILE_BURST_THRESHOLD, windowMs: PROFILE_BURST_WINDOW_MS },
			totalMutations: profiles.reduce((n, p) => n + p.renderCount, 0),
			componentCount: profiles.length,
			components,
			fps,
			longFrames: longFrames.type ? { type: longFrames.type, ...longFrameStats } : null,
			notes
		}
	};
}
