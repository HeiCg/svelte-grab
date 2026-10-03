/**
 * Types of `svelte-grab audit` (docs/agent-runtime-spec.md, Phase 9c).
 *
 * A static finding reuses the runtime `ui_security_scan` shape (9b:
 * `{ id, severity, verdict, title, evidence, source?, fix }`) and adds the
 * rule id and the location split into `file` / `line` / `column`.
 */

export type Severity = 'high' | 'medium' | 'low' | 'info';
export type Verdict = 'confirmed' | 'needs_validation';

export const SEVERITIES: readonly Severity[] = ['high', 'medium', 'low', 'info'];
export const VERDICTS: readonly Verdict[] = ['confirmed', 'needs_validation'];

/** Rule ids, `<group>/<name>`. */
export const RULE_IDS = [
	'svelte/html-non-literal',
	'svelte/target-blank-noopener',
	'svelte/inline-handler-string',
	'secrets/client-exposure',
	'secrets/hardcoded-server',
	'env/public-secret',
	'kit/load-overexposure',
	'kit/action-no-auth',
	'kit/remote-no-auth',
	'kit/csrf-trusted-origins-wildcard',
	'kit/csp-missing',
	'js/eval',
	'js/postmessage-no-origin',
	'storage/token-in-web-storage',
	'deps/advisory'
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export interface AuditFinding {
	/** `<rule>:<6 hex>`, stable across runs for the same issue in the same file. */
	id: string;
	rule: RuleId;
	severity: Severity;
	verdict: Verdict;
	title: string;
	/** Redacted: never contains a full secret. */
	evidence: string;
	/** Path relative to the scanned root, `/` separators. */
	file: string;
	/** 1-based. */
	line: number;
	/** 1-based. */
	column: number;
	/** `file:line:column`. */
	source: string;
	fix: string;
}

/** A finding before the id / source are derived. */
export type RawFinding = Omit<AuditFinding, 'id' | 'source'>;

export interface AuditSummary {
	total: number;
	bySeverity: Record<Severity, number>;
	byVerdict: Record<Verdict, number>;
}

export interface AuditResult {
	schemaVersion: 1;
	tool: 'svelte-grab audit';
	/** Absolute path of the scanned root. */
	root: string;
	generatedAt: string;
	durationMs: number;
	filesScanned: number;
	/** Files over the size limit or unreadable. */
	filesSkipped: number;
	/** CI threshold: confirmed findings at or above it fail the run. */
	minSeverity: Exclude<Severity, 'info'>;
	/** True when a confirmed finding is at or above `minSeverity`. */
	failed: boolean;
	summary: AuditSummary;
	findings: AuditFinding[];
	/** Informational notes (skipped checks, parse errors). */
	notes: string[];
}

/** Runs `npm audit --json` in `cwd`; returns stdout, or throws. Test seam. */
export type NpmAuditRunner = (cwd: string, timeoutMs: number) => string;

export interface AuditOptions {
	/** Project root to scan (default: `process.cwd()`). */
	path?: string;
	/** CI threshold (default `high`). */
	minSeverity?: Exclude<Severity, 'info'>;
	/** Run `npm audit --json` for dependency advisories (default false). */
	deps?: boolean;
	/** Override the `npm audit` runner (tests). */
	npmAudit?: NpmAuditRunner;
	/** Max file size in bytes (default 1 MB). */
	maxFileSize?: number;
	/** Clock (tests). */
	now?: () => Date;
}

/** A file handed to the rules. */
export interface SourceFile {
	/** Absolute path. */
	abs: string;
	/** Relative to the root, `/` separators. */
	rel: string;
	text: string;
}
