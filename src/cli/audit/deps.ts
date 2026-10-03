/**
 * Dependency advisories for `svelte-grab audit --deps`: runs `npm audit
 * --json` (spawned, 60 s timeout) and maps every vulnerable package to a
 * `deps/advisory` finding. Severity: critical/high -> high, moderate ->
 * medium, low -> low, info -> info. Verdict: `confirmed` for the framework
 * (`svelte`, `@sveltejs/*`: the installed version is in a vulnerable range of
 * code every page runs), `needs_validation` for the rest (reachability of a
 * transitive or dev dependency is unknown).
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { lineColAt, lineStarts } from './source.js';
import type { NpmAuditRunner, RawFinding, Severity } from './types.js';

export const NPM_AUDIT_TIMEOUT_MS = 60_000;

export const defaultNpmAudit: NpmAuditRunner = (cwd, timeoutMs) => {
	const res = spawnSync('npm', ['audit', '--json'], {
		cwd,
		timeout: timeoutMs,
		encoding: 'utf-8',
		maxBuffer: 64 * 1024 * 1024,
		shell: process.platform === 'win32'
	});
	if (res.error) throw res.error;
	if (res.signal) throw new Error(`npm audit was killed (${res.signal}), timeout ${timeoutMs} ms`);
	return res.stdout ?? '';
};

interface NpmVia {
	title?: string;
	url?: string;
	severity?: string;
	range?: string;
}

interface NpmVulnerability {
	name?: string;
	severity?: string;
	isDirect?: boolean;
	via?: (string | NpmVia)[];
	range?: string;
	fixAvailable?: boolean | { name?: string; version?: string; isSemVerMajor?: boolean };
}

const SEVERITY_MAP: Record<string, Severity> = {
	critical: 'high',
	high: 'high',
	moderate: 'medium',
	low: 'low',
	info: 'info'
};

export function isFrameworkPackage(name: string): boolean {
	return name === 'svelte' || name.startsWith('@sveltejs/');
}

/** Parse `npm audit --json` output into findings, or throw with the npm error summary. */
export function parseNpmAudit(stdout: string, packageJsonText: string | null): RawFinding[] {
	let data: {
		vulnerabilities?: Record<string, NpmVulnerability>;
		error?: { code?: string; summary?: string };
	};
	try {
		data = JSON.parse(stdout);
	} catch {
		throw new Error('npm audit did not return JSON');
	}
	if (data.error)
		throw new Error(
			`npm audit failed: ${data.error.code ?? ''} ${data.error.summary ?? ''}`.trim()
		);
	const starts = packageJsonText ? lineStarts(packageJsonText) : null;
	const findings: RawFinding[] = [];
	for (const [key, vuln] of Object.entries(data.vulnerabilities ?? {})) {
		const name = vuln.name ?? key;
		const severity = SEVERITY_MAP[vuln.severity ?? ''] ?? 'low';
		const advisories = (vuln.via ?? []).filter(
			(v): v is NpmVia => typeof v === 'object' && v !== null
		);
		const via = (vuln.via ?? []).filter((v): v is string => typeof v === 'string');
		const titles = advisories.map((a) => `${a.title ?? 'advisory'}${a.url ? ` (${a.url})` : ''}`);
		const fix =
			vuln.fixAvailable === true
				? `Run \`npm audit fix\` (or upgrade ${name} out of ${vuln.range ?? 'the vulnerable range'}).`
				: vuln.fixAvailable && typeof vuln.fixAvailable === 'object'
					? `Upgrade ${vuln.fixAvailable.name ?? name} to ${vuln.fixAvailable.version ?? 'a fixed version'}${vuln.fixAvailable.isSemVerMajor ? ' (semver-major)' : ''}.`
					: `No fix available yet: check whether the vulnerable code path is reachable, or replace ${name}.`;
		let line = 1;
		let column = 1;
		if (packageJsonText && starts) {
			const at = packageJsonText.indexOf(`"${name}"`);
			if (at !== -1) ({ line, column } = lineColAt(starts, at));
		}
		findings.push({
			rule: 'deps/advisory',
			severity,
			verdict: isFrameworkPackage(name) ? 'confirmed' : 'needs_validation',
			title: `${name}${vuln.range ? ` ${vuln.range}` : ''}: ${vuln.severity ?? 'unknown'} severity advisory${vuln.isDirect ? '' : ' (transitive)'}`,
			evidence: titles.length > 0 ? titles.join('; ') : `via ${via.join(', ') || 'unknown'}`,
			file: 'package.json',
			line,
			column,
			fix
		});
	}
	return findings;
}

/** Run npm audit in `root`; findings plus notes (never throws). */
export function dependencyAdvisories(
	root: string,
	runner: NpmAuditRunner = defaultNpmAudit
): { findings: RawFinding[]; notes: string[] } {
	const pkgPath = join(root, 'package.json');
	if (!existsSync(pkgPath))
		return {
			findings: [],
			notes: ['Dependency advisories skipped: no package.json at the scan root.']
		};
	let pkgText: string | null = null;
	try {
		pkgText = readFileSync(pkgPath, 'utf-8');
	} catch {
		// line numbers fall back to 1:1
	}
	try {
		const stdout = runner(root, NPM_AUDIT_TIMEOUT_MS);
		const findings = parseNpmAudit(stdout, pkgText);
		return {
			findings,
			notes: [`Dependency advisories: npm audit reported ${findings.length} vulnerable package(s).`]
		};
	} catch (err) {
		return { findings: [], notes: [`Dependency advisories skipped: ${(err as Error).message}`] };
	}
}
