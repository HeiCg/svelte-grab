/**
 * `ui_inspect`: the heavy, on-demand context for ONE element, built from the
 * existing tools' logic:
 *
 * - STACK: `getComponentStack` + the SvelteGrab agent format.
 * - PROPS/ATTRIBUTES, STATE: SvelteStateGrab's capture (`state-capture.ts`) and
 *   the `inspectable()` registry.
 * - LAYOUT: box, display/position, visibility, overflow.
 * - STYLES: `css-analyzer.ts` (matched rules, winning source, Tailwind/scoped).
 * - A11Y: role/name, contrast and `a11y-checker.ts` element-level checks.
 * - USAGE: instances of the same component on the page (`ui_find` matching).
 *
 * COMPONENT and SOURCE are always included. Text is capped at
 * `MAX_INSPECT_TEXT` chars; every cap says so in the output.
 */
import type { StackEntry } from '../types.js';
import { formatForAgent } from '../utils/agent-format.js';
import { contrastRatio, analyzeA11y, getEffectiveBackground } from '../utils/a11y-checker.js';
import { findMetaElement, getComponentStack, getSvelteLoc } from '../utils/component-stack.js';
import {
	analyzeStyles,
	formatSourceStr,
	getMatchingRules,
	isSvelteScoped,
	isTailwindClass
} from '../utils/css-analyzer.js';
import { safeSerialize } from '../utils/serializer.js';
import {
	extractComponentName,
	getElementPreview,
	isExcludedPath,
	shortenPath
} from '../utils/shared.js';
import {
	defaultInspectableLookup,
	extractComponentState,
	findInspectableInstances,
	type InspectableLookup
} from '../utils/state-capture.js';
import { computeName, computeRole } from './aria.js';
import { isComponentRoot } from './find.js';
import {
	type Box,
	allPageElements,
	formatBox,
	getBox,
	getComponentInstance,
	getElementSource,
	isInViewport,
	isVisible
} from './node-info.js';
import { REF_ATTR, computeStableKeys, refRegistry, type RefRegistry } from './refs.js';
import { roleOrTag } from './snapshot.js';
import type { RuntimeToolResult } from './types.js';

export const INSPECT_SECTIONS = [
	'stack',
	'props',
	'state',
	'styles',
	'layout',
	'a11y',
	'usage'
] as const;
export type InspectSection = (typeof INSPECT_SECTIONS)[number];

/** Hard cap on the returned text (chars). */
export const MAX_INSPECT_TEXT = 8000;
/** Authored style declarations listed. */
export const MAX_STYLE_DECLARATIONS = 25;
const MAX_MATCHED_RULES = 10;
const MAX_CONFLICTS = 5;
const MAX_ENTRIES_PER_GROUP = 20;
const MAX_STATE_INSTANCES = 5;
const MAX_A11Y_ISSUES = 10;
const MAX_USAGE_INSTANCES = 20;
const VALUE_PREVIEW_LENGTH = 120;
const ATTR_VALUE_LENGTH = 80;

export interface InspectOptions {
	registry?: RefRegistry;
	inspectables?: InspectableLookup;
}

function parseInclude(args: Record<string, unknown>): InspectSection[] {
	const raw = args.include;
	if (raw === undefined || raw === null) return [...INSPECT_SECTIONS];
	if (!Array.isArray(raw)) throw new Error('"include" must be an array of section names');
	const out: InspectSection[] = [];
	for (const item of raw) {
		if (typeof item !== 'string' || !(INSPECT_SECTIONS as readonly string[]).includes(item)) {
			throw new Error(
				`Unknown include section ${JSON.stringify(item)}: use any of ${INSPECT_SECTIONS.join(', ')}`
			);
		}
		if (!out.includes(item as InspectSection)) out.push(item as InspectSection);
	}
	return out;
}

/** Single-line, JSON-safe preview of any value. */
function previewValue(value: unknown): string {
	if (value === undefined) return 'undefined';
	let s: string;
	try {
		s = JSON.stringify(JSON.parse(safeSerialize(value, 2, VALUE_PREVIEW_LENGTH)));
	} catch {
		s = String(value);
	}
	return s.length > VALUE_PREVIEW_LENGTH ? s.slice(0, VALUE_PREVIEW_LENGTH - 1) + '…' : s;
}

/** JSON-safe copy for `data` (functions, DOM nodes, cycles are made printable). */
function jsonSafe(value: unknown): unknown {
	if (value === undefined) return null;
	try {
		return JSON.parse(safeSerialize(value, 3, 200));
	} catch {
		return String(value);
	}
}

function jsonSafeRecord(record: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(record)) out[k] = jsonSafe(v);
	return out;
}

function cap(s: string, max: number): string {
	return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** `key: value` lines for a record, capped, with a note when entries are left out. */
function recordLines(
	label: string,
	record: Record<string, unknown>,
	format: (value: unknown) => string
): string[] {
	const entries = Object.entries(record);
	if (entries.length === 0) return [];
	const lines = [`${label}:`];
	for (const [k, v] of entries.slice(0, MAX_ENTRIES_PER_GROUP)) lines.push(`  ${k}: ${format(v)}`);
	if (entries.length > MAX_ENTRIES_PER_GROUP) {
		lines.push(`  … ${entries.length - MAX_ENTRIES_PER_GROUP} more`);
	}
	return lines;
}

function fmtLoc(loc: { file: string; line: number; column?: number } | null): string {
	if (!loc) return '(unknown)';
	return `${shortenPath(loc.file)}:${loc.line}${typeof loc.column === 'number' ? `:${loc.column}` : ''}`;
}

// ------------------------------------------------------------------ sections

function stackSection(metaEl: HTMLElement, el: HTMLElement) {
	const entries: StackEntry[] = getComponentStack(metaEl, isExcludedPath);
	const text = formatForAgent(entries, el, {
		includeHtml: false,
		getHTMLPreview: (e) => getElementPreview(e),
		extractComponentName,
		shortenPath
	});
	return { lines: text ? text.split('\n') : ['(no Svelte component stack)'], data: entries };
}

function propsSection(el: HTMLElement, lookup: InspectableLookup) {
	const info = extractComponentState(el, lookup);
	const dataAttributes = { ...info.dataAttributes };
	delete dataAttributes[REF_ATTR];
	const lines = [
		...recordLines('props (class/style)', info.props, previewValue),
		...recordLines('attributes', info.attributes, (v) => JSON.stringify(cap(String(v), ATTR_VALUE_LENGTH))),
		...recordLines('data attributes', dataAttributes, (v) => JSON.stringify(cap(String(v), ATTR_VALUE_LENGTH))),
		...recordLines('bound/observable values', info.boundValues, previewValue)
	];
	if (info.childComponents.length > 0) {
		lines.push(
			`child components (${info.childComponentCount} total, ${info.childComponents.length} unique):`
		);
		for (const c of info.childComponents.slice(0, MAX_ENTRIES_PER_GROUP)) {
			lines.push(`  <${c.name}> ${c.file}${c.count > 1 ? ` (x${c.count})` : ''}`);
		}
		if (info.childComponents.length > MAX_ENTRIES_PER_GROUP) {
			lines.push(`  … ${info.childComponents.length - MAX_ENTRIES_PER_GROUP} more`);
		}
	}
	if (lines.length === 0) lines.push('(no props, attributes or bound values)');
	return {
		lines,
		data: {
			props: jsonSafeRecord(info.props),
			attributes: info.attributes,
			dataAttributes,
			boundValues: jsonSafeRecord(info.boundValues),
			childComponents: info.childComponents
		}
	};
}

function stateSection(names: string[], lookup: InspectableLookup) {
	let instances: ReturnType<typeof findInspectableInstances>;
	let name: string | null = null;
	for (const n of names) {
		instances = findInspectableInstances(n, lookup);
		if (instances) {
			name = n;
			break;
		}
	}
	if (!instances || !name) {
		const target = names[0] ?? 'Component';
		return {
			lines: [
				`no inspectable() state registered for ${names.length ? `<${names.join('> / <')}>` : 'this element'}`,
				`(expose $state with: $effect(() => inspectable('${target}', { ...values })))`
			],
			data: { component: names[0] ?? null, instances: [] }
		};
	}
	const lines = [
		`inspectable() state for <${name}> (${instances.length} live instance${instances.length === 1 ? '' : 's'}; not tied to this element):`
	];
	for (const inst of instances.slice(0, MAX_STATE_INSTANCES)) {
		lines.push(`  [${inst.label}]`);
		const entries = Object.entries(inst.values);
		for (const [k, v] of entries.slice(0, MAX_ENTRIES_PER_GROUP)) {
			lines.push(`    ${k}: ${previewValue(v)}`);
		}
		if (entries.length > MAX_ENTRIES_PER_GROUP) {
			lines.push(`    … ${entries.length - MAX_ENTRIES_PER_GROUP} more`);
		}
	}
	if (instances.length > MAX_STATE_INSTANCES) {
		lines.push(`  … ${instances.length - MAX_STATE_INSTANCES} more instances`);
	}
	return {
		lines,
		data: {
			component: name,
			instances: instances.map((i) => ({
				label: i.label,
				instance: i.instance,
				values: jsonSafeRecord(i.values)
			}))
		}
	};
}

interface LayoutData {
	box: Box;
	display: string;
	position: string;
	boxSizing: string;
	zIndex: string;
	visibility: string;
	opacity: string;
	visible: boolean;
	inViewport: boolean;
	padding: string;
	margin: string;
	border: string;
	overflowX: string;
	overflowY: string;
	scroll: { width: number; height: number };
	client: { width: number; height: number };
	overflowing: { x: boolean; y: boolean };
	clipped: boolean;
	outsideParent: { top: number; right: number; bottom: number; left: number } | null;
}

function sides(cs: CSSStyleDeclaration, prop: (side: string) => string): string {
	const v = ['top', 'right', 'bottom', 'left'].map((s) => cs.getPropertyValue(prop(s)) || '0px');
	if (v.every((x) => x === v[0])) return v[0];
	return v.join(' ');
}

function layoutSection(el: HTMLElement) {
	const view = el.ownerDocument.defaultView!;
	const cs = view.getComputedStyle(el);
	const box = getBox(el);
	const display = cs.display || 'unknown';
	const measurable = display !== 'inline' && display !== 'contents' && display !== 'none';
	const scroll = { width: el.scrollWidth, height: el.scrollHeight };
	const client = { width: el.clientWidth, height: el.clientHeight };
	const overflowing = {
		x: measurable && client.width > 0 && scroll.width > client.width + 1,
		y: measurable && client.height > 0 && scroll.height > client.height + 1
	};
	const overflowX = cs.overflowX || cs.overflow || 'visible';
	const overflowY = cs.overflowY || cs.overflow || 'visible';
	const clips = (v: string) => v === 'hidden' || v === 'clip';
	const clipped = (overflowing.x && clips(overflowX)) || (overflowing.y && clips(overflowY));

	let outsideParent: LayoutData['outsideParent'] = null;
	const parent = el.parentElement;
	if (parent && parent !== el.ownerDocument.body && box.width > 0 && box.height > 0) {
		const r = el.getBoundingClientRect();
		const p = parent.getBoundingClientRect();
		if (p.width > 0 && p.height > 0) {
			const out = {
				top: Math.max(0, Math.round(p.top - r.top)),
				right: Math.max(0, Math.round(r.right - p.right)),
				bottom: Math.max(0, Math.round(r.bottom - p.bottom)),
				left: Math.max(0, Math.round(p.left - r.left))
			};
			if (out.top > 1 || out.right > 1 || out.bottom > 1 || out.left > 1) outsideParent = out;
		}
	}

	const data: LayoutData = {
		box,
		display,
		position: cs.position || 'static',
		boxSizing: cs.boxSizing || 'content-box',
		zIndex: cs.zIndex || 'auto',
		visibility: cs.visibility || 'visible',
		opacity: cs.opacity || '1',
		visible: isVisible(el),
		inViewport: isInViewport(el),
		padding: sides(cs, (s) => `padding-${s}`),
		margin: sides(cs, (s) => `margin-${s}`),
		border: sides(cs, (s) => `border-${s}-width`),
		overflowX,
		overflowY,
		scroll,
		client,
		overflowing,
		clipped,
		outsideParent
	};

	const yn = (b: boolean) => (b ? 'yes' : 'no');
	const lines = [
		`box: ${formatBox(box)} (viewport px, x,y wxh)`,
		`display: ${data.display}, position: ${data.position}, box-sizing: ${data.boxSizing}, z-index: ${data.zIndex}`,
		`visible: ${yn(data.visible)}, in viewport: ${yn(data.inViewport)}, visibility: ${data.visibility}, opacity: ${data.opacity}`,
		`padding: ${data.padding}; margin: ${data.margin}; border-width: ${data.border}`
	];
	if (!measurable) {
		lines.push(`overflow: ${overflowX}/${overflowY} (not measured for display: ${display})`);
	} else if (overflowing.x || overflowing.y) {
		const what: string[] = [];
		if (overflowing.x) what.push(`wider (scrollWidth ${scroll.width} > clientWidth ${client.width})`);
		if (overflowing.y) what.push(`taller (scrollHeight ${scroll.height} > clientHeight ${client.height})`);
		lines.push(
			`OVERFLOW: content is ${what.join(' and ')}; overflow: ${overflowX}/${overflowY}${clipped ? ' -> content is CLIPPED' : ''}`
		);
	} else {
		lines.push(`overflow: ${overflowX}/${overflowY}; content fits (${scroll.width}x${scroll.height} in ${client.width}x${client.height})`);
	}
	if (outsideParent) {
		const dirs = (Object.entries(outsideParent) as [string, number][])
			.filter(([, v]) => v > 1)
			.map(([k, v]) => `${k} ${v}px`)
			.join(', ');
		lines.push(`extends outside its parent <${parent!.localName}>: ${dirs}`);
	}
	return { lines, data };
}

function stylesSection(el: HTMLElement) {
	const rules = getMatchingRules(el);
	const { categories, conflicts, inlineStyles } = analyzeStyles(el);

	const sourceCounts: Record<string, number> = {};
	for (const r of rules) sourceCounts[r.source.type] = (sourceCounts[r.source.type] ?? 0) + 1;
	const inlineCount = Object.keys(inlineStyles).length;
	if (inlineCount) sourceCounts.inline = inlineCount;

	const classes = Array.from(el.classList);
	const scopedClasses = classes.filter(isSvelteScoped);
	const tailwindClasses = classes.filter((c) => !isSvelteScoped(c) && isTailwindClass(c));

	const authored: { property: string; value: string; source: string; overridden: boolean }[] = [];
	let userAgent = 0;
	const seen = new Set<string>();
	for (const cat of categories) {
		for (const prop of cat.properties) {
			if (seen.has(prop.name)) continue;
			seen.add(prop.name);
			if (prop.source.type === 'user-agent') {
				userAgent++;
				continue;
			}
			authored.push({
				property: prop.name,
				value: prop.value,
				source: formatSourceStr(prop.source).replace(/^\s*→\s*/, ''),
				overridden: prop.isOverridden
			});
		}
	}

	const breakdown = Object.entries(sourceCounts)
		.map(([k, v]) => `${k} ${v}`)
		.join(', ');
	const lines = [
		`matched rules: ${rules.length}${breakdown ? ` (${breakdown})` : ''}`,
		`classes: ${classes.length ? classes.join(' ') : '(none)'}; svelte-scoped: ${scopedClasses.join(' ') || 'no'}; tailwind: ${tailwindClasses.join(' ') || 'none'}`
	];
	if (rules.length > 0) {
		lines.push('rules (document order):');
		for (const r of rules.slice(0, MAX_MATCHED_RULES)) {
			lines.push(`  ${r.rule.selectorText}${formatSourceStr(r.source)}`);
		}
		if (rules.length > MAX_MATCHED_RULES) lines.push(`  … ${rules.length - MAX_MATCHED_RULES} more rules`);
	}
	const shownDecl = authored.slice(0, MAX_STYLE_DECLARATIONS);
	lines.push(
		`authored declarations (computed value -> winning source)${authored.length > MAX_STYLE_DECLARATIONS ? `, showing ${MAX_STYLE_DECLARATIONS} of ${authored.length} (capped)` : ''}:`
	);
	if (shownDecl.length === 0) lines.push('  (none; only user-agent defaults)');
	for (const d of shownDecl) {
		lines.push(`  ${d.property}: ${d.value} -> ${d.source}${d.overridden ? ' (has overridden rules)' : ''}`);
	}
	if (userAgent > 0) lines.push(`(${userAgent} user-agent/default properties omitted)`);
	if (conflicts.length > 0) {
		lines.push(`conflicts (${conflicts.length}):`);
		for (const c of conflicts.slice(0, MAX_CONFLICTS)) {
			const parts = c.rules
				.map((r) => `${r.selector} = ${r.value}${r.important ? ' !important' : ''} [${r.won ? 'WON' : 'LOST'}]`)
				.join('; ');
			lines.push(`  ${c.property}: ${parts}`);
			if (c.suggestion) lines.push(`    hint: ${c.suggestion}`);
		}
		if (conflicts.length > MAX_CONFLICTS) lines.push(`  … ${conflicts.length - MAX_CONFLICTS} more conflicts`);
	}

	return {
		lines,
		data: {
			matchedRules: rules.slice(0, MAX_MATCHED_RULES).map((r) => ({
				selector: r.rule.selectorText,
				source: r.source.type,
				file: r.source.file ?? null
			})),
			matchedRuleCount: rules.length,
			sources: sourceCounts,
			classes,
			scopedClasses,
			tailwindClasses,
			declarations: shownDecl,
			declarationCount: authored.length,
			declarationsTruncated: authored.length > MAX_STYLE_DECLARATIONS,
			inline: inlineStyles,
			conflicts: conflicts.slice(0, MAX_CONFLICTS).map((c) => ({
				property: c.property,
				suggestion: c.suggestion ?? null,
				rules: c.rules.map((r) => ({ selector: r.selector, value: r.value, won: r.won, important: r.important }))
			}))
		}
	};
}

export function hasOwnText(el: Element): boolean {
	return Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '');
}

export interface ContrastResult {
	ratio: number;
	required: number;
	pass: boolean;
	fg: string;
	bg: string;
}

/**
 * Text contrast of `el` (WCAG: 4.5:1, 3:1 for large text), or `null` when the
 * element has no own text or the background cannot be determined.
 */
export function elementContrast(el: HTMLElement): ContrastResult | null {
	if (!hasOwnText(el) && !(el.children.length === 0 && el.textContent?.trim())) return null;
	const cs = el.ownerDocument.defaultView!.getComputedStyle(el);
	const fg = cs.color;
	const bg = getEffectiveBackground(el);
	const ratio = contrastRatio(fg, bg);
	if (ratio === null) return null;
	const size = parseFloat(cs.fontSize);
	const weight = parseInt(cs.fontWeight, 10);
	const large = size >= 24 || (size >= 18.66 && weight >= 700);
	const required = large ? 3 : 4.5;
	return { ratio: Math.round(ratio * 100) / 100, required, pass: ratio >= required, fg, bg };
}

function a11ySection(el: HTMLElement) {
	const role = computeRole(el);
	const name = computeName(el, role);
	const focusable = el.tabIndex >= 0;
	const contrast = elementContrast(el);

	const report = analyzeA11y(el, false);
	const issues = [...report.critical, ...report.warnings];

	const lines = [
		`role: ${role ?? '(none)'}, name: ${name ? JSON.stringify(name) : '(none)'}, focusable: ${focusable ? `yes (tabIndex ${el.tabIndex})` : 'no'}`
	];
	if (contrast) {
		lines.push(
			`contrast: ${contrast.ratio}:1 (needs ${contrast.required}:1) ${contrast.pass ? 'PASS' : 'FAIL'}, fg ${contrast.fg} on bg ${contrast.bg}`
		);
	} else {
		lines.push('contrast: n/a (no own text or indeterminate background)');
	}
	if (issues.length === 0) {
		lines.push('issues: none (element checks: label, button name, img alt, contrast, tabindex, interactive role)');
	} else {
		lines.push(`issues (${issues.length}):`);
		for (const i of issues.slice(0, MAX_A11Y_ISSUES)) {
			lines.push(`  [${i.severity}] ${i.rule}: ${i.message}. Fix: ${i.fix}${i.fixCode ? ` e.g. ${i.fixCode}` : ''}`);
		}
		if (issues.length > MAX_A11Y_ISSUES) lines.push(`  … ${issues.length - MAX_A11Y_ISSUES} more`);
	}
	return {
		lines,
		data: {
			role,
			name,
			focusable,
			contrast,
			issues: issues.map((i) => ({
				severity: i.severity,
				rule: i.rule,
				message: i.message,
				fix: i.fix,
				fixCode: i.fixCode ?? null
			}))
		}
	};
}

function usageSection(el: Element, componentName: string | null, registry: RefRegistry) {
	if (!componentName) {
		return { lines: ['(element is not inside a component)'], data: { component: null, count: 0, instances: [] } };
	}
	const thisEntry = getComponentInstance(el).entry;
	const roots = allPageElements(el.ownerDocument).filter((e) => isComponentRoot(e, componentName));
	// One row per instance (its first top-level element).
	const firstRoots: Element[] = [];
	const seenEntries = new Set<unknown>();
	for (const r of roots) {
		const entry = getComponentInstance(r).entry;
		if (entry) {
			if (seenEntries.has(entry)) continue;
			seenEntries.add(entry);
		}
		firstRoots.push(r);
	}
	const shown = firstRoots.slice(0, MAX_USAGE_INSTANCES);
	const keys = computeStableKeys(shown, el.ownerDocument);
	const instances = shown.map((r) => {
		const entry = getComponentInstance(r).entry;
		const usedAt = entry ? { file: entry.file, line: entry.line, column: entry.column } : null;
		return {
			ref: registry.refFor(r, keys.get(r)),
			usedAt,
			box: getBox(r),
			visible: isVisible(r),
			isThis: entry !== null && entry === thisEntry
		};
	});
	const lines = [
		`${firstRoots.length} instance${firstRoots.length === 1 ? '' : 's'} of <${componentName}> on the page:`
	];
	for (const i of instances) {
		lines.push(
			`  ${i.ref}${i.isThis ? ' (this)' : ''} used at ${i.usedAt ? fmtLoc(i.usedAt) : '(root)'} box=${formatBox(i.box)}${i.visible ? '' : ' (hidden)'}`
		);
	}
	if (firstRoots.length > shown.length) lines.push(`  … ${firstRoots.length - shown.length} more`);
	return { lines, data: { component: componentName, count: firstRoots.length, instances } };
}

// ------------------------------------------------------------------ handler

export function uiInspect(args: Record<string, unknown>, options: InspectOptions = {}): RuntimeToolResult {
	const registry = options.registry ?? refRegistry;
	const lookup = options.inspectables ?? defaultInspectableLookup;

	const refArg = args.ref;
	if (typeof refArg !== 'string' || refArg.trim() === '') {
		throw new Error('ui_inspect needs "ref": an eN ref or a ui:// stable key from ui_snapshot/ui_find');
	}
	const include = parseInclude(args);

	const resolved = registry.resolve(refArg);
	if (!resolved) {
		throw new Error(
			`Unknown ref "${refArg}": the element is gone or the ref is invalid. Run ui_find or ui_snapshot for fresh refs.`
		);
	}
	const el = resolved.element as HTMLElement;
	const metaEl = findMetaElement(el) ?? el;
	const src = getElementSource(el);
	const role = computeRole(el);
	const name = computeName(el, role);
	const ownLoc = getSvelteLoc(el);
	const sourceLoc = ownLoc ?? getSvelteLoc(metaEl);
	const componentName = src.component;
	const instanceName = src.instance.name;
	const usageEntry = src.instance.entry;

	const out: string[] = [];
	if (resolved.rebound) out.push(`# ${resolved.previous} was stale; rebound to ${resolved.ref}`);
	const head = [resolved.ref, roleOrTag(el, role)];
	if (name) head.push(JSON.stringify(name));
	if (componentName) head.push(componentName);
	if (sourceLoc) head.push(`${shortenPath(sourceLoc.file)}:${sourceLoc.line}`);
	out.push(head.join(' '));
	out.push(`Locator: [${REF_ATTR}="${resolved.ref}"]`);
	out.push(`Stable key: ${resolved.stableKey}`);

	const sections: { title: string; lines: string[] }[] = [];

	const compLines: string[] = [];
	if (componentName) {
		compLines.push(`<${componentName}>${sourceLoc ? ` defined in ${shortenPath(sourceLoc.file)}` : ''}`);
	} else {
		compLines.push('(no Svelte component metadata)');
	}
	if (instanceName && usageEntry) {
		const used = fmtLoc({ file: usageEntry.file, line: usageEntry.line, column: usageEntry.column });
		compLines.push(
			instanceName === componentName
				? `this instance is used at ${used}`
				: `rendered inside a <${instanceName}> instance used at ${used}`
		);
	} else if (componentName) {
		compLines.push('instance: root component (no usage site)');
	}
	sections.push({ title: 'COMPONENT', lines: compLines });

	const srcLines: string[] = [];
	if (ownLoc) srcLines.push(fmtLoc(ownLoc));
	else if (sourceLoc) srcLines.push(`${fmtLoc(sourceLoc)} (nearest ancestor with source: <${metaEl.localName}>)`);
	else srcLines.push('(no source location)');
	sections.push({ title: 'SOURCE', lines: srcLines });

	const data: Record<string, unknown> = {
		ref: resolved.ref,
		stableKey: resolved.stableKey,
		locator: `[${REF_ATTR}="${resolved.ref}"]`,
		element: { tag: el.localName, role, name },
		component: {
			name: componentName,
			instance: instanceName,
			usedAt: usageEntry ? { file: usageEntry.file, line: usageEntry.line, column: usageEntry.column } : null
		},
		source: sourceLoc ? { file: sourceLoc.file, line: sourceLoc.line, column: sourceLoc.column } : null,
		include
	};
	if (resolved.rebound) {
		data.rebound = true;
		data.previous = resolved.previous;
	}
	const errors: Record<string, string> = {};

	const builders: Record<InspectSection, { title: string; run: () => { lines: string[]; data: unknown } }> = {
		stack: { title: 'STACK', run: () => stackSection(metaEl, el) },
		props: { title: 'PROPS/ATTRIBUTES', run: () => propsSection(el, lookup) },
		state: {
			title: 'STATE',
			run: () =>
				stateSection(
					[componentName, instanceName].filter((n, i, a): n is string => !!n && a.indexOf(n) === i),
					lookup
				)
		},
		layout: { title: 'LAYOUT', run: () => layoutSection(el) },
		styles: { title: 'STYLES', run: () => stylesSection(el) },
		a11y: { title: 'A11Y', run: () => a11ySection(el) },
		usage: { title: 'USAGE', run: () => usageSection(el, instanceName ?? componentName, registry) }
	};
	// Fixed section order regardless of the `include` order.
	const order: InspectSection[] = ['stack', 'props', 'state', 'layout', 'styles', 'a11y', 'usage'];
	for (const key of order) {
		if (!include.includes(key)) continue;
		const b = builders[key];
		try {
			const r = b.run();
			sections.push({ title: b.title, lines: r.lines });
			data[key] = r.data;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errors[key] = msg;
			sections.push({ title: b.title, lines: [`(failed: ${msg})`] });
		}
	}
	if (Object.keys(errors).length) data.errors = errors;

	for (const s of sections) {
		out.push('', s.title, ...s.lines.map((l) => `  ${l}`));
	}

	let text = out.join('\n');
	let truncated = false;
	if (text.length > MAX_INSPECT_TEXT) {
		truncated = true;
		const note = `\n… output truncated at ${MAX_INSPECT_TEXT} chars (${text.length - MAX_INSPECT_TEXT}+ omitted). Pass include: [...] to request fewer sections; the structured result is in structuredContent.`;
		const budget = MAX_INSPECT_TEXT - note.length;
		const cut = text.lastIndexOf('\n', budget);
		text = text.slice(0, cut > 0 ? cut : budget) + note;
	}
	data.truncated = truncated;

	return { text, data };
}
