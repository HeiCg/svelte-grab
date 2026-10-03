/**
 * `ui_find`: locate elements by text, role, accessible name, component, source
 * file or CSS selector. Criteria are AND-combined.
 *
 * - `text` / `name`: case-insensitive substring. For `text`, only the innermost
 *   matches are kept (an ancestor whose text contains the match is dropped).
 * - `component`: one result per instance of the component (its top-level
 *   elements), matched on `componentTag` or the name derived from the file.
 * - `file`: suffix of the element's source file.
 */
import { shortenPath } from '../utils/shared.js';
import { optionalInt, optionalString } from './args.js';
import { computeName, computeRole, normalizeText } from './aria.js';
import {
	type Box,
	allPageElements,
	formatBox,
	getBox,
	getComponentInstance,
	getElementSource,
	isInOwnUi,
	isVisible
} from './node-info.js';
import { REF_ATTR, computeStableKeys, refRegistry, type RefRegistry } from './refs.js';
import { roleOrTag } from './snapshot.js';
import type { RuntimeToolResult } from './types.js';

export const DEFAULT_FIND_LIMIT = 20;
const FIND_LIMIT_CAP = 500;

export interface FindMatch {
	ref: string;
	stableKey: string;
	component: string | null;
	/** `file:line`, or `null` without source info. */
	source: string | null;
	role: string | null;
	name: string;
	box: Box;
	visible: boolean;
}

function parentWithMeta(el: Element): Element | null {
	let p = el.parentElement;
	while (p && getElementSource(p).loc === null && p !== el.ownerDocument.body) {
		p = p.parentElement;
	}
	return p && getElementSource(p).loc ? p : null;
}

/**
 * Whether `el` is a top-level element of an instance of `component`
 * (case-insensitive): its component instance differs from its parent's, or it
 * is the outermost element written in `<component>.svelte`.
 */
export function isComponentRoot(el: Element, component: string): boolean {
	const wanted = component.toLowerCase();
	const src = getElementSource(el);
	if (!src.loc) return false;
	const parent = parentWithMeta(el);

	const instName = src.instance.name?.toLowerCase();
	if (instName === wanted) {
		if (!parent || getComponentInstance(parent).entry !== src.instance.entry) return true;
	}

	if (src.component?.toLowerCase() === wanted) {
		const parentFile = parent ? getElementSource(parent).loc?.file : undefined;
		if (parentFile !== src.loc.file) return true;
	}
	return false;
}

export function uiFind(
	args: Record<string, unknown>,
	registry: RefRegistry = refRegistry
): RuntimeToolResult {
	const text = optionalString(args, 'text')?.toLowerCase();
	const role = optionalString(args, 'role')?.toLowerCase();
	const name = optionalString(args, 'name')?.toLowerCase();
	const component = optionalString(args, 'component');
	const file = optionalString(args, 'file')?.replace(/\\/g, '/');
	const selector = optionalString(args, 'selector');
	const limit = optionalInt(args, 'limit', DEFAULT_FIND_LIMIT, 1, FIND_LIMIT_CAP);

	if (!text && !role && !name && !component && !file && !selector) {
		throw new Error('ui_find needs at least one of: text, role, name, component, file, selector');
	}

	let candidates: Element[];
	if (selector) {
		try {
			candidates = Array.from(document.querySelectorAll(selector)).filter((el) => !isInOwnUi(el));
		} catch {
			throw new Error(`Invalid CSS selector: ${selector}`);
		}
	} else {
		candidates = allPageElements();
	}

	let matches = candidates.filter((el) => {
		const elRole = computeRole(el);
		if (role && elRole !== role) return false;
		if (name && !computeName(el, elRole).toLowerCase().includes(name)) return false;
		if (text && !normalizeText(el.textContent, Infinity).toLowerCase().includes(text)) {
			return false;
		}
		if (file) {
			const loc = getElementSource(el).loc;
			if (!loc || !loc.file.replace(/\\/g, '/').endsWith(file)) return false;
		}
		if (component && !isComponentRoot(el, component)) return false;
		return true;
	});

	if (text) {
		// Keep innermost matches: drop any match that contains another match.
		// Matches are in document order, so a descendant match (if any) is the next one.
		matches = matches.filter((el, i) => !(i + 1 < matches.length && el.contains(matches[i + 1])));
	}

	const total = matches.length;
	const shown = matches.slice(0, limit);
	const keys = computeStableKeys(shown);

	const results: FindMatch[] = [];
	const lines: string[] = [];
	for (const el of shown) {
		const stableKey = keys.get(el)!;
		const ref = registry.refFor(el, stableKey);
		const elRole = computeRole(el);
		const src = getElementSource(el);
		const match: FindMatch = {
			ref,
			stableKey,
			component: src.component,
			source: src.loc ? `${src.loc.file}:${src.loc.line}` : null,
			role: elRole,
			name: computeName(el, elRole),
			box: getBox(el),
			visible: isVisible(el)
		};
		results.push(match);

		const parts = [ref, roleOrTag(el, elRole)];
		if (match.name) parts.push(JSON.stringify(match.name));
		if (match.component) parts.push(match.component);
		if (src.loc) parts.push(`${shortenPath(src.loc.file)}:${src.loc.line}`);
		parts.push(`box=${formatBox(match.box)}`);
		if (!match.visible) parts.push('(hidden)');
		lines.push(parts.join(' '));
	}

	const header =
		total === 0
			? 'No matches.'
			: `${total} match${total === 1 ? '' : 'es'}${total > shown.length ? ` (showing ${shown.length}; raise limit to see more)` : ''}. Locator: [${REF_ATTR}="<ref>"]`;

	return {
		text: [header, ...lines].join('\n'),
		data: { matches: results, total, truncated: total > shown.length }
	};
}
