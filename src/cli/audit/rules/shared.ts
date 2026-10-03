/** Helpers shared by the audit rules. */
import { redactText } from '../secrets.js';
import { excerpt, lineColAt, lineStarts } from '../source.js';
import type { RawFinding, RuleId, Severity, SourceFile, Verdict } from '../types.js';

/** Signature of the Svelte compiler's `parse` (modern AST). */
export type SvelteParse = (source: string, options: { modern: true; filename?: string }) => unknown;

export interface RuleContext {
	/** Every scanned file by relative path (cross-file lookups: hooks, config). */
	files: Map<string, SourceFile>;
	notes: string[];
	/** `null` when the Svelte compiler is not resolvable (regex fallback). */
	parseSvelte: SvelteParse | null;
}

/** Redact, then collapse and cap: redaction runs before truncation so a cut never exposes a secret prefix past the redaction. */
export function evidence(text: string, max = 200): string {
	return excerpt(redactText(text), max);
}

/** Builds findings for one file, mapping offsets to line/column. */
export class FindingSink {
	readonly findings: RawFinding[] = [];
	private starts: number[] | null = null;

	constructor(readonly file: SourceFile) {}

	add(
		rule: RuleId,
		offset: number,
		severity: Severity,
		verdict: Verdict,
		title: string,
		evidenceText: string,
		fix: string
	): void {
		this.starts ??= lineStarts(this.file.text);
		const { line, column } = lineColAt(
			this.starts,
			Math.max(0, Math.min(offset, this.file.text.length))
		);
		this.findings.push({
			rule,
			severity,
			verdict,
			title,
			evidence: evidence(evidenceText),
			file: this.file.rel,
			line,
			column,
			fix
		});
	}
}

/**
 * Script regions of a `.svelte` file, everything else blanked (offsets and
 * newlines kept), so JS rules see only `<script>` code.
 */
export function svelteScriptText(text: string): string {
	let out = '';
	let pos = 0;
	const re = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
	for (const m of text.matchAll(re)) {
		const contentStart = (m.index ?? 0) + m[0].indexOf('>') + 1;
		const contentEnd = contentStart + m[1].length;
		out +=
			text.slice(pos, contentStart).replace(/[^\n]/g, ' ') + text.slice(contentStart, contentEnd);
		pos = contentEnd;
	}
	return out + text.slice(pos).replace(/[^\n]/g, ' ');
}
