import type { A11yIssue, A11yReport } from '../types.js';
import { shortenPath, type SvelteElement } from './shared.js';

/**
 * Educational "why this matters" text for each a11y rule
 */
const WHY_TEXT: Record<string, string> = {
	'input-label': 'Screen readers announce form fields by their label. Without one, users cannot identify what information to enter.',
	'button-label': 'Buttons without accessible text are announced as just "button" by screen readers, giving users no indication of the action.',
	'img-alt': 'Screen readers read alt text to describe images. Without it, visually impaired users miss the content entirely.',
	'img-alt-empty': 'Empty alt indicates a decorative image. Adding role="presentation" makes this explicit for assistive technology.',
	'contrast': 'Low contrast makes text unreadable for users with visual impairments, including the ~300 million people with color vision deficiency.',
	'tabindex-positive': 'Positive tabindex values create a custom tab order that conflicts with the visual layout, confusing keyboard users.',
	'heading-order': 'Screen reader users navigate by headings. Skipped levels break the document outline and make navigation unpredictable.',
	'form-landmark': 'Forms without labels are hard to distinguish when a page has multiple forms. Screen readers list forms by their label.',
	'interactive-role': 'Clickable elements without semantic roles are invisible to assistive technology. Keyboard users cannot reach or activate them.',
	'link-text': 'Generic link text like "click here" provides no context when screen readers list all links on a page. Users cannot distinguish between links.',
	'html-lang': 'Screen readers use the lang attribute to switch pronunciation rules. Without it, content may be read with the wrong language\'s pronunciation.',
	'autocomplete': 'Autocomplete attributes help browsers and password managers fill forms correctly, reducing errors for all users including those with cognitive disabilities.',
	'media-alternative': 'Users who are deaf or hard of hearing cannot access audio content. Users who are blind cannot access video content. Alternatives are essential.',
	'landmark-regions': 'Landmark regions let screen reader users jump directly to major page sections. Without them, users must navigate through every element sequentially.',
	'skip-nav': 'Keyboard users must tab through all navigation links on every page load. A skip link lets them jump directly to the main content.',
	'focus-visible': 'Keyboard users rely on visible focus indicators to know which element is active. Removing focus styles makes keyboard navigation impossible.',
};

/**
 * Enrich an issue with the "why" educational text and optional element reference
 */
function withWhy(issue: A11yIssue, el?: HTMLElement): A11yIssue {
	issue.why = WHY_TEXT[issue.rule];
	if (el) issue.element = el;
	return issue;
}

/**
 * Get the accessible name for an element
 */
function getAccessibleName(el: HTMLElement): string {
	return (
		el.getAttribute('aria-label') ||
		el.getAttribute('aria-labelledby') && getLabelledByText(el) ||
		el.getAttribute('title') ||
		el.textContent?.trim() ||
		''
	);
}

function getLabelledByText(el: HTMLElement): string {
	const ids = el.getAttribute('aria-labelledby')?.split(/\s+/) || [];
	return ids.map(id => document.getElementById(id)?.textContent?.trim() || '').join(' ');
}

/**
 * Get a short HTML representation for display
 */
function elementHtml(el: HTMLElement, maxLen = 80): string {
	const outer = el.outerHTML;
	if (outer.length <= maxLen) return outer;
	// Show opening tag only
	const tag = el.tagName.toLowerCase();
	const attrs = Array.from(el.attributes)
		.map(a => `${a.name}="${a.value.slice(0, 30)}"`)
		.join(' ');
	const opening = `<${tag} ${attrs}>`.slice(0, maxLen);
	return opening.endsWith('>') ? opening : opening + '...>';
}

/**
 * Get element's svelte source location
 */
function getElementSource(el: HTMLElement): { file?: string; line?: number } {
	const meta = (el as SvelteElement).__svelte_meta;
	if (meta?.loc) {
		return { file: shortenPath(meta.loc.file), line: meta.loc.line };
	}
	return {};
}

/**
 * Parse a color to RGB
 */
function parseColor(color: string): { r: number; g: number; b: number } | null {
	// Handle rgb/rgba
	const rgbMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
	if (rgbMatch) {
		return { r: parseInt(rgbMatch[1]), g: parseInt(rgbMatch[2]), b: parseInt(rgbMatch[3]) };
	}

	// Handle hex
	const hexMatch = color.match(/^#([0-9a-f]{3,8})$/i);
	if (hexMatch) {
		let hex = hexMatch[1];
		if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
		return {
			r: parseInt(hex.slice(0, 2), 16),
			g: parseInt(hex.slice(2, 4), 16),
			b: parseInt(hex.slice(4, 6), 16)
		};
	}

	return null;
}

/**
 * Calculate relative luminance (WCAG 2.0)
 */
function relativeLuminance(r: number, g: number, b: number): number {
	const [rs, gs, bs] = [r, g, b].map(c => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	});
	return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Calculate contrast ratio between two colors
 */
export function contrastRatio(fg: string, bg: string): number | null {
	const fgColor = parseColor(fg);
	const bgColor = parseColor(bg);
	if (!fgColor || !bgColor) return null;

	const l1 = relativeLuminance(fgColor.r, fgColor.g, fgColor.b);
	const l2 = relativeLuminance(bgColor.r, bgColor.g, bgColor.b);

	const lighter = Math.max(l1, l2);
	const darker = Math.min(l1, l2);

	return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Suggest a color with sufficient contrast
 */
function suggestContrastColor(bg: string, minRatio: number): string | null {
	const bgColor = parseColor(bg);
	if (!bgColor) return null;

	const bgLum = relativeLuminance(bgColor.r, bgColor.g, bgColor.b);

	// Try darkening or lightening
	for (let step = 0; step <= 255; step += 5) {
		// Try dark
		const darkR = Math.max(0, bgColor.r - step);
		const darkG = Math.max(0, bgColor.g - step);
		const darkB = Math.max(0, bgColor.b - step);
		const darkLum = relativeLuminance(darkR, darkG, darkB);
		const darkRatio = (Math.max(bgLum, darkLum) + 0.05) / (Math.min(bgLum, darkLum) + 0.05);
		if (darkRatio >= minRatio) {
			return `#${darkR.toString(16).padStart(2, '0')}${darkG.toString(16).padStart(2, '0')}${darkB.toString(16).padStart(2, '0')}`;
		}
	}

	return '#000000';
}

/**
 * Check for input without associated label
 */
function checkInputLabels(root: HTMLElement): A11yIssue[] {
	const issues: A11yIssue[] = [];
	const inputs = root.querySelectorAll('input, select, textarea');

	inputs.forEach(input => {
		const el = input as HTMLInputElement;
		if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return;

		const hasLabel =
			el.id && root.querySelector(`label[for="${el.id}"]`) ||
			el.closest('label') ||
			el.getAttribute('aria-label') ||
			el.getAttribute('aria-labelledby');

		if (!hasLabel) {
			const { file, line } = getElementSource(el);
			const tag = el.tagName.toLowerCase();
			const typeAttr = el.type ? ` type="${el.type}"` : '';
			issues.push(withWhy({
				severity: 'critical',
				rule: 'input-label',
				message: `Input without associated label`,
				elementHtml: elementHtml(el),
				file,
				line,
				fix: `Add a label to the field`,
				fixCode: el.id
					? `<label for="${el.id}">Description</label>\n<${tag}${typeAttr} id="${el.id}">`
					: `<${tag}${typeAttr} aria-label="Field description">`
			}, el));
		}
	});

	return issues;
}

/**
 * Check for buttons without accessible text
 */
function checkButtonLabels(root: HTMLElement): A11yIssue[] {
	const issues: A11yIssue[] = [];
	const buttons = root.querySelectorAll('button, [role="button"]');

	buttons.forEach(btn => {
		const el = btn as HTMLElement;
		const name = getAccessibleName(el);

		if (!name) {
			const { file, line } = getElementSource(el);
			issues.push(withWhy({
				severity: 'critical',
				rule: 'button-label',
				message: `Button without accessible text`,
				elementHtml: elementHtml(el),
				file,
				line,
				fix: `Add aria-label to the button`,
				fixCode: `<button aria-label="Action description">...</button>`
			}, el));
		}
	});

	return issues;
}

/**
 * Check for images without alt text
 */
function checkImageAlts(root: HTMLElement): A11yIssue[] {
	const issues: A11yIssue[] = [];
	const images = root.querySelectorAll('img');

	images.forEach(img => {
		const el = img as HTMLImageElement;
		const hasAlt = el.hasAttribute('alt');
		const altEmpty = el.getAttribute('alt') === '';

		if (!hasAlt) {
			const { file, line } = getElementSource(el);
			issues.push(withWhy({
				severity: 'critical',
				rule: 'img-alt',
				message: `Image missing alt attribute`,
				elementHtml: elementHtml(el),
				file,
				line,
				fix: `Add descriptive alt text`,
				fixCode: `<img src="..." alt="Image description">`
			}, el));
		} else if (altEmpty && !el.getAttribute('role')) {
			const { file, line } = getElementSource(el);
			issues.push(withWhy({
				severity: 'info',
				rule: 'img-alt-empty',
				message: `Image with empty alt (decorative). Consider adding role="presentation"`,
				elementHtml: elementHtml(el),
				file,
				line,
				fix: `Add role="presentation" for decorative images`,
				fixCode: `<img src="..." alt="" role="presentation">`
			}, el));
		}
	});

	return issues;
}

/**
 * Check contrast ratios for text elements
 */
function checkContrast(root: HTMLElement): A11yIssue[] {
	const issues: A11yIssue[] = [];
	const textElements = root.querySelectorAll('p, span, a, h1, h2, h3, h4, h5, h6, li, td, th, label, button, div');

	const checked = new Set<string>();
	textElements.forEach(el => {
		const element = el as HTMLElement;
		if (!element.textContent?.trim()) return;

		const computed = window.getComputedStyle(element);
		const fg = computed.color;
		const bg = getEffectiveBackground(element);

		const key = `${fg}|${bg}`;
		if (checked.has(key)) return;
		checked.add(key);

		const ratio = contrastRatio(fg, bg);
		if (ratio === null) return;

		const fontSize = parseFloat(computed.fontSize);
		const fontWeight = parseInt(computed.fontWeight);
		const isLargeText = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
		const minRatio = isLargeText ? 3 : 4.5;

		if (ratio < minRatio) {
			const { file, line } = getElementSource(element);
			const suggestion = suggestContrastColor(bg, minRatio);
			issues.push(withWhy({
				severity: ratio < 3 ? 'critical' : 'warning',
				rule: 'contrast',
				message: `Insufficient contrast: ${ratio.toFixed(1)}:1 (WCAG AA minimum: ${minRatio}:1)`,
				elementHtml: elementHtml(element),
				file,
				line,
				fix: `Foreground: ${fg}\nBackground: ${bg}${suggestion ? `\nSuggestion: use ${suggestion} (ratio ${minRatio}:1+)` : ''}`,
			}, element));
		}
	});

	return issues;
}

/**
 * Get the effective background color by walking up the tree
 */
function getEffectiveBackground(el: HTMLElement): string {
	let current: HTMLElement | null = el;
	while (current) {
		const bg = window.getComputedStyle(current).backgroundColor;
		if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
			return bg;
		}
		current = current.parentElement;
	}
	return 'rgb(255, 255, 255)';
}

/**
 * Check tab order issues
 */
function checkTabOrder(root: HTMLElement): A11yIssue[] {
	const issues: A11yIssue[] = [];
	const withTabindex = root.querySelectorAll('[tabindex]');

	withTabindex.forEach(el => {
		const element = el as HTMLElement;
		const tabindex = parseInt(element.getAttribute('tabindex') || '0');

		if (tabindex > 0) {
			const { file, line } = getElementSource(element);
			issues.push(withWhy({
				severity: 'warning',
				rule: 'tabindex-positive',
				message: `tabindex="${tabindex}" breaks natural focus order`,
				elementHtml: elementHtml(element),
				file,
				line,
				fix: `Use tabindex="0" for natural order or tabindex="-1" to remove from tab flow`
			}, element));
		}
	});

	return issues;
}

/**
 * Check heading hierarchy
 */
function checkHeadingHierarchy(root: HTMLElement): A11yIssue[] {
	const issues: A11yIssue[] = [];
	const headings = root.querySelectorAll('h1, h2, h3, h4, h5, h6');

	let lastLevel = 0;
	headings.forEach(heading => {
		const el = heading as HTMLElement;
		const level = parseInt(el.tagName[1]);

		if (lastLevel > 0 && level > lastLevel + 1) {
			const { file, line } = getElementSource(el);
			issues.push(withWhy({
				severity: 'warning',
				rule: 'heading-order',
				message: `Heading skips from h${lastLevel} to h${level}`,
				elementHtml: elementHtml(el),
				file,
				line,
				fix: `Use h${lastLevel + 1} instead of h${level} to maintain hierarchy`
			}, el));
		}
		lastLevel = level;
	});

	return issues;
}

/**
 * Check form landmarks
 */
function checkFormLandmarks(root: HTMLElement): A11yIssue[] {
	const issues: A11yIssue[] = [];
	const forms = root.querySelectorAll('form');

	forms.forEach(form => {
		const el = form as HTMLFormElement;
		if (!el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !el.getAttribute('role')) {
			const { file, line } = getElementSource(el);
			issues.push(withWhy({
				severity: 'warning',
				rule: 'form-landmark',
				message: `Form without landmark (aria-label)`,
				elementHtml: elementHtml(el),
				file,
				line,
				fix: `Add aria-label to the form`,
				fixCode: `<form aria-label="Form description">`
			}, el));
		}
	});

	return issues;
}

/**
 * Check for interactive elements with missing roles
 */
function checkInteractiveRoles(root: HTMLElement): A11yIssue[] {
	const issues: A11yIssue[] = [];
	// Check divs and spans that appear interactive but lack proper ARIA roles
	// Svelte 5 uses addEventListener (not HTML attributes), so we check multiple signals
	const candidates = root.querySelectorAll('div, span');

	candidates.forEach(el => {
		const element = el as HTMLElement;
		if (element.getAttribute('role')) return; // already has role

		const isInteractive =
			element.onclick !== null ||
			element.getAttribute('tabindex') === '0' ||
			element.hasAttribute('data-action') ||
			element.style.cursor === 'pointer' ||
			window.getComputedStyle(element).cursor === 'pointer';

		if (isInteractive) {
			const { file, line } = getElementSource(element);
			issues.push(withWhy({
				severity: 'warning',
				rule: 'interactive-role',
				message: `Interactive element without role`,
				elementHtml: elementHtml(element),
				file,
				line,
				fix: `Use <button> or add role="button" and tabindex="0"`,
				fixCode: `<div role="button" tabindex="0" onclick="...">`
			}, element));
		}
	});

	return issues;
}

/**
 * Check for generic/unhelpful link text
 */
function checkLinkText(root: HTMLElement): A11yIssue[] {
	const issues: A11yIssue[] = [];
	const genericTexts = ['click here', 'read more', 'learn more', 'here', 'more', 'link', 'this'];
	const links = root.querySelectorAll('a[href]');

	links.forEach(link => {
		const el = link as HTMLAnchorElement;
		const text = (el.textContent || '').trim().toLowerCase();
		if (genericTexts.includes(text)) {
			const { file, line } = getElementSource(el);
			issues.push(withWhy({
				severity: 'warning',
				rule: 'link-text',
				message: `Link with generic text "${text}"`,
				elementHtml: elementHtml(el),
				file,
				line,
				fix: `Use descriptive link text that explains the destination`,
				fixCode: `<a href="...">View pricing details</a>`
			}, el));
		}
	});

	return issues;
}

/**
 * Check for <html lang> attribute
 */
function checkHtmlLang(): A11yIssue[] {
	const issues: A11yIssue[] = [];
	const html = document.documentElement;
	if (!html.getAttribute('lang')) {
		issues.push(withWhy({
			severity: 'warning',
			rule: 'html-lang',
			message: 'Page missing language attribute on <html>',
			elementHtml: '<html>',
			fix: 'Add lang attribute to the html element',
			fixCode: '<html lang="en">'
		}));
	}
	return issues;
}

/**
 * Check for autocomplete attributes on form inputs
 */
function checkAutocomplete(root: HTMLElement): A11yIssue[] {
	const issues: A11yIssue[] = [];
	const autocompleteFields: Record<string, string[]> = {
		email: ['email'],
		password: ['current-password', 'new-password'],
		tel: ['tel'],
		url: ['url']
	};

	const inputs = root.querySelectorAll('input');
	inputs.forEach(input => {
		const el = input as HTMLInputElement;
		const type = el.type;
		const expectedValues = autocompleteFields[type];
		if (expectedValues && !el.getAttribute('autocomplete')) {
			const { file, line } = getElementSource(el);
			issues.push(withWhy({
				severity: 'info',
				rule: 'autocomplete',
				message: `Input type="${type}" missing autocomplete attribute`,
				elementHtml: elementHtml(el),
				file,
				line,
				fix: `Add autocomplete="${expectedValues[0]}" to the input`,
				fixCode: `<input type="${type}" autocomplete="${expectedValues[0]}">`
			}, el));
		}
	});

	return issues;
}

/**
 * Check for video/audio without alternatives
 */
function checkMediaAlternatives(root: HTMLElement): A11yIssue[] {
	const issues: A11yIssue[] = [];

	const videos = root.querySelectorAll('video');
	videos.forEach(video => {
		const el = video as HTMLVideoElement;
		const hasCaptions = el.querySelector('track[kind="captions"], track[kind="subtitles"]');
		if (!hasCaptions) {
			const { file, line } = getElementSource(el);
			issues.push(withWhy({
				severity: 'warning',
				rule: 'media-alternative',
				message: 'Video without captions or subtitles',
				elementHtml: elementHtml(el),
				file,
				line,
				fix: 'Add a <track> element with captions',
				fixCode: '<video>\n  <track kind="captions" src="captions.vtt" srclang="en" label="English">\n</video>'
			}, el));
		}
	});

	const audios = root.querySelectorAll('audio');
	audios.forEach(audio => {
		const el = audio as HTMLAudioElement;
		// Check if there's a nearby transcript link or element
		const parent = el.parentElement;
		const hasTranscript = parent?.querySelector('[class*="transcript"], [id*="transcript"]') ||
			parent?.querySelector('a[href*="transcript"]');
		if (!hasTranscript) {
			const { file, line } = getElementSource(el);
			issues.push(withWhy({
				severity: 'info',
				rule: 'media-alternative',
				message: 'Audio without visible transcript',
				elementHtml: elementHtml(el),
				file,
				line,
				fix: 'Provide a text transcript near the audio element'
			}, el));
		}
	});

	return issues;
}

/**
 * Check for landmark regions
 */
function checkLandmarkRegions(root: HTMLElement): A11yIssue[] {
	const issues: A11yIssue[] = [];

	// Only check at page level (body or near-root)
	if (root !== document.body && !root.parentElement?.closest('body > *')) {
		return issues;
	}

	const hasMain = root.querySelector('main, [role="main"]');
	const hasNav = root.querySelector('nav, [role="navigation"]');

	if (!hasMain) {
		issues.push(withWhy({
			severity: 'warning',
			rule: 'landmark-regions',
			message: 'Page missing <main> landmark region',
			elementHtml: elementHtml(root),
			fix: 'Wrap the primary content in a <main> element',
			fixCode: '<main>\n  <!-- primary page content -->\n</main>'
		}));
	}

	if (!hasNav && root.querySelectorAll('a[href]').length > 5) {
		issues.push(withWhy({
			severity: 'info',
			rule: 'landmark-regions',
			message: 'Page has many links but no <nav> landmark',
			elementHtml: elementHtml(root),
			fix: 'Wrap navigation links in a <nav> element',
			fixCode: '<nav aria-label="Main navigation">\n  <!-- links -->\n</nav>'
		}));
	}

	return issues;
}

/**
 * Check for skip navigation link
 */
function checkSkipNav(root: HTMLElement): A11yIssue[] {
	const issues: A11yIssue[] = [];

	if (root !== document.body) return issues;

	const firstLink = root.querySelector('a[href^="#"]');
	const hasSkipLink = firstLink &&
		firstLink === root.querySelector('a') &&
		(firstLink.textContent || '').toLowerCase().includes('skip');

	const navLinks = root.querySelectorAll('nav a, [role="navigation"] a');
	if (navLinks.length > 3 && !hasSkipLink) {
		issues.push(withWhy({
			severity: 'info',
			rule: 'skip-nav',
			message: 'Page has navigation but no skip link',
			elementHtml: '<body>',
			fix: 'Add a skip navigation link as the first element',
			fixCode: '<a href="#main-content" class="skip-link">Skip to main content</a>'
		}));
	}

	return issues;
}

/**
 * Check for removed :focus-visible styles
 */
function checkFocusVisible(root: HTMLElement): A11yIssue[] {
	const issues: A11yIssue[] = [];
	const focusable = root.querySelectorAll('a[href], button, input, select, textarea, [tabindex="0"]');

	// Sample a few focusable elements (checking all would be expensive)
	const sample = Array.from(focusable).slice(0, 5);
	for (const el of sample) {
		const element = el as HTMLElement;
		const styles = window.getComputedStyle(element);
		// Check if outline is explicitly removed
		if (styles.outlineStyle === 'none' && styles.outlineWidth === '0px') {
			// Check if there's a box-shadow or border that acts as focus indicator
			// (many designs use these as alternatives)
			const hasFocusAlternative =
				styles.boxShadow !== 'none' ||
				element.classList.contains('focus-visible') ||
				element.matches(':focus-visible');

			if (!hasFocusAlternative) {
				const { file, line } = getElementSource(element);
				issues.push(withWhy({
					severity: 'warning',
					rule: 'focus-visible',
					message: 'Focusable element with outline:none and no alternative focus indicator',
					elementHtml: elementHtml(element),
					file,
					line,
					fix: 'Keep outline or add a visible :focus-visible style',
					fixCode: `${element.tagName.toLowerCase()}:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }`
				}, element));
			}
		}
	}

	return issues;
}

/**
 * Collect positive checks
 */
function collectPasses(root: HTMLElement): string[] {
	const passes: string[] = [];

	const inputs = root.querySelectorAll('input, select, textarea');
	const allHaveType = Array.from(inputs).every(i => (i as HTMLInputElement).type);
	if (inputs.length > 0 && allHaveType) passes.push('All inputs have type defined');

	const forms = root.querySelectorAll('form');
	const formsHaveSubmit = Array.from(forms).every(f =>
		f.querySelector('[type="submit"], button:not([type="button"])')
	);
	if (forms.length > 0 && formsHaveSubmit) passes.push('Forms have submit button');

	const autofocus = root.querySelectorAll('[autofocus]');
	if (autofocus.length <= 1) passes.push('No unexpected autofocus');

	const html = document.documentElement;
	if (html.getAttribute('lang')) passes.push('Page language defined');

	const links = root.querySelectorAll('a[href]');
	const allLinksHaveText = Array.from(links).every(a => getAccessibleName(a as HTMLElement));
	if (links.length > 0 && allLinksHaveText) passes.push('All links have accessible text');

	const genericTexts = ['click here', 'read more', 'learn more', 'here', 'more', 'link', 'this'];
	const allLinksDescriptive = Array.from(links).every(a =>
		!genericTexts.includes((a.textContent || '').trim().toLowerCase())
	);
	if (links.length > 0 && allLinksDescriptive) passes.push('All links have descriptive text');

	if (root.querySelector('main, [role="main"]')) passes.push('Main landmark region present');
	if (root.querySelector('nav, [role="navigation"]')) passes.push('Navigation landmark present');

	const videos = root.querySelectorAll('video');
	const allVideosCaptioned = Array.from(videos).every(v =>
		v.querySelector('track[kind="captions"], track[kind="subtitles"]')
	);
	if (videos.length > 0 && allVideosCaptioned) passes.push('All videos have captions');

	return passes;
}

/**
 * Calculate accessibility score (0-100)
 */
function calculateScore(critical: number, warnings: number, passes: number, totalChecks: number): number {
	if (totalChecks === 0) return 100;
	const deductions = critical * 15 + warnings * 5;
	const base = Math.max(0, 100 - deductions);
	const passBonus = passes * 2;
	return Math.min(100, Math.max(0, base + passBonus));
}

/**
 * Check a single element without descending into its subtree
 */
function checkElementOnly(el: HTMLElement): A11yIssue[] {
	const issues: A11yIssue[] = [];
	const tag = el.tagName.toLowerCase();

	// Input label check
	if (['input', 'select', 'textarea'].includes(tag)) {
		const inputEl = el as HTMLInputElement;
		if (inputEl.type !== 'hidden' && inputEl.type !== 'submit' && inputEl.type !== 'button') {
			const hasLabel =
				(inputEl.id && document.querySelector(`label[for="${inputEl.id}"]`)) ||
				inputEl.closest('label') ||
				inputEl.getAttribute('aria-label') ||
				inputEl.getAttribute('aria-labelledby');
			if (!hasLabel) {
				const { file, line } = getElementSource(el);
				issues.push(withWhy({
					severity: 'critical',
					rule: 'input-label',
					message: 'Input without associated label',
					elementHtml: elementHtml(el),
					file, line,
					fix: 'Add a label to the field',
					fixCode: inputEl.id
						? `<label for="${inputEl.id}">Description</label>`
						: `<${tag} aria-label="Field description">`
				}, el));
			}
		}
	}

	// Button label check
	if (tag === 'button' || el.getAttribute('role') === 'button') {
		if (!getAccessibleName(el)) {
			const { file, line } = getElementSource(el);
			issues.push(withWhy({
				severity: 'critical',
				rule: 'button-label',
				message: 'Button without accessible text',
				elementHtml: elementHtml(el),
				file, line,
				fix: 'Add aria-label to the button',
				fixCode: '<button aria-label="Action description">...</button>'
			}, el));
		}
	}

	// Image alt check
	if (tag === 'img') {
		const img = el as HTMLImageElement;
		if (!img.hasAttribute('alt')) {
			const { file, line } = getElementSource(el);
			issues.push(withWhy({
				severity: 'critical',
				rule: 'img-alt',
				message: 'Image missing alt attribute',
				elementHtml: elementHtml(el),
				file, line,
				fix: 'Add descriptive alt text',
				fixCode: '<img src="..." alt="Image description">'
			}, el));
		}
	}

	// Contrast check
	if (el.textContent?.trim()) {
		const computed = window.getComputedStyle(el);
		const fg = computed.color;
		const bg = getEffectiveBackground(el);
		const ratio = contrastRatio(fg, bg);
		if (ratio !== null) {
			const fontSize = parseFloat(computed.fontSize);
			const fontWeight = parseInt(computed.fontWeight);
			const isLargeText = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
			const minRatio = isLargeText ? 3 : 4.5;
			if (ratio < minRatio) {
				const { file, line } = getElementSource(el);
				issues.push(withWhy({
					severity: ratio < 3 ? 'critical' : 'warning',
					rule: 'contrast',
					message: `Insufficient contrast: ${ratio.toFixed(1)}:1 (minimum: ${minRatio}:1)`,
					elementHtml: elementHtml(el),
					file, line,
					fix: `Foreground: ${fg}, Background: ${bg}`
				}, el));
			}
		}
	}

	// Tab index check
	const tabindex = parseInt(el.getAttribute('tabindex') || '0');
	if (el.hasAttribute('tabindex') && tabindex > 0) {
		const { file, line } = getElementSource(el);
		issues.push(withWhy({
			severity: 'warning',
			rule: 'tabindex-positive',
			message: `tabindex="${tabindex}" breaks natural focus order`,
			elementHtml: elementHtml(el),
			file, line,
			fix: 'Use tabindex="0" for natural order or tabindex="-1" to remove from tab flow'
		}, el));
	}

	// Interactive role check (div/span with handlers)
	if (['div', 'span'].includes(tag) && !el.getAttribute('role')) {
		const isInteractive =
			el.onclick !== null ||
			el.getAttribute('tabindex') === '0' ||
			el.hasAttribute('data-action') ||
			el.style.cursor === 'pointer' ||
			window.getComputedStyle(el).cursor === 'pointer';

		if (isInteractive) {
			const { file, line } = getElementSource(el);
			issues.push(withWhy({
				severity: 'warning',
				rule: 'interactive-role',
				message: 'Interactive element without role',
				elementHtml: elementHtml(el),
				file, line,
				fix: 'Use <button> or add role="button" and tabindex="0"'
			}, el));
		}
	}

	return issues;
}

/**
 * Run full accessibility analysis on an element (and optionally its subtree)
 */
export function analyzeA11y(element: HTMLElement, includeSubtree: boolean): A11yReport {
	const allIssues: A11yIssue[] = includeSubtree
		? [
			...checkInputLabels(element),
			...checkButtonLabels(element),
			...checkImageAlts(element),
			...checkContrast(element),
			...checkTabOrder(element),
			...checkHeadingHierarchy(element),
			...checkFormLandmarks(element),
			...checkInteractiveRoles(element),
			...checkLinkText(element),
			...checkHtmlLang(),
			...checkAutocomplete(element),
			...checkMediaAlternatives(element),
			...checkLandmarkRegions(element),
			...checkSkipNav(element),
			...checkFocusVisible(element),
		]
		: [
			// Only check the element itself, not its subtree
			...checkElementOnly(element),
		];

	const critical = allIssues.filter(i => i.severity === 'critical');
	const warnings = allIssues.filter(i => i.severity === 'warning' || i.severity === 'info');
	const passes = includeSubtree ? collectPasses(element) : [];

	const totalChecks = allIssues.length + passes.length;
	const score = calculateScore(critical.length, warnings.length, passes.length, totalChecks);

	const tag = element.tagName.toLowerCase();
	const cls = element.className ? ` class="${String(element.className).slice(0, 40)}"` : '';
	const meta = (element as SvelteElement).__svelte_meta;
	const file = meta?.loc ? shortenPath(meta.loc.file) : undefined;
	const line = meta?.loc?.line;

	return {
		critical,
		warnings,
		passes,
		score,
		elementTag: `<${tag}${cls}>`,
		file,
		line
	};
}

/**
 * Format A11y report as text for LLM
 */
export function formatA11yForAgent(report: A11yReport): string {
	const parts: string[] = [`=== Accessibility Report: ${report.elementTag} ===\n`];

	if (report.critical.length > 0) {
		parts.push(`\u{1F534} CRITICAL (${report.critical.length}):\n`);
		report.critical.forEach((issue, i) => {
			parts.push(`  ${i + 1}. ${issue.message}`);
			parts.push(`     \u2502 ${issue.elementHtml}`);
			if (issue.file) parts.push(`     \u2502 Line: ${issue.file}${issue.line ? ':' + issue.line : ''}`);
			parts.push(`     \u2502`);
			parts.push(`     \u2502 \u274C Issue: ${issue.message}`);
			if (issue.why) parts.push(`     \u2502 \u{1F4AC} Why: ${issue.why}`);
			parts.push(`     \u2502 \u2705 Fix: ${issue.fix}`);
			if (issue.fixCode) {
				parts.push(`     \u2502    ${issue.fixCode}`);
			}
			parts.push('');
		});
	}

	if (report.warnings.length > 0) {
		parts.push(`\u{1F7E1} WARNINGS (${report.warnings.length}):\n`);
		report.warnings.forEach((issue, i) => {
			parts.push(`  ${i + 1}. ${issue.message}`);
			parts.push(`     \u2502 ${issue.elementHtml}`);
			if (issue.file) parts.push(`     \u2502 ${issue.file}${issue.line ? ':' + issue.line : ''}`);
			if (issue.why) parts.push(`     \u2502 \u{1F4AC} Why: ${issue.why}`);
			parts.push(`     \u2502 \u26A0\uFE0F ${issue.fix}`);
			if (issue.fixCode) parts.push(`     \u2502    ${issue.fixCode}`);
			parts.push('');
		});
	}

	if (report.passes.length > 0) {
		parts.push(`\u{1F7E2} GOOD (${report.passes.length}):`);
		report.passes.forEach(p => parts.push(`  \u2713 ${p}`));
		parts.push('');
	}

	parts.push(`\u{1F4CA} SCORE: ${report.score}/100${report.score >= 80 ? ' (Good)' : report.score >= 60 ? ' (Needs improvement)' : ' (Critical)'}`);

	return parts.join('\n');
}
