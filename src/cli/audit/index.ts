/**
 * `svelte-grab audit`: zero-config static security scanner for Svelte /
 * SvelteKit projects (docs/agent-runtime-spec.md, Phase 9c). rnsec-style:
 * walk the project, run framework-specific rules, emit findings in the
 * runtime `ui_security_scan` shape with a verdict (`confirmed` when the code
 * alone proves the issue, `needs_validation` for heuristics).
 *
 * {@link audit} is the library entry: synchronous, never exits the process,
 * never prints. The CLI wrapper is `./cli.ts`; reporters are in `./report.ts`.
 * Evidence goes through the shared secret rules' redaction, so a report
 * never contains a full secret.
 */
import { readFileSync, statSync } from 'fs';
import { createRequire } from 'module';
import { join, resolve } from 'path';
import { dependencyAdvisories } from './deps.js';
import { kitRules } from './rules/kit.js';
import { codeRules } from './rules/code.js';
import { envRules } from './rules/env.js';
import { svelteRules } from './rules/svelte.js';
import type { RuleContext, SvelteParse } from './rules/shared.js';
import { redactText, sha256Hex } from './secrets.js';
import { classifyFile } from './source.js';
import {
	SEVERITIES,
	type AuditFinding,
	type AuditOptions,
	type AuditResult,
	type AuditSummary,
	type RawFinding,
	type Severity,
	type SourceFile
} from './types.js';
import { DEFAULT_MAX_FILE_SIZE, walkFiles } from './walker.js';

export type { AuditFinding, AuditOptions, AuditResult, AuditSummary, Severity, Verdict, RuleId } from './types.js';
export { RULE_IDS, SEVERITIES } from './types.js';
export { FINDING_SCHEMA, validateAuditReport, validateAgainstSchema } from './schema.js';

/** Load the Svelte compiler's `parse`: svelte-grab's own peer first, then the scanned project's. */
export function loadSvelteParse(root: string): SvelteParse | null {
	const candidates = [import.meta.url, join(root, 'package.json')];
	for (const from of candidates) {
		try {
			const compiler = createRequire(from)('svelte/compiler') as { parse?: SvelteParse };
			if (typeof compiler.parse === 'function') return compiler.parse;
		} catch {
			// try the next location
		}
	}
	return null;
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

/** Whether `severity` is at or above `threshold`. */
export function atLeast(severity: Severity, threshold: Severity): boolean {
	return SEVERITY_RANK[severity] <= SEVERITY_RANK[threshold];
}

/** Assign stable ids (`<rule>:<6 hex>` of rule|file|evidence|occurrence) and `source`, dedupe, sort. */
export function finalizeFindings(raw: RawFinding[]): AuditFinding[] {
	const seenLoc = new Set<string>();
	const occurrences = new Map<string, number>();
	const out: AuditFinding[] = [];
	for (const f of raw) {
		const loc = `${f.rule}|${f.file}|${f.line}|${f.column}|${f.title}`;
		if (seenLoc.has(loc)) continue;
		seenLoc.add(loc);
		const evidence = redactText(f.evidence);
		const key = `${f.rule}|${f.file}|${evidence}`;
		const n = (occurrences.get(key) ?? 0) + 1;
		occurrences.set(key, n);
		out.push({
			id: `${f.rule}:${sha256Hex(`${key}|${n}`).slice(0, 6)}`,
			...f,
			evidence,
			source: `${f.file}:${f.line}:${f.column}`
		});
	}
	return out.sort(
		(a, b) =>
			SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
			a.file.localeCompare(b.file) ||
			a.line - b.line ||
			a.column - b.column ||
			a.rule.localeCompare(b.rule)
	);
}

export function summarize(findings: AuditFinding[]): AuditSummary {
	const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
	const byVerdict = { confirmed: 0, needs_validation: 0 };
	for (const f of findings) {
		bySeverity[f.severity]++;
		byVerdict[f.verdict]++;
	}
	return { total: findings.length, bySeverity, byVerdict };
}

/** Scan a project. Throws only when `path` is not a directory. */
export function audit(options: AuditOptions = {}): AuditResult {
	const now = options.now ?? (() => new Date());
	const started = now();
	const t0 = Date.now();
	const root = resolve(options.path ?? process.cwd());
	let isDir = false;
	try {
		isDir = statSync(root).isDirectory();
	} catch {
		// handled below
	}
	if (!isDir) throw new Error(`Not a directory: ${root}`);
	const minSeverity = options.minSeverity ?? 'high';

	const walk = walkFiles(root, options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE);
	const notes: string[] = [];
	const files = new Map<string, SourceFile>();
	let unreadable = 0;
	for (const rel of walk.files) {
		try {
			files.set(rel, { abs: join(root, rel), rel, text: readFileSync(join(root, rel), 'utf-8') });
		} catch {
			unreadable++;
		}
	}
	if (walk.skipped.length > 0) {
		notes.push(`Skipped ${walk.skipped.length} file(s) over the size limit: ${walk.skipped.slice(0, 5).join(', ')}${walk.skipped.length > 5 ? ', …' : ''}`);
	}

	const parseSvelte = [...files.keys()].some((f) => f.endsWith('.svelte')) ? loadSvelteParse(root) : null;
	const ctx: RuleContext = { files, notes, parseSvelte };
	if (!parseSvelte && [...files.keys()].some((f) => f.endsWith('.svelte'))) {
		notes.push('Svelte compiler not found: .svelte templates checked with a regex fallback ({@html} only).');
	}

	const raw: RawFinding[] = [];
	for (const file of files.values()) {
		const context = classifyFile(file.rel);
		if (context === 'env') {
			raw.push(...envRules(file).findings);
			continue;
		}
		raw.push(...codeRules(file, context, ctx).findings);
		if (context === 'test') continue;
		if (file.rel.endsWith('.svelte')) raw.push(...svelteRules(file, ctx).findings);
		raw.push(...kitRules(file, ctx).findings);
	}

	if (options.deps) {
		const deps = dependencyAdvisories(root, options.npmAudit);
		raw.push(...deps.findings);
		notes.push(...deps.notes);
	} else {
		notes.push('Dependency advisories skipped: run with --deps to include `npm audit --json`.');
	}

	const findings = finalizeFindings(raw);
	return {
		schemaVersion: 1,
		tool: 'svelte-grab audit',
		root,
		generatedAt: started.toISOString(),
		durationMs: Math.max(0, Date.now() - t0),
		filesScanned: files.size,
		filesSkipped: walk.skipped.length + unreadable,
		minSeverity,
		failed: findings.some((f) => f.verdict === 'confirmed' && atLeast(f.severity, minSeverity)),
		summary: summarize(findings),
		findings,
		notes
	};
}
