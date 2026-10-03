/**
 * Pure DOM-to-string preview helpers for SvelteGrab.
 *
 * Extracted from SvelteGrab.svelte. These produce a compact, attribute-filtered
 * HTML snippet of an element for inclusion in agent output. Pure functions over
 * the DOM — no component state involved.
 */

/** Priority attributes for HTML preview (in order of importance). */
export const PRIORITY_ATTRS = [
	'class', 'id', 'type', 'href', 'src', 'name', 'placeholder',
	'aria-label', 'role', 'data-testid', 'data-cy', 'data-test'
] as const;

/**
 * Get a preview of the element's inner content.
 *
 * @param element - The element whose children/text to summarize.
 * @returns A compact string preview of the inner content (empty if none).
 */
export function getInnerPreview(element: HTMLElement): string {
	const children = element.children;

	if (children.length === 0) {
		const text = element.textContent?.trim() || '';
		if (!text) return '';
		return text.length > 100 ? text.slice(0, 97) + '...' : text;
	}

	if (children.length > 2) {
		const firstTag = children[0].tagName.toLowerCase();
		return `<${firstTag}>...</${firstTag}> (${children.length} children)`;
	}

	const childPreviews: string[] = [];
	for (let i = 0; i < Math.min(children.length, 2); i++) {
		const child = children[i] as HTMLElement;
		const childTag = child.tagName.toLowerCase();
		const childText = child.textContent?.trim() || '';
		const truncatedText = childText.length > 30 ? childText.slice(0, 27) + '...' : childText;
		childPreviews.push(`<${childTag}>${truncatedText}</${childTag}>`);
	}

	return childPreviews.join('\n  ');
}

/**
 * Generate an HTML preview of the element for the agent output.
 *
 * @param element - The element to render as a compact HTML snippet.
 * @returns A single- or multi-line HTML string preview of the element.
 */
export function getHTMLPreview(element: HTMLElement): string {
	const tagName = element.tagName.toLowerCase();

	// Collect relevant attributes
	const attrs: string[] = [];
	for (const attrName of PRIORITY_ATTRS) {
		const value = element.getAttribute(attrName);
		if (value) {
			// Truncate long values
			const truncated = value.length > 50 ? value.slice(0, 47) + '...' : value;
			attrs.push(`${attrName}="${truncated}"`);
		}
	}

	// Build opening tag
	const attrString = attrs.length > 0 ? ' ' + attrs.join(' ') : '';

	// Get inner content
	const innerContent = getInnerPreview(element);

	// Self-closing tags
	const selfClosing = ['img', 'input', 'br', 'hr', 'meta', 'link'];
	if (selfClosing.includes(tagName)) {
		return `<${tagName}${attrString} />`;
	}

	// If no inner content, use self-closing style for brevity
	if (!innerContent) {
		return `<${tagName}${attrString}></${tagName}>`;
	}

	return `<${tagName}${attrString}>\n  ${innerContent}\n</${tagName}>`;
}
