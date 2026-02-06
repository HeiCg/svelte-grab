import type { A11yIssue, A11yReport } from '../types.js';
import { shortenPath, type SvelteElement } from './shared.js';

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
			issues.push({
				severity: 'critical',
				rule: 'input-label',
				message: `Input sem label associado`,
				elementHtml: elementHtml(el),
				file,
				line,
				fix: `Adicionar label ao campo`,
				fixCode: el.id
					? `<label for="${el.id}">Descri\u00E7\u00E3o</label>\n<${tag}${typeAttr} id="${el.id}">`
					: `<${tag}${typeAttr} aria-label="Descri\u00E7\u00E3o do campo">`
			});
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
			issues.push({
				severity: 'critical',
				rule: 'button-label',
				message: `Bot\u00E3o sem texto acess\u00EDvel`,
				elementHtml: elementHtml(el),
				file,
				line,
				fix: `Adicionar aria-label ao bot\u00E3o`,
				fixCode: `<button aria-label="Descri\u00E7\u00E3o da a\u00E7\u00E3o">...</button>`
			});
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
			issues.push({
				severity: 'critical',
				rule: 'img-alt',
				message: `Imagem sem atributo alt`,
				elementHtml: elementHtml(el),
				file,
				line,
				fix: `Adicionar alt descritivo`,
				fixCode: `<img src="..." alt="Descri\u00E7\u00E3o da imagem">`
			});
		} else if (altEmpty && !el.getAttribute('role')) {
			const { file, line } = getElementSource(el);
			issues.push({
				severity: 'info',
				rule: 'img-alt-empty',
				message: `Imagem com alt vazio (decorativa). Considere adicionar role="presentation"`,
				elementHtml: elementHtml(el),
				file,
				line,
				fix: `Adicionar role="presentation" para imagens decorativas`,
				fixCode: `<img src="..." alt="" role="presentation">`
			});
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
			issues.push({
				severity: ratio < 3 ? 'critical' : 'warning',
				rule: 'contrast',
				message: `Contraste insuficiente: ${ratio.toFixed(1)}:1 (m\u00EDnimo WCAG AA: ${minRatio}:1)`,
				elementHtml: elementHtml(element),
				file,
				line,
				fix: `Foreground: ${fg}\nBackground: ${bg}${suggestion ? `\nSugest\u00E3o: usar ${suggestion} (ratio ${minRatio}:1+)` : ''}`,
			});
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
			issues.push({
				severity: 'warning',
				rule: 'tabindex-positive',
				message: `tabindex="${tabindex}" quebra ordem natural de foco`,
				elementHtml: elementHtml(element),
				file,
				line,
				fix: `Usar tabindex="0" para ordem natural ou tabindex="-1" para remover do fluxo de tab`
			});
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
			issues.push({
				severity: 'warning',
				rule: 'heading-order',
				message: `Heading pula de h${lastLevel} para h${level}`,
				elementHtml: elementHtml(el),
				file,
				line,
				fix: `Usar h${lastLevel + 1} ao inv\u00E9s de h${level} para manter hierarquia`
			});
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
			issues.push({
				severity: 'warning',
				rule: 'form-landmark',
				message: `Formul\u00E1rio sem landmark (aria-label)`,
				elementHtml: elementHtml(el),
				file,
				line,
				fix: `Adicionar aria-label ao formul\u00E1rio`,
				fixCode: `<form aria-label="Descri\u00E7\u00E3o do formul\u00E1rio">`
			});
		}
	});

	return issues;
}

/**
 * Check for interactive elements with missing roles
 */
function checkInteractiveRoles(root: HTMLElement): A11yIssue[] {
	const issues: A11yIssue[] = [];
	// div/span with click handlers but no role
	const clickables = root.querySelectorAll('div[onclick], span[onclick]');

	clickables.forEach(el => {
		const element = el as HTMLElement;
		if (!element.getAttribute('role')) {
			const { file, line } = getElementSource(element);
			issues.push({
				severity: 'warning',
				rule: 'interactive-role',
				message: `Elemento interativo sem role`,
				elementHtml: elementHtml(element),
				file,
				line,
				fix: `Usar <button> ou adicionar role="button" e tabindex="0"`,
				fixCode: `<div role="button" tabindex="0" onclick="...">`
			});
		}
	});

	return issues;
}

/**
 * Collect positive checks
 */
function collectPasses(root: HTMLElement): string[] {
	const passes: string[] = [];

	const inputs = root.querySelectorAll('input, select, textarea');
	const allHaveType = Array.from(inputs).every(i => (i as HTMLInputElement).type);
	if (inputs.length > 0 && allHaveType) passes.push('Todos os inputs t\u00EAm type definido');

	const forms = root.querySelectorAll('form');
	const formsHaveSubmit = Array.from(forms).every(f =>
		f.querySelector('[type="submit"], button:not([type="button"])')
	);
	if (forms.length > 0 && formsHaveSubmit) passes.push('Formul\u00E1rios t\u00EAm bot\u00E3o submit');

	const autofocus = root.querySelectorAll('[autofocus]');
	if (autofocus.length <= 1) passes.push('Nenhum autofocus inesperado');

	const html = document.documentElement;
	if (html.getAttribute('lang')) passes.push('Linguagem da p\u00E1gina definida');

	const links = root.querySelectorAll('a[href]');
	const allLinksHaveText = Array.from(links).every(a => getAccessibleName(a as HTMLElement));
	if (links.length > 0 && allLinksHaveText) passes.push('Todos os links t\u00EAm texto acess\u00EDvel');

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
 * Run full accessibility analysis on an element (and optionally its subtree)
 */
export function analyzeA11y(element: HTMLElement, includeSubtree: boolean): A11yReport {
	const root = includeSubtree ? element : element;

	const allIssues: A11yIssue[] = [
		...checkInputLabels(root),
		...checkButtonLabels(root),
		...checkImageAlts(root),
		...checkContrast(root),
		...checkTabOrder(root),
		...checkHeadingHierarchy(root),
		...checkFormLandmarks(root),
		...checkInteractiveRoles(root),
	];

	const critical = allIssues.filter(i => i.severity === 'critical');
	const warnings = allIssues.filter(i => i.severity === 'warning' || i.severity === 'info');
	const passes = collectPasses(root);

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
	const parts: string[] = [`=== Relat\u00F3rio de Acessibilidade: ${report.elementTag} ===\n`];

	if (report.critical.length > 0) {
		parts.push(`\u{1F534} CR\u00CDTICO (${report.critical.length}):\n`);
		report.critical.forEach((issue, i) => {
			parts.push(`  ${i + 1}. ${issue.message}`);
			parts.push(`     \u2502 ${issue.elementHtml}`);
			if (issue.file) parts.push(`     \u2502 Linha: ${issue.file}${issue.line ? ':' + issue.line : ''}`);
			parts.push(`     \u2502`);
			parts.push(`     \u2502 \u274C Problema: ${issue.message}`);
			parts.push(`     \u2502 \u2705 Corre\u00E7\u00E3o: ${issue.fix}`);
			if (issue.fixCode) {
				parts.push(`     \u2502    ${issue.fixCode}`);
			}
			parts.push('');
		});
	}

	if (report.warnings.length > 0) {
		parts.push(`\u{1F7E1} AVISOS (${report.warnings.length}):\n`);
		report.warnings.forEach((issue, i) => {
			parts.push(`  ${i + 1}. ${issue.message}`);
			parts.push(`     \u2502 ${issue.elementHtml}`);
			if (issue.file) parts.push(`     \u2502 ${issue.file}${issue.line ? ':' + issue.line : ''}`);
			parts.push(`     \u2502 \u26A0\uFE0F ${issue.fix}`);
			if (issue.fixCode) parts.push(`     \u2502    ${issue.fixCode}`);
			parts.push('');
		});
	}

	if (report.passes.length > 0) {
		parts.push(`\u{1F7E2} BOM (${report.passes.length}):`);
		report.passes.forEach(p => parts.push(`  \u2713 ${p}`));
		parts.push('');
	}

	parts.push(`\u{1F4CA} SCORE: ${report.score}/100${report.score >= 80 ? ' (Bom)' : report.score >= 60 ? ' (Precisa melhorar)' : ' (Cr\u00EDtico)'}`);

	return parts.join('\n');
}
