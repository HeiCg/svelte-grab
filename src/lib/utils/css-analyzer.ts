import type { StylePropertyInfo, StyleSource, StyleCategory, StyleConflict, StyleConflictRule } from '../types.js';

/**
 * CSS property categories for organized display
 */
const CATEGORY_MAP: Record<string, { name: string; icon: string; properties: string[] }> = {
	'box-model': {
		name: 'Box Model',
		icon: '\u{1F4D0}',
		properties: [
			'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
			'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
			'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
			'border', 'border-width', 'border-style', 'border-color',
			'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
			'border-radius', 'border-top-left-radius', 'border-top-right-radius',
			'border-bottom-left-radius', 'border-bottom-right-radius',
			'box-sizing', 'overflow', 'overflow-x', 'overflow-y'
		]
	},
	visual: {
		name: 'Visual',
		icon: '\u{1F3A8}',
		properties: [
			'background', 'background-color', 'background-image', 'background-size',
			'background-position', 'background-repeat',
			'color', 'opacity', 'visibility',
			'border-color', 'border-style',
			'box-shadow', 'outline', 'outline-color', 'outline-style', 'outline-width',
			'cursor', 'filter', 'backdrop-filter', 'mix-blend-mode'
		]
	},
	typography: {
		name: 'Typography',
		icon: '\u{1F4DD}',
		properties: [
			'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
			'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-decoration',
			'text-transform', 'text-indent', 'text-overflow', 'text-shadow',
			'white-space', 'word-break', 'word-wrap', 'overflow-wrap'
		]
	},
	layout: {
		name: 'Layout',
		icon: '\u{1F4E6}',
		properties: [
			'display', 'position', 'top', 'right', 'bottom', 'left',
			'z-index', 'float', 'clear',
			'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
			'justify-content', 'align-items', 'align-self', 'align-content',
			'gap', 'row-gap', 'column-gap',
			'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
			'grid-area', 'grid-gap',
			'transform', 'transition', 'animation'
		]
	}
};

/**
 * Tailwind CSS class pattern matchers
 */
const TAILWIND_PATTERNS: RegExp[] = [
	// Common Tailwind patterns
	/^(sm|md|lg|xl|2xl|hover|focus|active|disabled|dark|group-hover):/, // responsive/state prefixes
	/^(m|p|mx|my|mt|mr|mb|ml|px|py|pt|pr|pb|pl)-[\d.\[\]]+/, // spacing
	/^(w|h|min-w|min-h|max-w|max-h)-[\d.\[\]a-z]+/, // sizing
	/^(text|font|leading|tracking|decoration)-/, // typography
	/^(bg|from|via|to|border|ring|outline|shadow)-/, // colors/effects
	/^(flex|grid|col|row|gap|justify|items|self|content|place)-/, // layout
	/^(rounded|overflow|z|opacity|cursor|pointer-events)-?/, // misc
	/^(block|inline|hidden|visible|invisible|static|fixed|absolute|relative|sticky)$/,
	/^(sr-only|not-sr-only)$/,
	/^-?(translate|rotate|scale|skew)-/,
	/^(transition|duration|ease|delay|animate)-/,
];

/**
 * Svelte scoped class pattern (class hash like svelte-1abc2de)
 */
const SVELTE_SCOPED_RE = /^s-[\w-]+$|^svelte-[\w]+$/;

/**
 * Calculate CSS specificity of a selector
 * Returns [id, class, type] tuple
 */
export function calculateSpecificity(selector: string): [number, number, number] {
	let ids = 0;
	let classes = 0;
	let types = 0;

	// Remove :not() content but count its internals
	const cleaned = selector.replace(/:not\(([^)]*)\)/g, (_, inner) => {
		const [i, c, t] = calculateSpecificity(inner);
		ids += i;
		classes += c;
		types += t;
		return '';
	});

	// IDs
	ids += (cleaned.match(/#[a-zA-Z][\w-]*/g) || []).length;

	// Classes, attribute selectors, pseudo-classes
	classes += (cleaned.match(/\.[a-zA-Z][\w-]*/g) || []).length;
	classes += (cleaned.match(/\[[\w-]+/g) || []).length;
	classes += (cleaned.match(/:(hover|focus|active|visited|first-child|last-child|nth-child|focus-within|focus-visible|checked|disabled|enabled|empty|first-of-type|last-of-type|only-child|only-of-type|root|target|lang|is|where|has|any)/g) || []).length;

	// Type selectors and pseudo-elements
	types += (cleaned.match(/(^|[\s+>~])[\w][\w-]*/g) || []).length;
	types += (cleaned.match(/::(before|after|first-line|first-letter|placeholder|selection|marker)/g) || []).length;

	return [ids, classes, types];
}

/**
 * Compare specificity values: returns positive if a wins, negative if b wins, 0 if equal
 */
export function compareSpecificity(a: [number, number, number], b: [number, number, number]): number {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return 0;
}

/**
 * Check if a class name looks like a Tailwind utility class
 */
export function isTailwindClass(className: string): boolean {
	return TAILWIND_PATTERNS.some(re => re.test(className));
}

/**
 * Check if a class name is a Svelte scoped class
 */
export function isSvelteScoped(className: string): boolean {
	return SVELTE_SCOPED_RE.test(className);
}

/**
 * Detect the source type of a CSS rule based on its selector and stylesheet
 */
export function detectRuleSource(rule: CSSStyleRule, sheet: CSSStyleSheet): StyleSource {
	const selector = rule.selectorText;
	const href = sheet.href || '';
	const ownerNode = sheet.ownerNode as HTMLElement | null;

	// Inline style (should not reach here, handled separately)
	if (!rule.selectorText) {
		return { type: 'inline' };
	}

	// Svelte scoped: selector contains svelte hash class
	if (selector.match(/\.s-[\w-]+|\.svelte-[\w]+/)) {
		// Try to extract file from data attribute on the style element
		const file = ownerNode?.getAttribute('data-file') ?? undefined;
		return {
			type: 'svelte-scoped',
			selector,
			file,
			specificity: calculateSpecificity(selector)
		};
	}

	// Tailwind: check if selector classes are Tailwind-like
	const selectorClasses = selector.match(/\.[\w-[\]\/]+/g) || [];
	const hasTailwind = selectorClasses.some(c => isTailwindClass(c.slice(1)));
	if (hasTailwind) {
		return {
			type: 'tailwind',
			selector,
			specificity: calculateSpecificity(selector)
		};
	}

	// External stylesheet
	if (href) {
		return {
			type: 'stylesheet',
			selector,
			file: href,
			specificity: calculateSpecificity(selector)
		};
	}

	// Internal stylesheet (in style tag)
	return {
		type: 'stylesheet',
		selector,
		specificity: calculateSpecificity(selector)
	};
}

/**
 * Get all CSS rules that apply to an element
 */
export function getMatchingRules(element: HTMLElement): { rule: CSSStyleRule; source: StyleSource }[] {
	const results: { rule: CSSStyleRule; source: StyleSource }[] = [];

	try {
		for (let i = 0; i < document.styleSheets.length; i++) {
			const sheet = document.styleSheets[i];
			let rules: CSSRuleList;
			try {
				rules = sheet.cssRules;
			} catch {
				// CORS-restricted stylesheet
				continue;
			}

			for (let j = 0; j < rules.length; j++) {
				const rule = rules[j];
				if (rule instanceof CSSStyleRule) {
					try {
						if (element.matches(rule.selectorText)) {
							results.push({
								rule,
								source: detectRuleSource(rule, sheet)
							});
						}
					} catch {
						// Invalid selector
					}
				}
			}
		}
	} catch {
		// StyleSheet access error
	}

	return results;
}

/**
 * Analyze an element's styles and group by category
 */
export function analyzeStyles(element: HTMLElement): {
	categories: StyleCategory[];
	conflicts: StyleConflict[];
	inlineStyles: Record<string, string>;
} {
	const computed = window.getComputedStyle(element);
	const matchingRules = getMatchingRules(element);

	// Collect inline styles
	const inlineStyles: Record<string, string> = {};
	for (let i = 0; i < element.style.length; i++) {
		const prop = element.style[i];
		inlineStyles[prop] = element.style.getPropertyValue(prop);
	}

	// Build property -> rules map for conflict detection
	const propertyRules: Record<string, { value: string; source: StyleSource }[]> = {};
	for (const { rule, source } of matchingRules) {
		for (let i = 0; i < rule.style.length; i++) {
			const prop = rule.style[i];
			const value = rule.style.getPropertyValue(prop);
			if (!propertyRules[prop]) propertyRules[prop] = [];
			propertyRules[prop].push({ value, source });
		}
	}

	// Detect conflicts (properties defined in multiple rules with different values)
	const conflicts: StyleConflict[] = [];
	for (const [prop, rules] of Object.entries(propertyRules)) {
		const uniqueValues = new Set(rules.map(r => r.value));
		if (uniqueValues.size > 1) {
			const computedValue = computed.getPropertyValue(prop);
			const conflictRules: StyleConflictRule[] = rules.map(r => ({
				selector: r.source.selector || '(inline)',
				value: r.value,
				specificity: r.source.specificity || [0, 0, 0],
				won: r.value === computedValue,
				source: r.source.file
			}));
			conflicts.push({ property: prop, rules: conflictRules });
		}
	}

	// Build categories
	const categories: StyleCategory[] = [];
	for (const [key, catDef] of Object.entries(CATEGORY_MAP)) {
		const properties: StylePropertyInfo[] = [];

		for (const propName of catDef.properties) {
			const value = computed.getPropertyValue(propName);
			if (!value || value === 'none' && !['display', 'border', 'outline'].includes(propName)) continue;

			// Determine source
			let source: StyleSource = { type: 'user-agent' };

			if (inlineStyles[propName]) {
				source = { type: 'inline' };
			} else if (propertyRules[propName]) {
				// Use the winning rule's source
				const rules = propertyRules[propName];
				const winner = rules.find(r => r.value === value) || rules[rules.length - 1];
				source = winner.source;
			}

			const isOverridden = conflicts.some(
				c => c.property === propName && c.rules.some(r => !r.won)
			);

			properties.push({ name: propName, value, source, isOverridden });
		}

		if (properties.length > 0) {
			categories.push({ name: catDef.name, icon: catDef.icon, properties });
		}
	}

	return { categories, conflicts, inlineStyles };
}

/**
 * Format style analysis as text for LLM
 */
export function formatStylesForAgent(
	element: HTMLElement,
	categories: StyleCategory[],
	conflicts: StyleConflict[],
	file?: string,
	line?: number
): string {
	const tag = element.tagName.toLowerCase();
	const cls = element.className ? ` class="${String(element.className).slice(0, 60)}"` : '';
	const parts: string[] = [`=== Estilos de: <${tag}${cls}> ===\n`];

	for (const cat of categories) {
		parts.push(`${cat.icon} ${cat.name.toUpperCase()}:`);
		for (const prop of cat.properties) {
			const sourceStr = formatSourceStr(prop.source);
			parts.push(`  ${prop.name}: ${prop.value}${sourceStr}`);
		}
		parts.push('');
	}

	if (conflicts.length > 0) {
		parts.push('\u{1F500} CONFLITOS DETECTADOS:');
		for (const conflict of conflicts) {
			parts.push(`  \u26A0\uFE0F ${conflict.property}: definido em ${conflict.rules.length} lugares`);
			for (const rule of conflict.rules) {
				const status = rule.won ? '[GANHOU]' : '[PERDEU]';
				const spec = `specificidade ${rule.specificity.join(',')}`;
				parts.push(`     - ${rule.selector} \u2192 ${rule.value} ${status} - ${spec}`);
			}
		}
		parts.push('');
	}

	if (file) {
		parts.push(`\u{1F4CD} Elemento: ${file}${line ? ':' + line : ''}`);
	}

	return parts.join('\n');
}

function formatSourceStr(source: StyleSource): string {
	switch (source.type) {
		case 'inline': return ' \u2192 inline style';
		case 'svelte-scoped': return ` \u2192 Svelte scoped${source.file ? ' (' + source.file + ')' : ''}`;
		case 'tailwind': return ` \u2192 Tailwind (${source.selector || ''})`;
		case 'stylesheet': return ` \u2192 ${source.file || 'stylesheet'}${source.selector ? ' (' + source.selector + ')' : ''}`;
		case 'inherited': return ' \u2192 inherited';
		case 'user-agent': return ' \u2192 user-agent default';
		default: return '';
	}
}
