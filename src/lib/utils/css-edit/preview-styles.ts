/**
 * Live inline-style preview for the SvelteStyleGrab edit panel.
 *
 * Ported and adapted from react-grab's `utils/preview-styles.ts`. The panel
 * previews pending CSS edits by writing them as inline styles on the live DOM
 * element, backing up whatever inline value (and `!important` priority) was
 * there before so it can be restored exactly. The tool never persists source —
 * preview is the visual feedback only; the agent commits the real change.
 *
 * This module keeps a module-level registry keyed by element so the component
 * can call `restoreAll()` on close / destroy and never leak inline styles onto
 * the page, even if multiple elements were previewed in one session.
 *
 * SSR-safe: every function is a no-op when the element has no `.style`.
 */

interface BackupEntry {
	value: string;
	priority: string;
}

interface ElementPreview {
	element: HTMLElement;
	/** Original inline value/priority per CSS property, captured on first write. */
	backups: Map<string, BackupEntry>;
}

const hasInlineStyle = (
	element: Element
): element is HTMLElement & { style: CSSStyleDeclaration } =>
	'style' in element && (element as HTMLElement).style instanceof CSSStyleDeclaration;

// Per-element preview state. Keyed by the element itself so the same element
// reuses one backup map (idempotent across repeated writes to a property).
const registry = new Map<HTMLElement, ElementPreview>();

function getOrCreate(element: HTMLElement): ElementPreview {
	let preview = registry.get(element);
	if (!preview) {
		preview = { element, backups: new Map() };
		registry.set(element, preview);
	}
	return preview;
}

/**
 * Apply a single CSS declaration to `element` as an inline style, backing up
 * the prior inline value (once) so it can be restored. `cssProperties` lets one
 * logical edit fan out to several longhands (e.g. all four padding sides).
 *
 * Idempotent: re-applying the same property only overwrites the live value, the
 * original backup is captured exactly once.
 */
export function applyPreview(
	element: HTMLElement,
	cssProperties: readonly string[],
	cssValue: string
): void {
	if (!hasInlineStyle(element)) return;
	const preview = getOrCreate(element);
	for (const cssProperty of cssProperties) {
		if (!preview.backups.has(cssProperty)) {
			preview.backups.set(cssProperty, {
				value: element.style.getPropertyValue(cssProperty),
				priority: element.style.getPropertyPriority(cssProperty)
			});
		}
		element.style.setProperty(cssProperty, cssValue);
	}
}

/**
 * Restore every previewed property on `element` to its original inline state
 * and drop it from the registry. Safe to call on an element that was never
 * previewed.
 */
export function restorePreview(element: HTMLElement): void {
	const preview = registry.get(element);
	if (!preview) return;
	if (hasInlineStyle(element)) {
		for (const [cssProperty, { value, priority }] of preview.backups) {
			if (value) {
				element.style.setProperty(cssProperty, value, priority);
			} else {
				element.style.removeProperty(cssProperty);
			}
		}
	}
	registry.delete(element);
}

/** Restore every previewed element. Call on panel close / component destroy. */
export function restoreAll(): void {
	// Snapshot keys first; restorePreview mutates the registry as it goes.
	for (const element of Array.from(registry.keys())) {
		restorePreview(element);
	}
}

/** True when `element` currently has previewed (un-restored) inline styles. */
export function hasPreview(element: HTMLElement): boolean {
	return (registry.get(element)?.backups.size ?? 0) > 0;
}
