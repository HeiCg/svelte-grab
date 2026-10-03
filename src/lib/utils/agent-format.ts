/**
 * Pure agent-output formatting for SvelteGrab.
 *
 * Extracted from SvelteGrab.svelte. Turns a resolved component stack (and the
 * grabbed element) into the structured text blocks SvelteGrab copies for a
 * coding agent. Pure: the small set of helpers/flags these need (HTML preview,
 * component-name/path shorteners, the `includeHtml` flag, and a stack resolver
 * for the multi-element case) are passed in explicitly rather than closed over.
 */
import type { StackEntry } from '../types.js';

/**
 * Dependencies for {@link formatForAgent} / {@link formatMultipleForAgent}.
 * These mirror the helpers SvelteGrab already has on hand.
 */
export interface AgentFormatDeps {
	/** Whether to embed the full HTML preview (vs. a one-line element summary). */
	includeHtml: boolean;
	/** Render a compact HTML preview of an element. */
	getHTMLPreview: (element: HTMLElement) => string;
	/** Extract a component name from a source file path. */
	extractComponentName: (file: string) => string | null;
	/** Shorten an absolute source path for display. */
	shortenPath: (file: string) => string;
}

/**
 * Format a single element's component stack for agent output.
 *
 * @param entries - The resolved component stack (nearest-first).
 * @param element - The grabbed element (optional; adds an element preview line).
 * @param deps - Formatting helpers and the `includeHtml` flag.
 * @returns The formatted multi-line agent text (empty string if no entries).
 */
export function formatForAgent(
	entries: StackEntry[],
	element: HTMLElement | null | undefined,
	deps: AgentFormatDeps
): string {
	if (entries.length === 0) return '';

	const { includeHtml, getHTMLPreview, extractComponentName, shortenPath } = deps;
	const parts: string[] = [];

	// Element info with tag and text
	if (element) {
		const tagName = element.tagName.toLowerCase();
		const role = element.getAttribute('role');
		const elementText = element.textContent?.trim();
		const truncatedText = elementText && elementText.length > 60
			? elementText.slice(0, 57) + '...'
			: elementText;

		if (includeHtml) {
			parts.push(getHTMLPreview(element));
		} else {
			const roleStr = role ? ` role="${role}"` : '';
			const textStr = truncatedText ? ` "${truncatedText}"` : '';
			parts.push(`Element: <${tagName}${roleStr}>${textStr}`);
		}
	}

	// Component name from first entry (the grabbed element's own component)
	const componentName = entries[0].componentName ?? extractComponentName(entries[0].file);
	if (componentName) {
		parts.push(`Component: <${componentName}>`);
	}

	// Full component stack
	if (entries.length > 1) {
		parts.push('Component Stack:');
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			// Component entries carry the child's tag; their file is the usage site.
			const name =
				entry.componentName || extractComponentName(entry.file) || entry.file.split('/').pop() || 'unknown';
			parts.push(`  ${i + 1}. ${name} (${shortenPath(entry.file)}:${entry.line})`);
		}
	} else {
		parts.push(`Defined in: ${shortenPath(entries[0].file)}:${entries[0].line}`);
	}

	return parts.join('\n');
}

/**
 * Format the "Used in / Defined in" file paths for a component stack.
 *
 * @param entries - The resolved component stack (nearest-first).
 * @param shortenPath - Shorten an absolute source path for display.
 * @returns The formatted paths text.
 */
export function formatPaths(
	entries: StackEntry[],
	shortenPath: (file: string) => string
): string {
	if (entries.length === 0) return 'No Svelte component found';

	const definedIn = entries[0];
	const usedIn = entries.find(e => e.file !== definedIn.file);

	const lines: string[] = [];
	if (usedIn) {
		lines.push(`Used in: ${shortenPath(usedIn.file)}:${usedIn.line}:${usedIn.column}`);
	}
	lines.push(`Defined in: ${shortenPath(definedIn.file)}:${definedIn.line}:${definedIn.column}`);

	return lines.join('\n');
}

/**
 * Format multiple selected elements for agent output.
 *
 * @param elements - The selected elements.
 * @param getStack - Resolve a component stack for a given element.
 * @param deps - Formatting helpers and the `includeHtml` flag.
 * @returns The combined formatted text for all elements.
 */
export function formatMultipleForAgent(
	elements: HTMLElement[],
	getStack: (element: HTMLElement) => StackEntry[],
	deps: AgentFormatDeps
): string {
	if (elements.length === 0) return '';
	if (elements.length === 1) {
		const elementStack = getStack(elements[0]);
		return formatForAgent(elementStack, elements[0], deps);
	}

	return elements.map((element, index) => {
		const elementStack = getStack(element);
		return `--- Element ${index + 1} ---\n${formatForAgent(elementStack, element, deps)}`;
	}).join('\n\n');
}
