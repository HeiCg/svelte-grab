/**
 * `.svelte` template rules, on the Svelte compiler's modern AST:
 *
 * - `svelte/html-non-literal`: `{@html expr}` where `expr` is not a string
 *   literal (or a call to an obvious sanitizer).
 * - `svelte/target-blank-noopener`: `<a target="_blank">` to a non-relative
 *   href without `rel` containing `noopener` / `noreferrer`.
 * - `svelte/inline-handler-string`: `on*="..."` string handlers on DOM
 *   elements (inline JS: needs CSP `unsafe-inline`, easy injection sink).
 *
 * Without the compiler (or on a parse error) `{@html}` falls back to a scan
 * of the raw text; the attribute rules need the AST.
 */
import { lineAt, matchBracket } from '../source.js';
import type { SourceFile } from '../types.js';
import { FindingSink, type RuleContext } from './shared.js';

interface Node {
	type: string;
	start: number;
	end: number;
	[key: string]: unknown;
}

function isNode(v: unknown): v is Node {
	return !!v && typeof v === 'object' && typeof (v as Node).type === 'string';
}

/** Visit every AST node (depth-first), skipping compiler metadata. */
function walk(root: unknown, visit: (node: Node) => void): void {
	const seen = new Set<object>();
	const step = (v: unknown): void => {
		if (!v || typeof v !== 'object' || seen.has(v)) return;
		seen.add(v);
		if (Array.isArray(v)) {
			for (const item of v) step(item);
			return;
		}
		if (isNode(v)) visit(v);
		for (const [key, child] of Object.entries(v)) {
			if (key === 'metadata' || key === 'parent' || key === 'loc') continue;
			if (child && typeof child === 'object') step(child);
		}
	};
	step(root);
}

const SANITIZER = /(?:sanitize|purify|escape|dompurify|xss)/i;

function isLiteralExpression(expr: Node | undefined): boolean {
	if (!expr) return false;
	if (expr.type === 'Literal') return true;
	if (expr.type === 'TemplateLiteral')
		return Array.isArray(expr.expressions) && expr.expressions.length === 0;
	return false;
}

function isSanitizerCall(source: string): boolean {
	const callee = /^\s*(?:await\s+)?([\w$.]+)\s*\(/.exec(source);
	return !!callee && SANITIZER.test(callee[1]);
}

const HTML_FIX =
	'Render user-controlled values as text ({value}); if HTML is required, sanitize it first (e.g. DOMPurify.sanitize) on trusted content only.';

function reportHtml(sink: FindingSink, start: number, exprSource: string): void {
	sink.add(
		'svelte/html-non-literal',
		start,
		'medium',
		'needs_validation',
		'{@html} renders a non-literal expression (possible XSS)',
		`{@html ${exprSource.trim()}}`,
		HTML_FIX
	);
}

// ------------------------------------------------------------------ attributes

interface AttrInfo {
	present: boolean;
	/** Static text value, `''` for a bare attribute, null when dynamic. */
	value: string | null;
}

function attribute(element: Node, name: string): AttrInfo {
	const attrs = Array.isArray(element.attributes) ? (element.attributes as Node[]) : [];
	const attr = attrs.find((a) => a.type === 'Attribute' && String(a.name).toLowerCase() === name);
	if (!attr) return { present: false, value: null };
	const value = attr.value;
	if (value === true) return { present: true, value: '' };
	if (Array.isArray(value)) {
		if (value.every((v) => isNode(v) && v.type === 'Text')) {
			return { present: true, value: (value as Node[]).map((v) => String(v.data ?? '')).join('') };
		}
		return { present: true, value: null };
	}
	return { present: true, value: null };
}

function hasSpread(element: Node): boolean {
	const attrs = Array.isArray(element.attributes) ? (element.attributes as Node[]) : [];
	return attrs.some((a) => a.type === 'SpreadAttribute');
}

/** `/x`, `./x`, `#x`, `?x`, `mailto:`: same-site or no browsing context. */
function isRelativeOrSafeHref(href: string): boolean {
	const h = href.trim();
	if (!h) return true;
	if (h.startsWith('//')) return false;
	if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return /^(?:mailto|tel|sms|javascript|data|blob):/i.test(h);
	return true;
}

function targetBlankRule(element: Node, text: string, sink: FindingSink): void {
	if (element.name !== 'a' && element.name !== 'area') return;
	const target = attribute(element, 'target');
	if (!target.present || target.value === null || target.value.trim().toLowerCase() !== '_blank')
		return;
	if (hasSpread(element)) return;
	const rel = attribute(element, 'rel');
	if (rel.present && (rel.value === null || /\bno(?:opener|referrer)\b/i.test(rel.value))) return;
	const href = attribute(element, 'href');
	if (!href.present) return;
	if (href.value !== null && isRelativeOrSafeHref(href.value)) return;
	const dynamic = href.value === null;
	sink.add(
		'svelte/target-blank-noopener',
		element.start,
		'low',
		dynamic ? 'needs_validation' : 'confirmed',
		dynamic
			? 'target="_blank" with a dynamic href and no rel="noopener"'
			: 'target="_blank" to an external URL without rel="noopener"',
		lineAt(text, element.start),
		'Add rel="noopener noreferrer" so the opened page cannot reach window.opener (reverse tabnabbing) and does not receive the referrer.'
	);
}

function inlineHandlerRule(element: Node, text: string, sink: FindingSink): void {
	const attrs = Array.isArray(element.attributes) ? (element.attributes as Node[]) : [];
	for (const attr of attrs) {
		if (attr.type !== 'Attribute' || !/^on[a-z]+$/i.test(String(attr.name))) continue;
		const value = attr.value;
		if (
			!Array.isArray(value) ||
			!value.some((v) => isNode(v) && v.type === 'Text' && String(v.data ?? '').trim())
		)
			continue;
		sink.add(
			'svelte/inline-handler-string',
			attr.start,
			'low',
			'confirmed',
			`Inline string event handler ${String(attr.name)}="…"`,
			lineAt(text, attr.start),
			'Use a function handler (onclick={handleClick}); string handlers are inline script, need CSP unsafe-inline and are an injection sink.'
		);
	}
}

// ------------------------------------------------------------------ fallback

function regexHtmlRule(text: string, sink: FindingSink): void {
	for (const m of text.matchAll(/\{@html\b/g)) {
		const open = m.index ?? 0;
		const close = matchBracket(text, open);
		if (close === -1) continue;
		const expr = text.slice(open + m[0].length, close - 1).trim();
		if (/^(['"])[\s\S]*\1$/.test(expr) || /^`[^`$]*`$/.test(expr) || isSanitizerCall(expr))
			continue;
		reportHtml(sink, open, expr);
	}
}

// ------------------------------------------------------------------ entry

const ELEMENT_TYPES = new Set(['RegularElement', 'SvelteElement', 'Element']);

export function svelteRules(file: SourceFile, ctx: RuleContext): FindingSink {
	const sink = new FindingSink(file);
	const text = file.text;
	if (!ctx.parseSvelte) {
		regexHtmlRule(text, sink);
		return sink;
	}
	let ast: unknown;
	try {
		ast = ctx.parseSvelte(text, { modern: true, filename: file.rel });
	} catch (err) {
		ctx.notes.push(
			`${file.rel}: Svelte parse error (${(err as Error).message.split('\n')[0]}); {@html} checked with the regex fallback, attribute rules skipped.`
		);
		regexHtmlRule(text, sink);
		return sink;
	}
	const fragment =
		(ast as { fragment?: unknown; html?: unknown }).fragment ?? (ast as { html?: unknown }).html;
	walk(fragment, (node) => {
		if (node.type === 'HtmlTag' || node.type === 'RawMustacheTag') {
			const expr = isNode(node.expression) ? node.expression : undefined;
			if (isLiteralExpression(expr)) return;
			const source = expr ? text.slice(expr.start, expr.end) : '';
			if (isSanitizerCall(source)) return;
			reportHtml(sink, node.start, source);
			return;
		}
		if (ELEMENT_TYPES.has(node.type)) {
			targetBlankRule(node, text, sink);
			inlineHandlerRule(node, text, sink);
		}
	});
	return sink;
}
