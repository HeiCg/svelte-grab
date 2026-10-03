/**
 * Small accessible role / name computation for the agent runtime.
 *
 * Not a full accname implementation: explicit `role`, implicit roles for the
 * common HTML tags, and a name from aria-labelledby / aria-label / native
 * labelling (label[for], wrapping label, alt, legend, caption, value) / content
 * (for roles that take their name from content) / title. Good enough to tell
 * the agent "button "Save"" and to disambiguate stable keys.
 */

/** Max length of a computed name; longer names are cut with an ellipsis. */
export const MAX_NAME_LENGTH = 80;

/** Roles an agent can act on. */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
	'button',
	'link',
	'textbox',
	'searchbox',
	'checkbox',
	'radio',
	'switch',
	'combobox',
	'listbox',
	'option',
	'slider',
	'spinbutton',
	'tab',
	'menuitem',
	'menuitemcheckbox',
	'menuitemradio',
	'treeitem'
]);

/** Landmark roles. */
export const LANDMARK_ROLES: ReadonlySet<string> = new Set([
	'banner',
	'navigation',
	'main',
	'contentinfo',
	'complementary',
	'region',
	'form',
	'search'
]);

/**
 * Roles whose accessible name comes from their text content. `listitem` is not
 * in the ARIA list, but naming list items by content makes `{#each}` rows
 * distinguishable in refs and stable keys, which is what the runtime needs.
 */
const NAME_FROM_CONTENT: ReadonlySet<string> = new Set([
	'button',
	'link',
	'heading',
	'checkbox',
	'radio',
	'switch',
	'option',
	'tab',
	'menuitem',
	'menuitemcheckbox',
	'menuitemradio',
	'treeitem',
	'cell',
	'gridcell',
	'columnheader',
	'rowheader',
	'row',
	'tooltip',
	'listitem'
]);

/** Elements that are sectioning content; a header/footer inside one is not a landmark. */
const SECTIONING = 'article, aside, main, nav, section';

function inputRole(el: HTMLInputElement): string | null {
	const type = (el.getAttribute('type') || 'text').toLowerCase();
	const hasList = el.hasAttribute('list');
	switch (type) {
		case 'checkbox':
			return 'checkbox';
		case 'radio':
			return 'radio';
		case 'range':
			return 'slider';
		case 'number':
			return 'spinbutton';
		case 'button':
		case 'submit':
		case 'reset':
		case 'image':
			return 'button';
		case 'search':
			return hasList ? 'combobox' : 'searchbox';
		case 'text':
		case 'email':
		case 'tel':
		case 'url':
			return hasList ? 'combobox' : 'textbox';
		case 'password':
			return 'textbox';
		default:
			return null;
	}
}

/**
 * Explicit `role` (first token) or the implicit role of the tag; `null` when the
 * element has no meaningful role (generic containers, text).
 */
export function computeRole(el: Element): string | null {
	const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
	if (explicit) return explicit.toLowerCase();

	const tag = el.localName;
	switch (tag) {
		case 'a':
		case 'area':
			return el.hasAttribute('href') ? 'link' : null;
		case 'button':
			return 'button';
		case 'input':
			return inputRole(el as HTMLInputElement);
		case 'select': {
			const s = el as HTMLSelectElement;
			return s.multiple || s.size > 1 ? 'listbox' : 'combobox';
		}
		case 'textarea':
			return 'textbox';
		case 'h1':
		case 'h2':
		case 'h3':
		case 'h4':
		case 'h5':
		case 'h6':
			return 'heading';
		case 'nav':
			return 'navigation';
		case 'main':
			return 'main';
		case 'aside':
			return 'complementary';
		case 'header':
			return el.parentElement?.closest(SECTIONING) ? null : 'banner';
		case 'footer':
			return el.parentElement?.closest(SECTIONING) ? null : 'contentinfo';
		case 'section':
			return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null;
		case 'form':
			return 'form';
		case 'search':
			return 'search';
		case 'article':
			return 'article';
		case 'ul':
		case 'ol':
		case 'menu':
			return 'list';
		case 'li':
			return 'listitem';
		case 'img':
			return el.getAttribute('alt') === '' ? 'presentation' : 'img';
		case 'table':
			return 'table';
		case 'tr':
			return 'row';
		case 'td':
			return 'cell';
		case 'th':
			return 'columnheader';
		case 'thead':
		case 'tbody':
		case 'tfoot':
			return 'rowgroup';
		case 'dialog':
			return 'dialog';
		case 'details':
		case 'fieldset':
			return 'group';
		case 'option':
			return 'option';
		case 'progress':
			return 'progressbar';
		case 'meter':
			return 'meter';
		case 'hr':
			return 'separator';
		case 'output':
			return 'status';
		default:
			return null;
	}
}

/** Collapse whitespace, trim and cap at MAX_NAME_LENGTH. */
export function normalizeText(text: string | null | undefined, max = MAX_NAME_LENGTH): string {
	const s = (text ?? '').replace(/\s+/g, ' ').trim();
	return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function textOf(el: Element | null | undefined): string {
	return el?.textContent ?? '';
}

function labelFor(el: Element): string {
	const id = el.getAttribute('id');
	const doc = el.ownerDocument;
	if (id && doc) {
		for (const label of Array.from(doc.querySelectorAll('label'))) {
			if (label.getAttribute('for') === id) return textOf(label);
		}
	}
	const wrapping = el.closest('label');
	return wrapping ? textOf(wrapping) : '';
}

/**
 * Accessible name of `el`. `role` is the already-computed role (pass it to avoid
 * recomputing); it decides whether the name may come from text content.
 */
export function computeName(el: Element, role: string | null = computeRole(el)): string {
	const doc = el.ownerDocument;

	const labelledBy = el.getAttribute('aria-labelledby');
	if (labelledBy && doc) {
		const text = labelledBy
			.split(/\s+/)
			.map((id) => textOf(doc.getElementById(id)))
			.join(' ');
		const name = normalizeText(text);
		if (name) return name;
	}

	const ariaLabel = normalizeText(el.getAttribute('aria-label'));
	if (ariaLabel) return ariaLabel;

	const tag = el.localName;
	if (tag === 'input' || tag === 'select' || tag === 'textarea') {
		const type = (el.getAttribute('type') || '').toLowerCase();
		if (tag === 'input' && (type === 'button' || type === 'submit' || type === 'reset')) {
			const value = normalizeText(el.getAttribute('value'));
			if (value) return value;
			if (type === 'submit') return 'Submit';
			if (type === 'reset') return 'Reset';
		}
		if (tag === 'input' && type === 'image') {
			const alt = normalizeText(el.getAttribute('alt'));
			if (alt) return alt;
		}
		const label = normalizeText(labelFor(el));
		if (label) return label;
		const placeholder = normalizeText(el.getAttribute('placeholder'));
		if (placeholder) return placeholder;
	} else if (tag === 'img' || tag === 'area') {
		const alt = normalizeText(el.getAttribute('alt'));
		if (alt) return alt;
	} else if (tag === 'fieldset') {
		const legend = normalizeText(textOf(el.querySelector(':scope > legend')));
		if (legend) return legend;
	} else if (tag === 'table') {
		const caption = normalizeText(textOf(el.querySelector(':scope > caption')));
		if (caption) return caption;
	} else if (tag === 'figure') {
		const caption = normalizeText(textOf(el.querySelector(':scope > figcaption')));
		if (caption) return caption;
	}

	if (role && NAME_FROM_CONTENT.has(role)) {
		const content = normalizeText(textOf(el));
		if (content) return content;
	}

	return normalizeText(el.getAttribute('title'));
}

/**
 * Whether an element without Svelte source info is still worth listing:
 * interactive elements, headings, landmarks and images with alt text.
 */
export function isWorthShowing(role: string | null, name: string): boolean {
	if (!role) return false;
	if (INTERACTIVE_ROLES.has(role) || LANDMARK_ROLES.has(role) || role === 'heading') return true;
	return role === 'img' && name !== '';
}

/** Roles that say nothing beyond the tag name; the tag is shown instead. */
export function isGenericRole(role: string | null): boolean {
	return !role || role === 'generic' || role === 'presentation' || role === 'none';
}
