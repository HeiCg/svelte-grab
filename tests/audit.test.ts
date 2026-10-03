import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	audit,
	validateAuditReport,
	type AuditFinding,
	type AuditResult
} from '../src/cli/audit/index.js';
import { runAuditCli, type AuditCliIO } from '../src/cli/audit/cli.js';
import { formatHtml, formatText } from '../src/cli/audit/report.js';
import { FAKE, cleanupFixtures, makeFixtureApp, makeProject } from './audit-helpers.js';

const ESC = '\x1b[';
let dir: string;
let result: AuditResult;

beforeAll(() => {
	dir = makeFixtureApp();
	result = audit({ path: dir });
});
afterAll(cleanupFixtures);

const of = (rule: string, file?: string) =>
	result.findings.filter((f) => f.rule === rule && (file === undefined || f.file === file));
const lines = (fs: AuditFinding[]) => fs.map((f) => f.line).sort((a, b) => a - b);

function cli(args: string[], cwd = dir) {
	const out: string[] = [];
	const err: string[] = [];
	const written = new Map<string, string>();
	const io: AuditCliIO = {
		stdout: (t) => out.push(t),
		stderr: (t) => err.push(t),
		cwd,
		color: true,
		writeFile: (p, c) => written.set(p, c)
	};
	const code = runAuditCli(args, io);
	return { code, stdout: out.join(''), stderr: err.join(''), written };
}

describe('audit: walker on the fixture app', () => {
	it('skips default-ignored dirs, .gitignore matches, test files and files over 1 MB', () => {
		const files = new Set(result.findings.map((f) => f.file));
		for (const f of files) {
			expect(f).not.toMatch(/^(node_modules|dist|build|coverage|\.svelte-kit|ignored-dir)\//);
			expect(f).not.toBe('src/lib/keys.spec.js');
			expect(f).not.toBe('src/lib/huge.ts');
		}
		expect(result.filesSkipped).toBe(1);
		expect(result.notes.some((n) => n.includes('src/lib/huge.ts'))).toBe(true);
	});

	it('scans the gitignored .env file anyway', () => {
		expect(of('env/public-secret', '.env').length).toBeGreaterThan(0);
	});
});

describe('audit: secrets', () => {
	it('flags a provider secret in client-reachable code as high / confirmed', () => {
		const [f] = of('secrets/client-exposure', 'src/lib/config.ts');
		expect(f).toMatchObject({ severity: 'high', verdict: 'confirmed', line: 2 });
		expect(f.evidence).toContain('stripe-secret-key:sk_l…(len 32');
	});

	it('never reports server-only files as client exposure (server dir, .server., +server)', () => {
		for (const file of [
			'src/lib/server/db.ts',
			'src/lib/secrets.server.ts',
			'src/routes/api/+server.ts'
		]) {
			expect(of('secrets/client-exposure', file)).toEqual([]);
			const hard = of('secrets/hardcoded-server', file);
			expect(hard).toHaveLength(1);
			expect(hard[0].severity).not.toBe('high');
			expect(hard[0].verdict).toBe('needs_validation');
		}
	});

	it('only client-reachable files produce secrets/client-exposure', () => {
		expect(of('secrets/client-exposure').map((f) => f.file)).toEqual(['src/lib/config.ts']);
	});
});

describe('audit: .env', () => {
	it('flags secret-shaped PUBLIC_/VITE_ values, skips anon JWTs, private keys and ids', () => {
		const env = of('env/public-secret', '.env');
		expect(env.map((f) => [f.line, f.severity, f.verdict])).toEqual([
			[2, 'high', 'confirmed'],
			[3, 'high', 'confirmed']
		]);
		expect(env[0].title).toContain('PUBLIC_STRIPE_KEY');
		expect(env[1].title).toContain('Supabase service_role');
	});
});

describe('audit: .svelte templates', () => {
	const page = 'src/routes/+page.svelte';

	it('{@html} with a non-literal expression only', () => {
		const html = of('svelte/html-non-literal', page);
		expect(lines(html)).toEqual([12]);
		expect(html[0]).toMatchObject({
			severity: 'medium',
			verdict: 'needs_validation',
			evidence: '{@html content}'
		});
	});

	it('target=_blank without rel only for the external link lacking noopener', () => {
		const blank = of('svelte/target-blank-noopener', page);
		expect(lines(blank)).toEqual([15]);
		expect(blank[0]).toMatchObject({ severity: 'low', verdict: 'confirmed', column: 1 });
	});

	it('string on* handler, not function handlers', () => {
		expect(lines(of('svelte/inline-handler-string', page))).toEqual([18]);
	});

	it('<svelte:window onmessage> resolved to a handler without origin check', () => {
		const msg = of('js/postmessage-no-origin', page);
		expect(lines(msg)).toEqual([10]);
		expect(msg[0].verdict).toBe('confirmed');
	});
});

describe('audit: JS/TS rules', () => {
	const file = 'src/lib/unsafe.ts';

	it('eval( and new Function(, not in comments', () => {
		const ev = of('js/eval', file);
		expect(lines(ev)).toEqual([2, 5]);
		expect(ev.every((f) => f.severity === 'medium' && f.verdict === 'confirmed')).toBe(true);
	});

	it('message listener without origin check; not the checked one nor WebSocket messages', () => {
		const msg = of('js/postmessage-no-origin', file);
		expect(lines(msg)).toEqual([9]);
		expect(msg[0]).toMatchObject({ severity: 'medium', verdict: 'confirmed' });
	});

	it('token-ish localStorage keys only', () => {
		const st = of('storage/token-in-web-storage', file);
		expect(st).toHaveLength(1);
		expect(st[0]).toMatchObject({ line: 23, severity: 'medium', verdict: 'confirmed' });
		expect(st[0].title).toContain('authToken');
	});
});

describe('audit: SvelteKit rules', () => {
	it('load returning a whole DB row (bare identifier or spread), not a field-selected one', () => {
		const load = of('kit/load-overexposure');
		expect(load.map((f) => `${f.file}:${f.line}`)).toEqual([
			'src/routes/+page.server.ts:6',
			'src/routes/profile/+layout.server.ts:5'
		]);
		expect(load.every((f) => f.verdict === 'needs_validation')).toBe(true);
		expect(load[0].title).toMatch(/over-exposure of server data/);
		expect(load[0].evidence).toContain('db.user.findUnique');
	});

	it('form actions without an auth check only', () => {
		const actions = of('kit/action-no-auth');
		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({
			file: 'src/routes/+page.server.ts',
			line: 10,
			verdict: 'needs_validation'
		});
		expect(actions[0].title).toContain('"update"');
	});

	it('remote command without an auth check only (query is not checked)', () => {
		const remote = of('kit/remote-no-auth');
		expect(remote).toHaveLength(1);
		expect(remote[0]).toMatchObject({ file: 'src/lib/todos.remote.ts', line: 5 });
		expect(remote[0].title).toContain('"addTodo"');
	});

	it("csrf.trustedOrigins '*' is high / confirmed; missing csp is low", () => {
		expect(of('kit/csrf-trusted-origins-wildcard', 'svelte.config.js')).toMatchObject([
			{ severity: 'high', verdict: 'confirmed', line: 5 }
		]);
		expect(of('kit/csp-missing', 'svelte.config.js')).toMatchObject([{ severity: 'low', line: 3 }]);
	});

	it('csp-missing is silent when kit.csp is configured or a hook sets the header', () => {
		const withCsp = audit({
			path: makeProject({
				'svelte.config.js': "export default { kit: { csp: { mode: 'auto' } } };\n"
			})
		});
		expect(withCsp.findings.filter((f) => f.rule === 'kit/csp-missing')).toEqual([]);
		const withHook = audit({
			path: makeProject({
				'svelte.config.js': 'export default { kit: {} };\n',
				'src/hooks.server.ts':
					"export const handle = async ({ event, resolve }) => { const r = await resolve(event); r.headers.set('Content-Security-Policy', \"default-src 'self'\"); return r; };\n"
			})
		});
		expect(withHook.findings.filter((f) => f.rule === 'kit/csp-missing')).toEqual([]);
	});
});

describe('audit: result shape', () => {
	it('validates against the schema, ids are stable, findings sorted by severity', () => {
		expect(validateAuditReport(result)).toEqual({ valid: true, errors: [] });
		const again = audit({ path: dir });
		expect(again.findings.map((f) => f.id)).toEqual(result.findings.map((f) => f.id));
		const rank = { high: 0, medium: 1, low: 2, info: 3 };
		const ranks = result.findings.map((f) => rank[f.severity]);
		expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
		expect(new Set(result.findings.map((f) => f.id)).size).toBe(result.findings.length);
	});

	it('notes that dependency advisories were skipped without --deps', () => {
		expect(result.notes.some((n) => /Dependency advisories skipped.*--deps/.test(n))).toBe(true);
	});

	it('throws on a missing directory', () => {
		expect(() => audit({ path: '/definitely/not/here' })).toThrow(/Not a directory/);
	});
});

describe('audit: redaction', () => {
	it('no output format ever contains a full fake secret', () => {
		const outputs = [
			JSON.stringify(result),
			formatText(result),
			formatHtml(result),
			cli(['--json']).stdout,
			cli(['--ci']).stdout
		];
		for (const out of outputs) {
			for (const secret of [FAKE.stripe, FAKE.aws, FAKE.serviceRole, FAKE.anonJwt]) {
				expect(out).not.toContain(secret);
			}
			// Not even the secret body past the 4-char prefix.
			expect(out).not.toContain('FAKEfake0000FAKEfake0000');
			expect(out).not.toContain('FAKE0EXAMPLE0KEY');
		}
	});
});

describe('audit CLI', () => {
	it('--ci exits 1 on a confirmed high finding, with no ANSI colors', () => {
		const run = cli(['--path', dir, '--ci']);
		expect(run.code).toBe(1);
		expect(run.stdout.includes(ESC)).toBe(false);
		expect(run.stdout).toMatch(/^HIGH \(\d+\)$/m);
		expect(run.stdout).toMatch(/^MEDIUM \(\d+\)$/m);
		// stripe in config.ts, two PUBLIC_/VITE_ secrets in .env, trustedOrigins '*'
		expect(run.stdout).toContain(
			'CI gate (min-severity high): FAIL, 4 confirmed finding(s) at or above high'
		);
	});

	it('without --ci exits 0 even with findings, and colors when the IO allows', () => {
		const run = cli([`--path=${dir}`]);
		expect(run.code).toBe(0);
		expect(run.stdout.includes(ESC)).toBe(true);
	});

	it('--min-severity sets the CI threshold', () => {
		const lowOnly = makeProject({
			'src/routes/+page.svelte': '<a href="https://x.example" target="_blank">x</a>\n'
		});
		expect(cli(['--path', lowOnly, '--ci']).code).toBe(0);
		expect(cli(['--path', lowOnly, '--ci', '--min-severity', 'medium']).code).toBe(0);
		expect(cli(['--path', lowOnly, '--ci', '--min-severity=low']).code).toBe(1);
	});

	it('needs_validation findings never fail CI', () => {
		const heuristic = makeProject({
			'src/routes/+page.svelte': '<script>let x = $state("");</script>\n{@html x}\n'
		});
		const run = cli(['--path', heuristic, '--ci', '--min-severity', 'low']);
		expect(run.stdout).toContain('svelte/html-non-literal');
		expect(run.code).toBe(0);
	});

	it('a clean project exits 0 under --ci', () => {
		const clean = makeProject({
			'src/lib/add.ts': 'export const add = (a: number, b: number) => a + b;\n'
		});
		const run = cli(['--path', clean, '--ci']);
		expect(run.code).toBe(0);
		expect(run.stdout).toContain('No findings.');
	});

	it('--json without a file prints only a schema-valid JSON report', () => {
		const run = cli(['--path', dir, '--json']);
		const report = JSON.parse(run.stdout);
		expect(validateAuditReport(report).valid).toBe(true);
		expect(report.findings.length).toBe(result.findings.length);
	});

	it('--json <file> and --html <file> write the reports next to the text output', () => {
		const run = cli(['--path', dir, '--json', 'out/report.json', '--html', 'out/report.html']);
		expect(run.code).toBe(0);
		const files = [...run.written.keys()];
		expect(files.some((f) => f.endsWith('out/report.json'))).toBe(true);
		const json = JSON.parse([...run.written.entries()].find(([f]) => f.endsWith('.json'))![1]);
		expect(validateAuditReport(json).valid).toBe(true);
		const html = [...run.written.entries()].find(([f]) => f.endsWith('.html'))![1];
		expect(html).toMatch(/^<!doctype html>/);
		expect(html).toContain('<style>');
		expect(html).not.toMatch(/<script|<link|src="http|href="http/);
		expect(html).toContain('csrf.trustedOrigins');
		expect(run.stdout).toContain('JSON report: out/report.json');
	});

	it('usage errors exit 2', () => {
		expect(cli(['--bogus']).code).toBe(2);
		expect(cli(['--min-severity', 'critical']).code).toBe(2);
		expect(cli(['--html']).code).toBe(2);
		expect(cli(['--path', '/definitely/not/here']).code).toBe(2);
	});

	it('--schema prints the JSON Schema; --help prints usage', () => {
		const schema = JSON.parse(cli(['--schema']).stdout);
		expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
		expect(cli(['--help']).stdout).toContain('--min-severity');
	});
});
