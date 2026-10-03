/**
 * Reporters for `svelte-grab audit`: text (stdout, grouped by severity),
 * JSON (the schema-validated report) and a single-file HTML report (inline
 * CSS, no scripts, no external assets). All inputs are already redacted.
 */
import { SEVERITIES, type AuditFinding, type AuditResult, type Severity } from './types.js';

const ANSI = {
	reset: '\x1b[0m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	red: '\x1b[31m',
	yellow: '\x1b[33m',
	blue: '\x1b[34m',
	gray: '\x1b[90m',
	green: '\x1b[32m'
};

const SEVERITY_COLOR: Record<Severity, string> = {
	high: ANSI.red,
	medium: ANSI.yellow,
	low: ANSI.blue,
	info: ANSI.gray
};

export interface TextReportOptions {
	color?: boolean;
}

function countsLine(result: AuditResult): string {
	const s = result.summary;
	return `${s.bySeverity.high} high, ${s.bySeverity.medium} medium, ${s.bySeverity.low} low, ${s.bySeverity.info} info (${s.byVerdict.confirmed} confirmed, ${s.byVerdict.needs_validation} needs_validation)`;
}

/** `CI gate (min-severity high): FAIL, 2 confirmed finding(s) at or above high`. */
export function gateLine(result: AuditResult): string {
	const threshold = SEVERITIES.indexOf(result.minSeverity);
	const failing = result.findings.filter(
		(f) => f.verdict === 'confirmed' && SEVERITIES.indexOf(f.severity) <= threshold
	).length;
	return result.failed
		? `CI gate (min-severity ${result.minSeverity}): FAIL, ${failing} confirmed finding(s) at or above ${result.minSeverity}`
		: `CI gate (min-severity ${result.minSeverity}): PASS, no confirmed finding at or above ${result.minSeverity}`;
}

export function formatText(result: AuditResult, options: TextReportOptions = {}): string {
	const c = (code: string, text: string) => (options.color ? `${code}${text}${ANSI.reset}` : text);
	const lines: string[] = [];
	lines.push(
		c(
			ANSI.bold,
			`svelte-grab audit: ${result.filesScanned} files scanned in ${result.root} (${result.durationMs} ms)`
		)
	);
	lines.push('');
	if (result.findings.length === 0) lines.push(c(ANSI.green, 'No findings.'));
	for (const severity of SEVERITIES) {
		const group = result.findings.filter((f) => f.severity === severity);
		if (group.length === 0) continue;
		lines.push(
			c(ANSI.bold + SEVERITY_COLOR[severity], `${severity.toUpperCase()} (${group.length})`)
		);
		for (const f of group) {
			lines.push(`  [${f.verdict}] ${c(ANSI.bold, f.rule)}  ${f.title}`);
			lines.push(`    ${c(ANSI.dim, f.source)}`);
			lines.push(`    evidence: ${f.evidence}`);
			lines.push(`    fix: ${f.fix}`);
		}
		lines.push('');
	}
	lines.push(`Summary: ${countsLine(result)}`);
	lines.push(c(result.failed ? ANSI.red : ANSI.green, gateLine(result)));
	if (result.notes.length > 0) {
		lines.push('Notes:');
		for (const note of result.notes) lines.push(`  - ${note}`);
	}
	return lines.join('\n') + '\n';
}

export function formatJson(result: AuditResult): string {
	return JSON.stringify(result, null, 2) + '\n';
}

function esc(value: string | number): string {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function findingRow(f: AuditFinding): string {
	return `<tr>
<td><span class="sev sev-${f.severity}">${esc(f.severity)}</span></td>
<td><span class="verdict verdict-${f.verdict}">${esc(f.verdict.replace('_', ' '))}</span></td>
<td><code>${esc(f.rule)}</code><div class="title">${esc(f.title)}</div><div class="id">${esc(f.id)}</div></td>
<td><code>${esc(f.source)}</code></td>
<td><pre>${esc(f.evidence)}</pre></td>
<td>${esc(f.fix)}</td>
</tr>`;
}

export function formatHtml(result: AuditResult): string {
	const s = result.summary;
	const cards = SEVERITIES.map(
		(sev) =>
			`<div class="card sev-${sev}"><div class="n">${s.bySeverity[sev]}</div><div>${sev}</div></div>`
	).join('');
	const sections = SEVERITIES.map((sev) => {
		const group = result.findings.filter((f) => f.severity === sev);
		if (group.length === 0) return '';
		return `<h2>${esc(sev.toUpperCase())} (${group.length})</h2>
<table><thead><tr><th>Severity</th><th>Verdict</th><th>Rule</th><th>Location</th><th>Evidence (redacted)</th><th>Fix</th></tr></thead>
<tbody>${group.map(findingRow).join('\n')}</tbody></table>`;
	}).join('\n');
	const notes = result.notes.length
		? `<h2>Notes</h2><ul>${result.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`
		: '';
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>svelte-grab audit report</title>
<style>
:root { --bg: #ffffff; --fg: #1d1d1f; --muted: #6b6b70; --border: #e2e2e6; --code: #f4f4f6;
  --high: #c62828; --medium: #b26a00; --low: #1565c0; --info: #616161; --ok: #2e7d32; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #16161a; --fg: #ececf1; --muted: #9a9aa3; --border: #2c2c33; --code: #22222a;
    --high: #ef5350; --medium: #ffb74d; --low: #64b5f6; --info: #bdbdbd; --ok: #81c784; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1200px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 28px 0 8px; }
.meta { color: var(--muted); margin-bottom: 16px; word-break: break-all; }
.cards { display: flex; flex-wrap: wrap; gap: 12px; margin: 16px 0; }
.card { border: 1px solid var(--border); border-radius: 8px; padding: 10px 16px; min-width: 96px; text-transform: capitalize; }
.card .n { font-size: 24px; font-weight: 700; }
.card.sev-high .n { color: var(--high); } .card.sev-medium .n { color: var(--medium); }
.card.sev-low .n { color: var(--low); } .card.sev-info .n { color: var(--info); }
.status { font-weight: 600; } .status.fail { color: var(--high); } .status.ok { color: var(--ok); }
table { width: 100%; border-collapse: collapse; margin-bottom: 8px; display: block; overflow-x: auto; }
th, td { text-align: left; vertical-align: top; padding: 8px; border-bottom: 1px solid var(--border); }
th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; }
code, pre { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); border-radius: 4px; }
code { padding: 1px 4px; } pre { margin: 0; padding: 6px; white-space: pre-wrap; word-break: break-all; max-width: 420px; }
.title { margin-top: 4px; } .id { color: var(--muted); font-size: 12px; }
.sev { font-weight: 700; text-transform: uppercase; font-size: 12px; }
.sev-high { color: var(--high); } .sev-medium { color: var(--medium); } .sev-low { color: var(--low); } .sev-info { color: var(--info); }
.verdict { font-size: 12px; white-space: nowrap; } .verdict-confirmed { font-weight: 700; }
</style>
</head>
<body>
<main>
<h1>svelte-grab audit report</h1>
<div class="meta">${esc(result.root)} · ${esc(result.generatedAt)} · ${result.filesScanned} files · ${result.durationMs} ms</div>
<div class="cards">${cards}</div>
<p class="status ${result.failed ? 'fail' : 'ok'}">${esc(gateLine(result))}</p>
<p>${esc(countsLine(result))}</p>
${result.findings.length === 0 ? '<p>No findings.</p>' : sections}
${notes}
</main>
</body>
</html>
`;
}
