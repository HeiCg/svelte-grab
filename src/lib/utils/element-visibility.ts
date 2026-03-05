/**
 * Simple element visibility check.
 * Determines whether an element is visually rendered on the page.
 */

/**
 * Check if an element is visible based on computed CSS properties.
 * Accepts an optional pre-computed CSSStyleDeclaration to avoid
 * redundant getComputedStyle calls when the caller already has one.
 */
export function isElementVisible(element: Element, computedStyle?: CSSStyleDeclaration): boolean {
	try {
		const style = computedStyle ?? window.getComputedStyle(element);

		if (style.display === 'none') return false;
		if (style.visibility === 'hidden') return false;
		if (style.opacity === '0') return false;

		return true;
	} catch {
		// If getComputedStyle fails (e.g. detached element), assume not visible
		return false;
	}
}
