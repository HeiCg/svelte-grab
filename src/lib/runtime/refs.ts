/**
 * Ref registry for the agent runtime (docs/agent-runtime-spec.md, "Refs").
 *
 * - Session ref `eN`: increments per tab, stamped on the element as
 *   `data-sg-ref="eN"` the first time a tool emits it, so the agent can act on
 *   it with Playwright / chrome-devtools via `[data-sg-ref="eN"]`.
 * - Stable key `ui://<file>:<line>:<col>#<componentTag>[role=..,name=..][i]`:
 *   survives re-renders and HMR. `i` is the index among the page's elements
 *   that share the same key (document order).
 *
 * `resolve()` accepts either form. A ref whose element was disconnected is
 * re-resolved by its stable key and reported as `{ rebound: true, previous }`.
 */
import { getSvelteLoc, findMetaElement } from '../utils/component-stack.js';
import { computeName, computeRole } from './aria.js';
import { allPageElements, getComponentInstance } from './node-info.js';

export const REF_ATTR = 'data-sg-ref';
export const STABLE_KEY_SCHEME = 'ui://';

/** Max chars of the accessible name kept inside a stable key. */
const KEY_NAME_LENGTH = 40;
/** Registry size above which dead entries are pruned. */
const PRUNE_THRESHOLD = 2000;

const REF_PATTERN = /^e\d+$/;
/** Max hops followed through rebind aliases (`e1 -> e7 -> e12`). */
const MAX_ALIAS_HOPS = 16;

interface WeakElementRef {
	deref(): Element | undefined;
}

function weakRef(el: Element): WeakElementRef {
	if (typeof WeakRef === 'function') return new WeakRef(el);
	return { deref: () => el };
}

interface RefEntry {
	ref: string;
	stableKey: string;
	element: WeakElementRef;
}

export interface ResolvedRef {
	element: Element;
	ref: string;
	stableKey: string;
	/** Set when the original element was gone and the stable key found a replacement. */
	rebound?: true;
	/** The stale ref that was asked for (only with `rebound`). */
	previous?: string;
}

/**
 * Everything before `[role=...]`: source location + owning component tag. Cheap
 * (no name computation), used to narrow candidates.
 */
export function stableKeyPrefix(el: Element): string {
	const instanceName = getComponentInstance(el).name ?? '';
	const loc = getSvelteLoc(el);
	if (loc) return `${STABLE_KEY_SCHEME}${loc.file}:${loc.line}:${loc.column}#${instanceName}`;
	// No own loc (e.g. {@html} content): anchor on the nearest element with one.
	const anchor = findMetaElement(el.parentElement);
	const anchorLoc = getSvelteLoc(anchor);
	const where = anchorLoc ? `${anchorLoc.file}:${anchorLoc.line}:${anchorLoc.column}` : '';
	return `${STABLE_KEY_SCHEME}${where}#${instanceName}/${el.localName}`;
}

function keyName(name: string): string {
	return name.replace(/[[\]\n\r]/g, '').slice(0, KEY_NAME_LENGTH);
}

/** Stable key without the trailing `[i]`. */
export function stableKeyBase(el: Element, prefix = stableKeyPrefix(el)): string {
	const role = computeRole(el);
	const name = computeName(el, role);
	return `${prefix}[role=${role ?? ''},name=${keyName(name)}]`;
}

/**
 * Stable keys for several elements at once (one pass over the page per call).
 * Elements not attached to the document get index 0.
 */
export function computeStableKeys(
	elements: Element[],
	doc: Document = document
): Map<Element, string> {
	const result = new Map<Element, string>();
	if (elements.length === 0) return result;

	const prefixes = new Map<Element, string>();
	const wantedPrefixes = new Set<string>();
	for (const el of elements) {
		const p = stableKeyPrefix(el);
		prefixes.set(el, p);
		wantedPrefixes.add(p);
	}

	// Group the page's elements by prefix (only the prefixes we need).
	const groups = new Map<string, Element[]>();
	for (const el of allPageElements(doc)) {
		const p = stableKeyPrefix(el);
		if (!wantedPrefixes.has(p)) continue;
		let group = groups.get(p);
		if (!group) groups.set(p, (group = []));
		group.push(el);
	}

	const indexOf = new Map<Element, string>();
	for (const [prefix, group] of groups) {
		const counts = new Map<string, number>();
		for (const el of group) {
			const base = stableKeyBase(el, prefix);
			const i = counts.get(base) ?? 0;
			counts.set(base, i + 1);
			indexOf.set(el, `${base}[${i}]`);
		}
	}

	for (const el of elements) {
		result.set(el, indexOf.get(el) ?? `${stableKeyBase(el, prefixes.get(el))}[0]`);
	}
	return result;
}

export function computeStableKey(el: Element, doc: Document = document): string {
	return computeStableKeys([el], doc).get(el)!;
}

function splitKey(key: string): { base: string; prefix: string; index: number } | null {
	if (!key.startsWith(STABLE_KEY_SCHEME)) return null;
	const m = key.match(/^(.*)\[(\d+)\]$/);
	const base = m ? m[1] : key;
	const index = m ? Number(m[2]) : 0;
	const roleAt = base.lastIndexOf('[role=');
	if (roleAt < 0) return null;
	return { base, prefix: base.slice(0, roleAt), index };
}

/**
 * Find the element currently matching a stable key. Exact `[i]` first; if the
 * index moved (siblings with the same key added/removed), the nearest one with
 * the same base key.
 */
export function findByStableKey(key: string, doc: Document = document): Element | null {
	const parts = splitKey(key);
	if (!parts) return null;
	const matches: Element[] = [];
	for (const el of allPageElements(doc)) {
		if (stableKeyPrefix(el) !== parts.prefix) continue;
		if (stableKeyBase(el, parts.prefix) === parts.base) matches.push(el);
	}
	if (matches.length === 0) return null;
	return matches[Math.min(parts.index, matches.length - 1)];
}

export interface StableKeyMatch {
	element: Element;
	/** The key the element has now (its `[i]` may differ from the one asked for). */
	stableKey: string;
}

/**
 * {@link findByStableKey} for many keys in one pass over the page. Keys that
 * match nothing are absent from the result.
 */
export function findByStableKeys(
	keys: Iterable<string>,
	doc: Document = document
): Map<string, StableKeyMatch> {
	const result = new Map<string, StableKeyMatch>();
	const wanted = new Map<string, { base: string; prefix: string; index: number }>();
	const prefixes = new Set<string>();
	for (const key of keys) {
		const parts = splitKey(key);
		if (!parts) continue;
		wanted.set(key, parts);
		prefixes.add(parts.prefix);
	}
	if (wanted.size === 0) return result;

	const byBase = new Map<string, Element[]>();
	for (const el of allPageElements(doc)) {
		const prefix = stableKeyPrefix(el);
		if (!prefixes.has(prefix)) continue;
		const base = stableKeyBase(el, prefix);
		let list = byBase.get(base);
		if (!list) byBase.set(base, (list = []));
		list.push(el);
	}

	for (const [key, parts] of wanted) {
		const matches = byBase.get(parts.base);
		if (!matches || matches.length === 0) continue;
		const i = Math.min(parts.index, matches.length - 1);
		result.set(key, { element: matches[i], stableKey: `${parts.base}[${i}]` });
	}
	return result;
}

/** Outcome of {@link RefRegistry.rebindAll}. */
export interface RebindReport {
	/** Refs whose element is still connected. */
	kept: number;
	/** Refs whose element was replaced (e.g. by HMR) and found again by stable key. */
	rebound: { from: string; to: string }[];
	/** Refs whose element is gone with no replacement; they stop resolving. */
	lost: string[];
}

/** Per-tab registry `eN -> {stableKey, WeakRef<Element>}`. */
export class RefRegistry {
	private counter = 0;
	private byRef = new Map<string, RefEntry>();
	private byElement = new WeakMap<Element, string>();
	/** Old ref -> the ref it was rebound to by `rebindAll()`. */
	private aliases = new Map<string, string>();

	constructor(private readonly doc: () => Document = () => document) {}

	/** Number of live entries (tests / diagnostics). */
	get size(): number {
		return this.byRef.size;
	}

	/**
	 * The ref for `el`, creating and stamping one if needed. `stableKey` updates
	 * the stored key (pass it when you already computed it in a batch).
	 */
	refFor(el: Element, stableKey?: string): string {
		const existing = this.byElement.get(el);
		const entry = existing ? this.byRef.get(existing) : undefined;
		if (entry && entry.element.deref() === el) {
			if (stableKey) entry.stableKey = stableKey;
			if (el.getAttribute(REF_ATTR) !== entry.ref) el.setAttribute(REF_ATTR, entry.ref);
			return entry.ref;
		}

		if (this.byRef.size >= PRUNE_THRESHOLD) this.prune();
		const ref = `e${++this.counter}`;
		this.byRef.set(ref, {
			ref,
			stableKey: stableKey ?? computeStableKey(el, this.doc()),
			element: weakRef(el)
		});
		this.byElement.set(el, ref);
		el.setAttribute(REF_ATTR, ref);
		return ref;
	}

	/** Stored stable key of a ref, if known. */
	stableKeyOf(ref: string): string | undefined {
		return this.byRef.get(ref)?.stableKey;
	}

	/**
	 * Resolve an `eN` ref or a `ui://` stable key to a live element. Returns
	 * `null` when nothing matches.
	 */
	resolve(refOrKey: string): ResolvedRef | null {
		const query = String(refOrKey ?? '').trim();
		if (!query) return null;

		if (query.startsWith(STABLE_KEY_SCHEME)) {
			const el = findByStableKey(query, this.doc());
			return el ? this.describe(el) : null;
		}

		if (!REF_PATTERN.test(query)) return null;

		const entry = this.byRef.get(query);
		if (!entry && this.aliases.has(query)) return this.resolveAlias(query);
		if (!entry) {
			// Stamped by an earlier registry instance (e.g. the module was reloaded).
			const stamped = this.doc().querySelector(`[${REF_ATTR}="${query}"]`);
			return stamped ? this.describe(stamped) : null;
		}

		const el = entry.element.deref();
		if (el && el.isConnected) {
			return { element: el, ref: entry.ref, stableKey: entry.stableKey };
		}

		const replacement = findByStableKey(entry.stableKey, this.doc());
		if (!replacement) return null;
		return { ...this.describe(replacement), rebound: true, previous: entry.ref };
	}

	/** Forget everything (tests). The counter restarts at e1. */
	reset(): void {
		this.counter = 0;
		this.byRef.clear();
		this.byElement = new WeakMap();
		this.aliases.clear();
	}

	/**
	 * Re-resolve every registered ref whose element is no longer connected (call
	 * after an HMR update). A ref found again by its stable key is rebound: the
	 * replacement gets (or keeps) its own ref and the old one becomes an alias,
	 * so `resolve(old)` keeps working and reports `{ rebound, previous }`. A ref
	 * with no replacement is dropped (reported once in `lost`).
	 */
	rebindAll(): RebindReport {
		const report: RebindReport = { kept: 0, rebound: [], lost: [] };
		const stale: RefEntry[] = [];
		for (const entry of this.byRef.values()) {
			const el = entry.element.deref();
			if (el && el.isConnected) report.kept++;
			else stale.push(entry);
		}
		if (stale.length === 0) return report;

		const found = findByStableKeys(
			stale.map((e) => e.stableKey),
			this.doc()
		);
		for (const entry of stale) {
			this.byRef.delete(entry.ref);
			const match = found.get(entry.stableKey);
			if (!match) {
				report.lost.push(entry.ref);
				continue;
			}
			const to = this.refFor(match.element, match.stableKey);
			this.setAlias(entry.ref, to);
			report.rebound.push({ from: entry.ref, to });
		}
		return report;
	}

	private setAlias(from: string, to: string): void {
		if (this.aliases.size >= PRUNE_THRESHOLD) {
			// Oldest first (Map keeps insertion order).
			const oldest = this.aliases.keys().next().value;
			if (oldest !== undefined) this.aliases.delete(oldest);
		}
		this.aliases.set(from, to);
	}

	private resolveAlias(ref: string): ResolvedRef | null {
		let target = ref;
		for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
			const next = this.aliases.get(target);
			if (!next) break;
			target = next;
		}
		if (target === ref) return null;
		const resolved = this.resolve(target);
		if (!resolved) return null;
		return { ...resolved, rebound: true, previous: ref };
	}

	private describe(el: Element): ResolvedRef {
		const stableKey = computeStableKey(el, this.doc());
		const ref = this.refFor(el, stableKey);
		return { element: el, ref, stableKey };
	}

	/**
	 * Drop entries whose element was garbage collected. Bounds memory; those
	 * refs stop resolving (their stable keys still work).
	 */
	private prune(): void {
		for (const [ref, entry] of this.byRef) {
			if (!entry.element.deref()) this.byRef.delete(ref);
		}
	}
}

/** The tab's registry. Refs are per page load, like the tab id. */
export const refRegistry = new RefRegistry();
