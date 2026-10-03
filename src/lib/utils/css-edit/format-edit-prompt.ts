/**
 * Build the coding-agent prompt for a set of live CSS edits.
 *
 * Ported and adapted from react-grab's `utils/format-edit-prompt.ts`. Given the
 * selected element's source location (from `__svelte_meta`) and the set of
 * changed properties (label, from, to + the concrete CSS declarations), this
 * produces a clean, canonical prompt the coding agent can act on. The tool never
 * writes source — this prompt is the hand-off; the agent commits the real edit.
 *
 * Pure / SSR-safe.
 */

/** One changed property in an edit session. */
export interface EditChange {
	/** Stable property key (may be a comma-joined aggregate). */
	key: string;
	/** Human label, e.g. "padding". */
	label: string;
	/** Original computed value shown before editing (e.g. "8px"). */
	from: string;
	/** New value after editing (e.g. "16px"). */
	to: string;
	/** Concrete CSS declarations to apply, e.g. ["padding: 16px;"]. */
	declarations: string[];
}

/** Source location + component identity for the edited element. */
export interface EditTarget {
	/** Shortened source path, e.g. "src/lib/Card.svelte". */
	filePath?: string;
	/** 1-based line number of the element. */
	lineNumber?: number;
	/** Component / tag name for the header, e.g. "Card" or "div". */
	componentName?: string;
}

function targetHeader(target: EditTarget): string {
	const name = target.componentName ?? 'element';
	const location =
		target.filePath !== undefined
			? `${target.filePath}${target.lineNumber ? `:${target.lineNumber}` : ''}`
			: 'its source';
	return `<${name}> at ${location}`;
}

/** Dedupe + collect the concrete CSS declarations across all changes. */
function collectDeclarations(changes: readonly EditChange[]): string[] {
	const byProperty = new Map<string, string>();
	for (const change of changes) {
		for (const declaration of change.declarations) {
			const colon = declaration.indexOf(':');
			const property = colon >= 0 ? declaration.slice(0, colon).trim() : declaration;
			byProperty.set(property, declaration);
		}
	}
	return Array.from(byProperty.values());
}

/** Short "padding 8px→16px; color #fff→#000" summary of the changes. */
export function formatChangeSummary(changes: readonly EditChange[]): string {
	return changes.map((c) => `${c.label} ${c.from}→${c.to}`).join('; ');
}

/**
 * Build the full agent prompt for a single edited element.
 *
 * @example
 * Apply these style changes canonically in the source for <Card> at
 * src/lib/Card.svelte:12: padding 8px→16px; color #fff→#000.
 *
 * ```css
 * padding: 16px;
 * color: #000000;
 * ```
 *
 * Prefer editing the component's styles (a class, scoped <style>, or the
 * existing style system), not adding inline styles.
 */
export function formatEditPrompt(target: EditTarget, changes: readonly EditChange[]): string {
	if (changes.length === 0) return '';

	const header = targetHeader(target);
	const summary = formatChangeSummary(changes);
	const declarations = collectDeclarations(changes);

	return [
		`Apply these style changes canonically in the source for ${header}: ${summary}.`,
		'',
		'```css',
		...declarations,
		'```',
		'',
		"Prefer editing the component's styles (a class, scoped <style>, or the existing style system), not adding inline styles."
	].join('\n');
}
