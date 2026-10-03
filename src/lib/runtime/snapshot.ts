/**
 * `ui_snapshot`: indented outline of the page as the agent should see it.
 *
 * Only elements with a Svelte source location, or with an accessible role/name
 * worth showing (interactive, headings, landmarks, images with alt), get a
 * line. Each line: `eN <role|tag> "<name>" <Component> <file:line>`;
 * `detail: 'normal'` adds `box=x,y wxh` and up to 5 classes. Indentation
 * follows the nearest included ancestor.
 */
import { shortenPath } from '../utils/shared.js';
import { optionalInt, optionalString } from './args.js';
import { computeName, computeRole, isGenericRole, isWorthShowing } from './aria.js';
import {
	type Box,
	formatBox,
	getBox,
	getClasses,
	getElementSource,
	isIgnoredElement,
	isInViewport,
	isOwnUiRoot,
	isVisible
} from './node-info.js';
import { computeStableKeys, refRegistry, type RefRegistry } from './refs.js';
import type { RuntimeToolResult } from './types.js';

export const DEFAULT_MAX_NODES = 200;
const MAX_NODES_CAP = 2000;

export interface SnapshotNode {
	ref: string;
	stableKey: string;
	role: string | null;
	name: string;
	component: string | null;
	file: string | null;
	line: number | null;
	box: Box;
}

interface Collected {
	el: Element;
	depth: number;
	role: string | null;
	name: string;
}

/** `role` when it says something, else the tag name. */
export function roleOrTag(el: Element, role: string | null): string {
	return isGenericRole(role) ? el.localName : role!;
}

/** One output line (without indentation). */
export function formatNodeLine(
	el: Element,
	node: Pick<SnapshotNode, 'ref' | 'role' | 'name' | 'component' | 'file' | 'line' | 'box'>,
	detail: 'minimal' | 'normal'
): string {
	const parts = [node.ref, roleOrTag(el, node.role)];
	if (node.name) parts.push(JSON.stringify(node.name));
	if (node.component) parts.push(node.component);
	if (node.file) parts.push(`${shortenPath(node.file)}:${node.line}`);
	if (detail === 'normal') {
		parts.push(`box=${formatBox(node.box)}`);
		const classes = getClasses(el);
		if (classes.length) parts.push('.' + classes.join('.'));
	}
	return parts.join(' ');
}

export function uiSnapshot(
	args: Record<string, unknown>,
	registry: RefRegistry = refRegistry
): RuntimeToolResult {
	const scopeArg = optionalString(args, 'scope') ?? 'viewport';
	const detailArg = optionalString(args, 'detail') ?? 'minimal';
	if (detailArg !== 'minimal' && detailArg !== 'normal') {
		throw new Error(`"detail" must be "minimal" or "normal"`);
	}
	const detail: 'minimal' | 'normal' = detailArg;
	const maxNodes = optionalInt(args, 'maxNodes', DEFAULT_MAX_NODES, 1, MAX_NODES_CAP);

	let root: Element | null;
	let viewportOnly = false;
	let note: string | null = null;
	if (scopeArg === 'viewport' || scopeArg === 'page') {
		root = document.body;
		viewportOnly = scopeArg === 'viewport';
	} else {
		const resolved = registry.resolve(scopeArg);
		if (!resolved) {
			throw new Error(
				`Unknown scope "${scopeArg}": use "viewport", "page", an eN ref or a ui:// key`
			);
		}
		root = resolved.element;
		if (resolved.rebound) {
			note = `# ${resolved.previous} was stale; rebound to ${resolved.ref}`;
		}
	}
	if (!root) return { text: '(no document body)', data: { nodes: [], truncated: false } };

	const collected: Collected[] = [];
	let omitted = 0;

	const visit = (el: Element, depth: number, forceInclude: boolean) => {
		if (isOwnUiRoot(el) || isIgnoredElement(el)) return;

		if (viewportOnly) {
			const view = el.ownerDocument.defaultView;
			if (view?.getComputedStyle(el).display === 'none') return;
		}

		const role = computeRole(el);
		const name = computeName(el, role);
		const hasLoc = getElementSource(el).loc !== null;
		let include = forceInclude || hasLoc || isWorthShowing(role, name);
		if (include && viewportOnly && !forceInclude) {
			include = isVisible(el) && isInViewport(el);
		}

		let childDepth = depth;
		if (include) {
			if (collected.length < maxNodes) collected.push({ el, depth, role, name });
			else omitted++;
			childDepth = depth + 1;
		}
		for (const child of Array.from(el.children)) visit(child, childDepth, false);
	};

	if (root === document.body) {
		for (const child of Array.from(root.children)) visit(child, 0, false);
	} else {
		visit(root, 0, true);
	}

	const keys = computeStableKeys(collected.map((c) => c.el));
	const nodes: SnapshotNode[] = [];
	const lines: string[] = note ? [note] : [];

	for (const c of collected) {
		const stableKey = keys.get(c.el)!;
		const ref = registry.refFor(c.el, stableKey);
		const src = getElementSource(c.el);
		const node: SnapshotNode = {
			ref,
			stableKey,
			role: c.role,
			name: c.name,
			component: src.component,
			file: src.loc?.file ?? null,
			line: src.loc?.line ?? null,
			box: getBox(c.el)
		};
		nodes.push(node);
		lines.push('  '.repeat(c.depth) + formatNodeLine(c.el, node, detail));
	}

	if (nodes.length === 0) lines.push('(no nodes in scope)');
	if (omitted > 0) lines.push(`… ${omitted} more nodes (raise maxNodes or narrow scope)`);

	return { text: lines.join('\n'), data: { nodes, truncated: omitted > 0 } };
}
