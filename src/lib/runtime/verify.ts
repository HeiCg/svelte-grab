/**
 * `ui_verify` (docs/agent-runtime-spec.md, Phase 5): quick PASS / WARN / FAIL
 * checks on ONE element after an edit, meant to follow `ui_wait_for_hmr`.
 *
 * - visible: connected, rendered (not display:none / visibility:hidden /
 *   opacity:0), non-zero box, in the viewport (WARN when off-screen) and not
 *   covered by another element at its center (WARN, naming the coverer).
 * - overflow: the element's content clipped (FAIL with text) or spilling out
 *   of its box (WARN, naming the children that stick out), and page-level
 *   horizontal overflow (FAIL, naming the widest offenders).
 * - console: errors (FAIL) / warnings (WARN) since `since`, else since the
 *   last HMR update, else since the runtime started (`console-capture.ts`).
 * - a11y: `a11y-checker.ts` element-level checks (same as ui_inspect A11Y).
 * - contrast: text contrast of the element and its text descendants; same
 *   severity as the a11y checker: below 3:1 FAIL, below the WCAG AA minimum
 *   (4.5:1, 3:1 for large text) WARN.
 *
 * Text: verdict line first (FAIL if any check fails, else WARN, else PASS),
 * then one line per check, details indented below it.
 */
import { analyzeA11y } from '../utils/a11y-checker.js';
import { findMetaElement, getSvelteLoc } from '../utils/component-stack.js';
import { shortenPath } from '../utils/shared.js';
import { computeName, computeRole } from './aria.js';
import { consoleCapture, type ConsoleCapture, type ConsoleEntry } from './console-capture.js';
import { hmrTracker, type HmrTracker } from './hmr.js';
import { elementContrast, hasOwnText, type ContrastResult } from './inspect.js';
import {
	allPageElements,
	formatBox,
	getBox,
	getClasses,
	getElementSource,
	isInOwnUi,
	isInViewport
} from './node-info.js';
import { REF_ATTR, computeStableKeys, refRegistry, type RefRegistry } from './refs.js';
import { roleOrTag } from './snapshot.js';
import type { RuntimeToolResult } from './types.js';

export const VERIFY_CHECKS = ['visible', 'overflow', 'console', 'a11y', 'contrast'] as const;
export type VerifyCheck = (typeof VERIFY_CHECKS)[number];
export type VerifyStatus = 'PASS' | 'WARN' | 'FAIL';

/** Page-overflow offenders listed. */
export const MAX_PAGE_OFFENDERS = 3;
/** Console messages listed. */
export const MAX_CONSOLE_ITEMS = 5;
const MAX_CHILD_OFFENDERS = 3;
const MAX_A11Y_ISSUES = 10;
const MAX_CONTRAST_TARGETS = 50;
const MAX_CONTRAST_FAILS = 3;
const MAX_DESCENDANTS_SCANNED = 500;
/** Sub-pixel rounding tolerance (px). */
const TOLERANCE = 1;

export interface VerifyCheckResult {
	check: VerifyCheck;
	status: VerifyStatus;
	/** Rest of the check line after `<STATUS> <check>`. */
	summary: string;
	/** Lines printed indented under the check line. */
	details: string[];
	data: Record<string, unknown>;
}

export interface VerifyOptions {
	registry?: RefRegistry;
	capture?: ConsoleCapture;
	tracker?: HmrTracker;
}

/** An element named in a result (coverer, overflow offender, …). */
export interface ElementRef extends Record<string, unknown> {
	ref: string;
	tag: string;
	component: string | null;
	/** `file:line` of the element, or of its nearest ancestor with source. */
	source: string | null;
}

const RANK: Record<VerifyStatus, number> = { PASS: 0, WARN: 1, FAIL: 2 };

function worst(statuses: VerifyStatus[]): VerifyStatus {
	return statuses.reduce<VerifyStatus>((a, b) => (RANK[b] > RANK[a] ? b : a), 'PASS');
}

function parseChecks(args: Record<string, unknown>): VerifyCheck[] {
	const raw = args.checks;
	if (raw === undefined || raw === null) return [...VERIFY_CHECKS];
	if (!Array.isArray(raw)) throw new Error('"checks" must be an array of check names');
	const out: VerifyCheck[] = [];
	for (const item of raw) {
		if (typeof item !== 'string' || !(VERIFY_CHECKS as readonly string[]).includes(item)) {
			throw new Error(`Unknown check ${JSON.stringify(item)}: use any of ${VERIFY_CHECKS.join(', ')}`);
		}
		if (!out.includes(item as VerifyCheck)) out.push(item as VerifyCheck);
	}
	return out.length > 0 ? out : [...VERIFY_CHECKS];
}

function parseSince(args: Record<string, unknown>): number | undefined {
	const value = args.since;
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error('"since" must be a number (epoch ms)');
	}
	return value;
}

function iso(ms: number): string {
	try {
		return new Date(ms).toISOString();
	} catch {
		return String(ms);
	}
}

/** Names elements with refs; stable keys are computed in one batch per call. */
class Namer {
	private keys = new Map<Element, string>();
	constructor(
		private readonly registry: RefRegistry,
		private readonly doc: Document
	) {}

	prepare(elements: Element[]): void {
		const fresh = elements.filter((e) => !this.keys.has(e));
		for (const [el, key] of computeStableKeys(fresh, this.doc)) this.keys.set(el, key);
	}

	describe(el: Element): ElementRef {
		this.prepare([el]);
		const src = getElementSource(el);
		const loc = src.loc ?? getSvelteLoc(findMetaElement(el));
		const classes = getClasses(el, 2);
		return {
			ref: this.registry.refFor(el, this.keys.get(el)),
			tag: `${el.localName}${classes.length ? '.' + classes.join('.') : ''}`,
			component: src.component,
			source: loc ? `${shortenPath(loc.file)}:${loc.line}` : null
		};
	}
}

function formatRef(r: ElementRef): string {
	return [r.ref, r.tag, r.component, r.source].filter(Boolean).join(' ');
}

function result(
	check: VerifyCheck,
	status: VerifyStatus,
	summary: string,
	data: Record<string, unknown> = {},
	details: string[] = []
): VerifyCheckResult {
	return { check, status, summary, details, data };
}

// ------------------------------------------------------------------ visible

/** The topmost page element at a point, skipping svelte-grab's own overlay. */
function hitTest(doc: Document, x: number, y: number): Element | null | undefined {
	const d = doc as Document & { elementsFromPoint?: (x: number, y: number) => Element[] };
	if (typeof d.elementsFromPoint === 'function') {
		const all = d.elementsFromPoint(x, y);
		if (Array.isArray(all)) return all.find((e) => !isInOwnUi(e)) ?? null;
	}
	if (typeof doc.elementFromPoint === 'function') {
		const hit = doc.elementFromPoint(x, y);
		return hit && isInOwnUi(hit) ? null : hit;
	}
	return undefined; // hit testing unavailable (e.g. jsdom)
}

function checkVisible(el: HTMLElement, namer: Namer): VerifyCheckResult {
	if (!el.isConnected) return result('visible', 'FAIL', 'element is not connected to the document');
	const view = el.ownerDocument.defaultView!;
	const box = getBox(el);
	const data: Record<string, unknown> = { box };

	for (let n: Element | null = el; n && n !== el.ownerDocument.documentElement; n = n.parentElement) {
		const cs = view.getComputedStyle(n);
		const where = n === el ? '' : ` on ancestor ${formatRef(namer.describe(n))}`;
		if (cs.display === 'none') {
			return result('visible', 'FAIL', `hidden: display: none${where}`, { ...data, reason: 'display-none' });
		}
		if (n === el && (cs.visibility === 'hidden' || cs.visibility === 'collapse')) {
			return result('visible', 'FAIL', `hidden: visibility: ${cs.visibility}`, { ...data, reason: 'visibility' });
		}
		if (cs.opacity !== '' && Number(cs.opacity) === 0) {
			return result('visible', 'FAIL', `invisible: opacity: 0${where}`, { ...data, reason: 'opacity' });
		}
	}

	if (box.width === 0 || box.height === 0) {
		return result('visible', 'FAIL', `zero-size box (${box.width}x${box.height})`, { ...data, reason: 'zero-size' });
	}

	if (!isInViewport(el)) {
		return result(
			'visible',
			'WARN',
			`off-screen: box ${formatBox(box)} is outside the ${view.innerWidth}x${view.innerHeight} viewport (scroll it into view to see it)`,
			{ ...data, reason: 'off-screen', inViewport: false }
		);
	}

	const r = el.getBoundingClientRect();
	const x = (Math.max(r.left, 0) + Math.min(r.right, view.innerWidth)) / 2;
	const y = (Math.max(r.top, 0) + Math.min(r.bottom, view.innerHeight)) / 2;
	const hit = hitTest(el.ownerDocument, x, y);
	const base = { ...data, inViewport: true };
	if (hit === undefined) {
		return result('visible', 'PASS', `box ${formatBox(box)}, in viewport (coverage not checked: no hit testing)`, base);
	}
	if (hit === null || hit === el || el.contains(hit)) {
		return result('visible', 'PASS', `box ${formatBox(box)}, in viewport, not covered`, { ...base, covered: false });
	}
	if (hit.contains(el) && view.getComputedStyle(el).pointerEvents === 'none') {
		return result(
			'visible',
			'PASS',
			`box ${formatBox(box)}, in viewport (pointer-events: none, coverage not checked)`,
			base
		);
	}
	const coverer = namer.describe(hit);
	return result(
		'visible',
		'WARN',
		`covered at its center (${Math.round(x)},${Math.round(y)}) by ${formatRef(coverer)}`,
		{ ...base, covered: true, coveredBy: coverer }
	);
}

// ------------------------------------------------------------------ overflow

const clips = (v: string) => v === 'hidden' || v === 'clip';
const scrolls = (v: string) => v === 'auto' || v === 'scroll';

interface Finding {
	status: VerifyStatus;
	message: string;
	items: string[];
}

/** Descendants that stick out of `el`'s box, outermost only, biggest first. */
function childOffenders(el: HTMLElement): { el: Element; by: number }[] {
	const box = el.getBoundingClientRect();
	const found: { el: Element; by: number }[] = [];
	const all = Array.from(el.querySelectorAll('*')).slice(0, MAX_DESCENDANTS_SCANNED);
	for (const d of all) {
		if (isInOwnUi(d)) continue;
		if (found.some((f) => f.el.contains(d))) continue;
		const r = d.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) continue;
		const by = Math.max(
			box.left - r.left,
			r.right - box.right,
			box.top - r.top,
			r.bottom - box.bottom
		);
		if (by > TOLERANCE) found.push({ el: d, by: Math.round(by) });
	}
	return found.sort((a, b) => b.by - a.by);
}

/** Whether an ancestor between `el` and `<body>` clips or scrolls horizontally. */
function insideHorizontalClip(el: Element): boolean {
	const view = el.ownerDocument.defaultView!;
	const body = el.ownerDocument.body;
	for (let p = el.parentElement; p && p !== body; p = p.parentElement) {
		const v = view.getComputedStyle(p).overflowX;
		if (clips(v) || scrolls(v)) return true;
	}
	return false;
}

/**
 * The elements that make the page scroll horizontally: past the right (or
 * left) edge of the document's client box, outside any horizontal clip/scroll
 * container, outermost of each subtree, furthest out first.
 */
export function pageOverflowOffenders(doc: Document, clientWidth: number): { el: Element; right: number; by: number }[] {
	const view = doc.defaultView!;
	const scrollX = view.scrollX || 0;
	const candidates: { el: Element; right: number; by: number }[] = [];
	for (const el of allPageElements(doc)) {
		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) continue;
		const right = r.right + scrollX;
		const left = r.left + scrollX;
		const by = Math.max(right - clientWidth, -left);
		if (by <= TOLERANCE) continue;
		const pos = view.getComputedStyle(el).position;
		if (pos === 'fixed') continue;
		if (insideHorizontalClip(el)) continue;
		candidates.push({ el, right: Math.round(right), by: Math.round(by) });
	}
	// Stable sort keeps document order (ancestors first) among equals.
	candidates.sort((a, b) => b.by - a.by);
	const chosen: typeof candidates = [];
	for (const c of candidates) {
		if (chosen.some((o) => o.el.contains(c.el) || c.el.contains(o.el))) continue;
		chosen.push(c);
		if (chosen.length >= MAX_PAGE_OFFENDERS) break;
	}
	return chosen;
}

function checkOverflow(el: HTMLElement, namer: Namer): VerifyCheckResult {
	const doc = el.ownerDocument;
	const view = doc.defaultView!;
	const cs = view.getComputedStyle(el);
	const findings: Finding[] = [];
	const data: Record<string, unknown> = {};

	// 1. The element's own content.
	const display = cs.display || 'block';
	const measurable = display !== 'inline' && display !== 'contents' && display !== 'none';
	const ox = cs.overflowX || cs.overflow || 'visible';
	const oy = cs.overflowY || cs.overflow || 'visible';
	const scroll = { width: el.scrollWidth, height: el.scrollHeight };
	const client = { width: el.clientWidth, height: el.clientHeight };
	const over = {
		x: measurable && client.width > 0 && scroll.width > client.width + TOLERANCE,
		y: measurable && client.height > 0 && scroll.height > client.height + TOLERANCE
	};
	data.element = { overflowX: ox, overflowY: oy, scroll, client, overflowing: over };
	const dims = (axis: 'x' | 'y') =>
		axis === 'x'
			? `scrollWidth ${scroll.width} > clientWidth ${client.width}, overflow-x: ${ox}`
			: `scrollHeight ${scroll.height} > clientHeight ${client.height}, overflow-y: ${oy}`;

	const clippedAxes = (['x', 'y'] as const).filter((a) => over[a] && clips(a === 'x' ? ox : oy));
	const spillAxes = (['x', 'y'] as const).filter(
		(a) => over[a] && !clips(a === 'x' ? ox : oy) && !scrolls(a === 'x' ? ox : oy)
	);
	const scrollAxes = (['x', 'y'] as const).filter((a) => over[a] && scrolls(a === 'x' ? ox : oy));

	if (clippedAxes.length > 0) {
		const hasText = (el.textContent ?? '').trim() !== '';
		const ellipsis = cs.textOverflow === 'ellipsis' ? ' (text-overflow: ellipsis)' : '';
		findings.push({
			status: hasText ? 'FAIL' : 'WARN',
			message: `content is clipped${hasText ? ' (text cut off)' : ''}${ellipsis}: ${clippedAxes.map(dims).join('; ')}`,
			items: []
		});
		data.clipped = true;
	}
	if (spillAxes.length > 0) {
		const offenders = childOffenders(el).slice(0, MAX_CHILD_OFFENDERS);
		namer.prepare(offenders.map((o) => o.el));
		const named = offenders.map((o) => ({ ...namer.describe(o.el), by: o.by }));
		findings.push({
			status: 'WARN',
			message: `content spills out of the element's box: ${spillAxes.map(dims).join('; ')}`,
			items: named.map((n) => `${formatRef(n)} sticks out by ${n.by}px`)
		});
		data.spilling = named;
	}
	if (scrollAxes.length > 0) data.scrollable = scrollAxes;

	// 2. Page-level horizontal overflow.
	const root = doc.documentElement;
	const pageScroll = root.scrollWidth;
	const pageClient = root.clientWidth;
	if (pageClient > 0 && pageScroll > pageClient + TOLERANCE) {
		const offenders = pageOverflowOffenders(doc, pageClient);
		namer.prepare(offenders.map((o) => o.el));
		const named = offenders.map((o) => ({
			...namer.describe(o.el),
			right: o.right,
			by: o.by,
			containsTarget: o.el === el || o.el.contains(el) || el.contains(o.el)
		}));
		findings.push({
			status: 'FAIL',
			message: `page scrolls horizontally: document scrollWidth ${pageScroll} > clientWidth ${pageClient}`,
			items:
				named.length > 0
					? named.map(
							(n) =>
								`${formatRef(n)} extends ${n.by}px past the page edge (right edge at ${n.right}px)${n.containsTarget ? ' [contains or is this element]' : ''}`
						)
					: ['(no single element found past the edge; check margins and transforms)']
		});
		data.page = { scrollWidth: pageScroll, clientWidth: pageClient, offenders: named };
	} else {
		data.page = { scrollWidth: pageScroll, clientWidth: pageClient, offenders: [] };
	}

	if (findings.length === 0) {
		const parts = [
			measurable
				? `content fits (${scroll.width}x${scroll.height} in ${client.width}x${client.height})`
				: `element not measured (display: ${display})`
		];
		if (scrollAxes.length > 0) parts[0] = `content scrolls inside the element (overflow ${ox}/${oy})`;
		parts.push('no page-level horizontal overflow');
		return result('overflow', 'PASS', parts.join('; '), data);
	}
	findings.sort((a, b) => RANK[b.status] - RANK[a.status]);
	const [first, ...rest] = findings;
	const details = [...first.items];
	for (const f of rest) {
		details.push(`${f.status} ${f.message}`);
		details.push(...f.items.map((i) => `  ${i}`));
	}
	return result('overflow', first.status, first.message, data, details);
}

// ------------------------------------------------------------------ console

interface ConsoleGroup {
	level: ConsoleEntry['level'];
	message: string;
	source: string | null;
	count: number;
	at: number;
}

function groupConsole(entries: ConsoleEntry[]): ConsoleGroup[] {
	const groups = new Map<string, ConsoleGroup>();
	for (const e of entries) {
		const source = e.source ? `${e.source.file}:${e.source.line}${e.source.column ? `:${e.source.column}` : ''}` : null;
		const key = `${e.level}|${e.message}|${source}`;
		const g = groups.get(key);
		if (g) g.count++;
		else groups.set(key, { level: e.level, message: e.message, source, count: 1, at: e.at });
	}
	// Errors first, then by first occurrence.
	return [...groups.values()].sort((a, b) =>
		a.level === b.level ? a.at - b.at : a.level === 'error' ? -1 : 1
	);
}

function checkConsole(capture: ConsoleCapture, tracker: HmrTracker, since: number | undefined): VerifyCheckResult {
	let after: number | undefined;
	let label: string;
	if (since !== undefined) {
		after = since;
		label = `since ${iso(since)}`;
	} else {
		const log = tracker.log();
		const last = log.length > 0 ? log[log.length - 1] : undefined;
		if (last) {
			// From the start of the update: errors thrown while the new modules run
			// are logged before vite:afterUpdate.
			after = last.startedAt ?? last.at;
			label = `since the last HMR update (${iso(after)})`;
		} else if (capture.startedAt !== null) {
			after = capture.startedAt;
			label = `since the runtime started (${iso(capture.startedAt)})`;
		} else {
			label = 'in the capture buffer';
		}
	}
	const entries = capture.entries(after);
	const errors = entries.filter((e) => e.level === 'error').length;
	const warnings = entries.length - errors;
	const groups = groupConsole(entries);
	const top = groups.slice(0, MAX_CONSOLE_ITEMS);
	const data: Record<string, unknown> = {
		since: after ?? null,
		errors,
		warnings,
		captureActive: capture.active,
		messages: top
	};
	const details = top.map(
		(g) => `${g.level} ${g.source ?? '(unknown source)'} ${g.message}${g.count > 1 ? ` (x${g.count})` : ''}`
	);
	if (groups.length > top.length) details.push(`… ${groups.length - top.length} more distinct messages`);

	if (!capture.active && entries.length === 0) {
		return result(
			'console',
			'WARN',
			'console capture is not running (the agent runtime is not connected), so errors are unknown',
			data
		);
	}
	const counts = `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'} ${label}`;
	if (errors > 0) return result('console', 'FAIL', counts, data, details);
	if (warnings > 0) return result('console', 'WARN', counts, data, details);
	return result('console', 'PASS', `no errors or warnings ${label}`, data);
}

// ------------------------------------------------------------------ a11y / contrast

function checkA11y(el: HTMLElement, skipContrast: boolean): VerifyCheckResult {
	const report = analyzeA11y(el, false);
	const issues = [...report.critical, ...report.warnings].filter(
		(i) => !(skipContrast && i.rule === 'contrast')
	);
	const data = {
		issues: issues.map((i) => ({
			severity: i.severity,
			rule: i.rule,
			message: i.message,
			fix: i.fix,
			fixCode: i.fixCode ?? null
		}))
	};
	const status: VerifyStatus = issues.some((i) => i.severity === 'critical')
		? 'FAIL'
		: issues.some((i) => i.severity === 'warning')
			? 'WARN'
			: 'PASS';
	if (issues.length === 0) {
		return result('a11y', 'PASS', 'no element-level issues (label, button name, img alt, tabindex, interactive role)', data);
	}
	const details = issues
		.slice(0, MAX_A11Y_ISSUES)
		.map((i) => `[${i.severity}] ${i.rule}: ${i.message}. Fix: ${i.fix.replace(/\n/g, '; ')}${i.fixCode ? ` e.g. ${i.fixCode}` : ''}`);
	if (issues.length > MAX_A11Y_ISSUES) details.push(`… ${issues.length - MAX_A11Y_ISSUES} more`);
	return result('a11y', status, `${issues.length} issue${issues.length === 1 ? '' : 's'}: ${issues.map((i) => i.rule).join(', ')}`, data, details);
}

function contrastStatus(c: ContrastResult): VerifyStatus {
	if (c.pass) return 'PASS';
	return c.ratio < 3 ? 'FAIL' : 'WARN';
}

function checkContrast(el: HTMLElement, namer: Namer): VerifyCheckResult {
	const view = el.ownerDocument.defaultView!;
	const targets: HTMLElement[] = [el];
	for (const d of Array.from(el.querySelectorAll<HTMLElement>('*'))) {
		if (targets.length >= MAX_CONTRAST_TARGETS) break;
		if (isInOwnUi(d) || !hasOwnText(d)) continue;
		targets.push(d);
	}
	const measured: { el: HTMLElement; c: ContrastResult }[] = [];
	for (const t of targets) {
		const cs = view.getComputedStyle(t);
		if (cs.display === 'none' || cs.visibility === 'hidden') continue;
		const c = elementContrast(t);
		if (c) measured.push({ el: t, c });
	}
	if (measured.length === 0) {
		return result('contrast', 'PASS', 'n/a (no text with a determinable background)', { measured: 0 });
	}
	// Worst = lowest ratio relative to what it needs.
	measured.sort((a, b) => a.c.ratio / a.c.required - b.c.ratio / b.c.required);
	const w = measured[0];
	const status = contrastStatus(w.c);
	const where = w.el === el ? '' : ` on ${formatRef(namer.describe(w.el))}`;
	const failing = measured.filter((m) => !m.c.pass);
	const details = failing
		.slice(0, MAX_CONTRAST_FAILS)
		.map(
			(m) =>
				`${m.el === el ? 'this element' : formatRef(namer.describe(m.el))}: ${m.c.ratio}:1 (needs ${m.c.required}:1), fg ${m.c.fg} on bg ${m.c.bg}`
		);
	if (failing.length > MAX_CONTRAST_FAILS) details.push(`… ${failing.length - MAX_CONTRAST_FAILS} more`);
	const summary =
		status === 'PASS'
			? `${w.c.ratio}:1 (needs ${w.c.required}:1)${measured.length > 1 ? `, lowest of ${measured.length} text elements` : ''}`
			: `${w.c.ratio}:1 (needs ${w.c.required}:1)${where}`;
	return result('contrast', status, summary, {
		measured: measured.length,
		worst: { ...w.c, ref: w.el === el ? null : namer.describe(w.el).ref },
		failing: failing.length
	}, status === 'PASS' ? [] : details);
}

// ------------------------------------------------------------------ handler

export function uiVerify(args: Record<string, unknown>, options: VerifyOptions = {}): RuntimeToolResult {
	const registry = options.registry ?? refRegistry;
	const capture = options.capture ?? consoleCapture;
	const tracker = options.tracker ?? hmrTracker;

	const refArg = args.ref;
	if (typeof refArg !== 'string' || refArg.trim() === '') {
		throw new Error('ui_verify needs "ref": an eN ref or a ui:// stable key from ui_snapshot/ui_find');
	}
	const checks = parseChecks(args);
	const since = parseSince(args);

	const resolved = registry.resolve(refArg);
	if (!resolved) {
		throw new Error(
			`Unknown ref "${refArg}": the element is gone or the ref is invalid. Run ui_find or ui_snapshot for fresh refs.`
		);
	}
	const el = resolved.element as HTMLElement;
	const namer = new Namer(registry, el.ownerDocument);

	const results: VerifyCheckResult[] = [];
	for (const check of VERIFY_CHECKS) {
		if (!checks.includes(check)) continue;
		try {
			switch (check) {
				case 'visible':
					results.push(checkVisible(el, namer));
					break;
				case 'overflow':
					results.push(checkOverflow(el, namer));
					break;
				case 'console':
					results.push(checkConsole(capture, tracker, since));
					break;
				case 'a11y':
					results.push(checkA11y(el, checks.includes('contrast')));
					break;
				case 'contrast':
					results.push(checkContrast(el, namer));
					break;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			results.push(result(check, 'WARN', `check failed to run: ${msg}`, { error: msg }));
		}
	}

	const verdict = worst(results.map((r) => r.status));
	const role = computeRole(el);
	const name = computeName(el, role);
	const src = getElementSource(el);
	const head = [verdict, resolved.ref, roleOrTag(el, role)];
	if (name) head.push(JSON.stringify(name.length > 60 ? name.slice(0, 59) + '…' : name));
	if (src.component) head.push(src.component);
	if (src.loc) head.push(`${shortenPath(src.loc.file)}:${src.loc.line}`);

	const lines = [head.join(' ')];
	if (resolved.rebound) lines.push(`# ${resolved.previous} was stale; rebound to ${resolved.ref}`);
	for (const r of results) {
		lines.push(`${r.status} ${r.check}${r.summary ? ` ${r.summary}` : ''}`);
		for (const d of r.details) lines.push(`  ${d}`);
	}

	const data: Record<string, unknown> = {
		verdict,
		ref: resolved.ref,
		stableKey: resolved.stableKey,
		locator: `[${REF_ATTR}="${resolved.ref}"]`,
		checks: results.map((r) => ({ check: r.check, status: r.status, summary: r.summary, details: r.details, ...r.data }))
	};
	if (resolved.rebound) {
		data.rebound = true;
		data.previous = resolved.previous;
	}
	return { text: lines.join('\n'), data };
}
