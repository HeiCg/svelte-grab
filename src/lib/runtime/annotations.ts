/**
 * Annotation mode, DOM side (docs/agent-runtime-spec.md, Phase 6): the tab's
 * pending annotations, the refs of annotated elements and the page tool
 * `ui_annotations`.
 *
 * SvelteGrab adds annotations here; the agent reads them with `ui_annotations`
 * and passes their refs to `ui_inspect`. Refs go through the shared ref
 * registry, so `[data-sg-ref="eN"]` works as a locator too.
 */
import { shortenPath } from '../utils/shared.js';
import {
	AnnotationStore,
	formatAnnotationsForAgent,
	type Annotation,
	type AnnotationRef
} from '../utils/annotations.js';
import { optionalBoolean } from './args.js';
import { getElementSource } from './node-info.js';
import { computeStableKeys, refRegistry, type RefRegistry } from './refs.js';
import type { RuntimeToolResult } from './types.js';

/** The tab's pending annotations (one store per page load, like the refs). */
export const annotationStore = new AnnotationStore<Element>();

/** Ref, stable key, component and `file:line` of each element (registers the refs). */
export function describeAnnotationTargets(
	elements: Element[],
	registry: RefRegistry = refRegistry
): AnnotationRef[] {
	const keys = computeStableKeys(elements);
	return elements.map((el) => {
		const stableKey = keys.get(el)!;
		const src = getElementSource(el);
		return {
			ref: registry.refFor(el, stableKey),
			stableKey,
			component: src.component,
			source: src.loc ? `${src.loc.file}:${src.loc.line}` : null
		};
	});
}

/** Annotate `elements` with `comment`. `null` when nothing is selected or the store is full. */
export function addAnnotation(
	comment: string,
	elements: Element[],
	store: AnnotationStore<Element> = annotationStore,
	registry: RefRegistry = refRegistry,
	now: number = Date.now()
): Annotation | null {
	const unique = [...new Set(elements)];
	if (unique.length === 0 || store.isFull) return null;
	return store.add(
		{ comment, refs: describeAnnotationTargets(unique, registry), targets: unique },
		now
	);
}

/**
 * Re-resolve every stored ref: live ones stay, re-rendered ones are rebound by
 * stable key (new ref), and ones that match nothing are flagged `stale`.
 */
export function refreshAnnotationRefs(
	store: AnnotationStore<Element> = annotationStore,
	registry: RefRegistry = refRegistry
): void {
	for (const annotation of store.list()) {
		const oldTargets = store.targetsOf(annotation.id);
		let changed = false;
		const targets: Element[] = [];
		const refs = annotation.refs.map((r, i): AnnotationRef => {
			const resolved = registry.resolve(r.ref) ?? registry.resolve(r.stableKey);
			if (!resolved) {
				if (oldTargets[i]) targets.push(oldTargets[i]);
				if (r.stale) return r;
				changed = true;
				return { ...r, stale: true };
			}
			targets.push(resolved.element);
			if (resolved.ref === r.ref && resolved.stableKey === r.stableKey && !r.stale) return r;
			changed = true;
			return { ref: resolved.ref, stableKey: resolved.stableKey, component: r.component, source: r.source };
		});
		if (changed || targets.some((el, i) => el !== oldTargets[i])) {
			store.replaceRefs(annotation.id, refs, targets);
		}
	}
}

/**
 * `ui_annotations`: the pending annotations `{annotations, instruction}` with
 * their refs re-resolved. `clear: true` marks them consumed (the store empties).
 */
export function uiAnnotations(
	args: Record<string, unknown>,
	store: AnnotationStore<Element> = annotationStore,
	registry: RefRegistry = refRegistry
): RuntimeToolResult {
	const clear = optionalBoolean(args, 'clear') ?? false;
	refreshAnnotationRefs(store, registry);
	const annotations = store.list();
	const instruction = store.instruction;

	let text: string;
	if (annotations.length === 0) {
		text =
			'No pending annotations. The human adds them in the page: hold the SvelteGrab modifier, ' +
			'select elements and press N.';
	} else {
		text = formatAnnotationsForAgent(annotations, instruction, shortenPath);
		if (clear) text += '\n\nThese annotations are now marked as consumed.';
	}

	if (clear) store.clear();
	return { text, data: { annotations, instruction, cleared: clear } };
}
