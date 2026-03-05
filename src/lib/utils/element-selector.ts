/**
 * CSS selector generation for element reacquisition.
 *
 * Used by history persistence to relocate previously-grabbed elements
 * after page navigation or reload.
 */

/**
 * Ordered list of attributes to try when building a unique selector.
 * These are commonly used as stable test/accessibility identifiers.
 */
const SELECTOR_ATTRIBUTES = [
	'data-testid',
	'data-test-id',
	'data-test',
	'data-cy',
	'data-qa',
	'aria-label',
	'role',
	'name',
	'title',
	'alt'
] as const;

/** Maximum attribute value length to consider for selector generation */
const MAX_ATTR_VALUE_LENGTH = 100;

/**
 * Check whether a selector matches exactly one element in the document.
 */
function isUnique(selector: string): boolean {
	try {
		return document.querySelectorAll(selector).length === 1;
	} catch {
		return false;
	}
}

/**
 * Generate a CSS selector that uniquely identifies the given element.
 *
 * Uses a 3-tier strategy:
 * 1. ID-based selector (`#id`)
 * 2. Attribute-based selector (`tag[attr="value"]`)
 * 3. Structural path (`tag:nth-child(n) > tag:nth-child(n)`)
 */
export function createElementSelector(element: Element): string {
	// Tier 1: ID selector
	if (element.id) {
		const selector = `#${CSS.escape(element.id)}`;
		if (isUnique(selector)) {
			return selector;
		}
	}

	// Tier 2: Attribute-based selector
	const tag = element.tagName.toLowerCase();
	for (const attr of SELECTOR_ATTRIBUTES) {
		const value = element.getAttribute(attr);
		if (value && value.length <= MAX_ATTR_VALUE_LENGTH) {
			const selector = `${tag}[${attr}="${CSS.escape(value)}"]`;
			if (isUnique(selector)) {
				return selector;
			}
		}
	}

	// Tier 3: Structural nth-child path
	return buildStructuralSelector(element);
}

/**
 * Build a structural selector by walking up the DOM, using
 * `tag:nth-child(n)` at each level until we reach an element
 * with an id or the body element.
 */
function buildStructuralSelector(element: Element): string {
	const parts: string[] = [];
	let current: Element | null = element;

	while (current && current !== document.body && current !== document.documentElement) {
		const tag = current.tagName.toLowerCase();

		// If this ancestor has an id, anchor there
		if (current.id && current !== element) {
			parts.unshift(`#${CSS.escape(current.id)}`);
			break;
		}

		const parent: Element | null = current.parentElement;
		if (!parent) {
			parts.unshift(tag);
			break;
		}

		// Calculate nth-child index (1-based)
		const siblings = Array.from(parent.children);
		const index = siblings.indexOf(current) + 1;
		parts.unshift(`${tag}:nth-child(${index})`);

		current = parent;
	}

	return parts.join(' > ');
}

/**
 * Attempt to relocate an element using a previously-generated selector.
 *
 * Returns the first matching HTMLElement, or null if not found or
 * the selector is invalid.
 */
export function reacquireElement(selector: string): HTMLElement | null {
	if (!selector) return null;
	try {
		const el = document.querySelector(selector);
		return el instanceof HTMLElement ? el : null;
	} catch {
		return null;
	}
}
