/**
 * `svelte-grab audit` command: argument parsing, reporters, files and the
 * exit code. {@link runAuditCli} returns the exit code instead of exiting:
 *
 * - 0: done (without `--ci` always 0, findings or not);
 * - 1: `--ci` and a confirmed finding at or above `--min-severity`;
 * - 2: usage error or the scan could not run.
 */
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { audit } from './index.js';
import { formatHtml, formatJson, formatText } from './report.js';
import { FINDING_SCHEMA, validateAuditReport } from './schema.js';
import type { AuditOptions, Severity } from './types.js';

export interface AuditCliArgs {
	path: string;
	/** `'-'` = JSON to stdout (no text report). */
	json: string | null;
	html: string | null;
	ci: boolean;
	minSeverity: Exclude<Severity, 'info'>;
	deps: boolean;
	schema: boolean;
	help: boolean;
}

export interface AuditCliIO {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	cwd: string;
	/** Colors in the text report (ignored with --ci). */
	color: boolean;
	writeFile: (path: string, content: string) => void;
	/** Extra options for {@link audit} (tests: npmAudit seam, clock). */
	auditOptions?: Partial<AuditOptions>;
}

export const AUDIT_HELP = `Usage: svelte-grab audit [options]

Static security scan of a Svelte / SvelteKit project (zero config).

Options:
  --path <dir>              Project root to scan (default: .)
  --json [file]             Write the JSON report to <file>; without a file (or "-"),
                            print JSON to stdout instead of the text report
  --html <file>             Write a single-file HTML report
  --ci                      No colors; exit 1 when a confirmed finding is at or
                            above --min-severity
  --min-severity <level>    CI threshold: high (default), medium or low
  --deps                    Also run \`npm audit --json\` for dependency advisories
  --schema                  Print the report JSON Schema and exit
`;

class UsageError extends Error {}

const LEVELS = ['high', 'medium', 'low'] as const;

/** Parse `audit` flags (`args` excludes the `audit` word). Accepts `--flag value` and `--flag=value`. */
export function parseAuditArgs(args: string[]): AuditCliArgs {
	const out: AuditCliArgs = {
		path: '.',
		json: null,
		html: null,
		ci: false,
		minSeverity: 'high',
		deps: false,
		schema: false,
		help: false
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const eq = arg.indexOf('=');
		const name = eq === -1 ? arg : arg.slice(0, eq);
		const inline = eq === -1 ? undefined : arg.slice(eq + 1);
		const next = args[i + 1];
		const hasNext = next !== undefined && !next.startsWith('--');
		const value = (required: boolean): string | undefined => {
			if (inline !== undefined) return inline;
			if (hasNext) {
				i++;
				return next;
			}
			if (required) throw new UsageError(`${name} needs a value`);
			return undefined;
		};
		switch (name) {
			case '--path':
				out.path = value(true)!;
				break;
			case '--json':
				out.json = value(false) ?? '-';
				break;
			case '--html':
				out.html = value(true)!;
				break;
			case '--ci':
				out.ci = true;
				break;
			case '--deps':
				out.deps = true;
				break;
			case '--schema':
				out.schema = true;
				break;
			case '--min-severity': {
				const level = value(true)!;
				if (!(LEVELS as readonly string[]).includes(level)) {
					throw new UsageError(
						`--min-severity must be one of ${LEVELS.join(', ')} (got "${level}")`
					);
				}
				out.minSeverity = level as AuditCliArgs['minSeverity'];
				break;
			}
			case '--help':
			case '-h':
				out.help = true;
				break;
			default:
				throw new UsageError(`Unknown option ${arg}`);
		}
	}
	return out;
}

export function defaultAuditIO(): AuditCliIO {
	return {
		stdout: (t) => process.stdout.write(t),
		stderr: (t) => process.stderr.write(t),
		cwd: process.cwd(),
		color: !!process.stdout.isTTY && !process.env.NO_COLOR,
		writeFile: (p, c) => writeFileSync(p, c, 'utf-8')
	};
}

/** Run the command; returns the process exit code. */
export function runAuditCli(args: string[], io: AuditCliIO = defaultAuditIO()): number {
	let parsed: AuditCliArgs;
	try {
		parsed = parseAuditArgs(args);
	} catch (err) {
		if (!(err instanceof UsageError)) throw err;
		io.stderr(`[svelte-grab] ${err.message}\n\n${AUDIT_HELP}`);
		return 2;
	}
	if (parsed.help) {
		io.stdout(AUDIT_HELP);
		return 0;
	}
	if (parsed.schema) {
		io.stdout(JSON.stringify(FINDING_SCHEMA, null, 2) + '\n');
		return 0;
	}

	let result;
	try {
		result = audit({
			...io.auditOptions,
			path: resolve(io.cwd, parsed.path),
			minSeverity: parsed.minSeverity,
			deps: parsed.deps
		});
	} catch (err) {
		io.stderr(`[svelte-grab] audit failed: ${(err as Error).message}\n`);
		return 2;
	}

	const validation = validateAuditReport(result);
	if (!validation.valid) {
		io.stderr(
			`[svelte-grab] internal error: report does not match its schema:\n  ${validation.errors.slice(0, 10).join('\n  ')}\n`
		);
		return 2;
	}

	try {
		if (parsed.json === '-') io.stdout(formatJson(result));
		else {
			io.stdout(formatText(result, { color: io.color && !parsed.ci }));
			if (parsed.json) {
				io.writeFile(resolve(io.cwd, parsed.json), formatJson(result));
				io.stdout(`JSON report: ${parsed.json}\n`);
			}
		}
		if (parsed.html) {
			io.writeFile(resolve(io.cwd, parsed.html), formatHtml(result));
			if (parsed.json !== '-') io.stdout(`HTML report: ${parsed.html}\n`);
		}
	} catch (err) {
		io.stderr(`[svelte-grab] could not write the report: ${(err as Error).message}\n`);
		return 2;
	}

	return parsed.ci && result.failed ? 1 : 0;
}
