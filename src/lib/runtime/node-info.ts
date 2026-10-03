/**
 * DOM helpers shared by the runtime tools: which elements to skip, owning
 * component, box and visibility. Svelte metadata is read only through
 * `utils/component-stack.ts`.
 */
import type { DevStackEntry, SvelteSourceLocation } from '../types.js';
import {
	extractComponentName,
	findMetaElement,
	getSvelteLoc,
	getSvelteMeta,
	walkDevStack
} from '../utils/component-stack.js';
import { SVELTE_GRAB_UI_ATTR } from '../utils/hide-from-third-parties.js';

/** Elements that never render a box. */
const NON_RENDERED_TAGS: ReadonlySet<string> = new Set([
	'script',
	'style',
	'template',
	'noscript',
	'meta',
	'link',
	'head',
	'title',
	'base'
]);

const SVG_NS = 'http://www.w3.org/2000/svg';

/** CSS selector matching svelte-grab's own overlay roots. */
export const OWN_UI_SELECTOR = `[${SVELTE_GRAB_UI_ATTR}], [data-svelte-grab-outline]`;

/** The element itself is a svelte-grab overlay root (its subtree is ours). */
export function isOwnUiRoot(el: Element): boolean {
	return el.hasAttribute(SVELTE_GRAB_UI_ATTR) || el.hasAttribute('data-svelte-grab-outline');
}

/** The element is inside (or is) a svelte-grab overlay. */
export function isInOwnUi(el: Element): boolean {
	return el.closest(OWN_UI_SELECTOR) !== null;
}

/**
 * Elements the tools never report: non-rendered tags and SVG internals (the
 * `<svg>` root itself is kept).
 */
export function isIgnoredElement(el: Element): boolean {
	if (NON_RENDERED_TAGS.has(el.localName)) return true;
	return el.namespaceURI === SVG_NS && el.localName !== 'svg';
}

/** Rounded viewport-relative box. */
export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

export function getBox(el: Element): Box {
	const r = el.getBoundingClientRect();
	return {
		x: Math.round(r.left),
		y: Math.round(r.top),
		width: Math.round(r.width),
		height: Math.round(r.height)
	};
}

/** `x,y wxh` */
export function formatBox(box: Box): string {
	return `${box.x},${box.y} ${box.width}x${box.height}`;
}

/** Rendered, not hidden by CSS, and with a non-empty box (anywhere on the page). */
export function isVisible(el: Element): boolean {
	if (!el.isConnected) return false;
	const withCheck = el as Element & {
		checkVisibility?: (opts?: Record<string, boolean>) => boolean;
	};
	if (typeof withCheck.checkVisibility === 'function') {
		if (!withCheck.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
			return false;
		}
	} else {
		const view = el.ownerDocument.defaultView;
		const cs = view?.getComputedStyle(el);
		if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')) {
			return false;
		}
	}
	const r = el.getBoundingClientRect();
	return r.width > 0 && r.height > 0;
}

/** Whether the box intersects the current viewport. */
export function isInViewport(el: Element): boolean {
	const view = el.ownerDocument.defaultView;
	if (!view) return false;
	const r = el.getBoundingClientRect();
	return r.bottom > 0 && r.right > 0 && r.top < view.innerHeight && r.left < view.innerWidth;
}

/** The component instance an element renders inside. */
export interface ComponentInstance {
	/**
	 * Nearest `type: 'component'` dev stack entry. Svelte creates one per
	 * rendered instance, so its identity identifies the instance. `null` for
	 * the root component (it has no usage site).
	 */
	entry: DevStackEntry | null;
	/** `componentTag` of that entry, else the name derived from the element's file. */
	name: string | null;
}

/**
 * Component instance of `el`, read from the nearest element with meta (the
 * element itself first).
 */
export function getComponentInstance(el: Element): ComponentInstance {
	const metaEl = findMetaElement(el, { requireLoc: false });
	if (!metaEl) return { entry: null, name: null };
	const nearest = walkDevStack(getSvelteMeta(metaEl)).find((item) => item.kind === 'component');
	if (nearest) return { entry: nearest.entry, name: nearest.componentName };
	const loc = getSvelteLoc(metaEl);
	return { entry: null, name: loc ? extractComponentName(loc.file) : null };
}

/** Source and component naming for one element. */
export interface ElementSource {
	/** The element's own `loc` (where it is written), or `null`. */
	loc: SvelteSourceLocation | null;
	/**
	 * Component that owns the markup: derived from `loc.file` (the file to edit),
	 * else the instance name. `null` without any meta.
	 */
	component: string | null;
	instance: ComponentInstance;
}

export function getElementSource(el: Element): ElementSource {
	const loc = getSvelteLoc(el);
	const instance = getComponentInstance(el);
	const component = loc ? (extractComponentName(loc.file) ?? instance.name) : instance.name;
	return { loc, component, instance };
}

/**
 * Up to `max` class names, without Svelte's scoped `svelte-xxxx` hashes and
 * svelte-grab's redaction classes.
 */
export function getClasses(el: Element, max = 5): string[] {
	const out: string[] = [];
	for (const cls of Array.from(el.classList)) {
		if (/^svelte-[a-z0-9]+$/i.test(cls)) continue;
		out.push(cls);
		if (out.length >= max) break;
	}
	return out;
}

/** All candidate elements under `document.body`, in document order, minus our overlay. */
export function allPageElements(doc: Document = document): Element[] {
	const body = doc.body;
	if (!body) return [];
	const out: Element[] = [];
	const walk = (el: Element) => {
		for (const child of Array.from(el.children)) {
			if (isOwnUiRoot(child) || isIgnoredElement(child)) continue;
			out.push(child);
			walk(child);
		}
	};
	walk(body);
	return out;
}
