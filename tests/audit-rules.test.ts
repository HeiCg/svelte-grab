import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
	audit,
	FINDING_SCHEMA,
	validateAgainstSchema,
	validateAuditReport
} from '../src/cli/audit/index.js';
import { parseAuditArgs } from '../src/cli/audit/cli.js';
import { parseNpmAudit } from '../src/cli/audit/deps.js';
import { svelteRules } from '../src/cli/audit/rules/svelte.js';
import {
	classifyFile,
	functionBodyAfter,
	isServerOnly,
	lineColAt,
	lineStarts,
	maskComments
} from '../src/cli/audit/source.js';
import { isIgnored, parseGitignore } from '../src/cli/audit/walker.js';
import { FAKE, cleanupFixtures, makeProject } from './audit-helpers.js';

afterAll(cleanupFixtures);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('shared secret rules', () => {
	it('stay importable from Node and the browser: no imports, no DOM or Node globals', () => {
		const src = readFileSync(join(root, 'src/lib/security/secret-rules.ts'), 'utf-8');
		const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
		expect(code).not.toMatch(/^\s*import\s/m);
		expect(code).not.toMatch(
			/\b(?:window|document|navigator|localStorage|process|require|Buffer|globalThis)\b/
		);
	});
});

describe('finding schema', () => {
	it('src/cli/audit/finding-schema.json matches the schema the CLI validates against', () => {
		const file = JSON.parse(readFileSync(join(root, 'src/cli/audit/finding-schema.json'), 'utf-8'));
		expect(file).toEqual(JSON.parse(JSON.stringify(FINDING_SCHEMA)));
	});

	it('rejects malformed reports', () => {
		const report = audit({ path: makeProject({ 'src/lib/a.ts': 'eval(x);\n' }) });
		expect(validateAuditReport(report).valid).toBe(true);
		const broken = JSON.parse(JSON.stringify(report));
		broken.findings[0].severity = 'critical';
		broken.findings[0].line = 0;
		broken.findings[0].extra = true;
		delete broken.findings[0].fix;
		broken.summary.total = -1;
		const { valid, errors } = validateAuditReport(broken);
		expect(valid).toBe(false);
		expect(errors).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^\/findings\/0\/severity: must be one of/),
				'/findings/0/line: below 1',
				'/findings/0: unexpected property "extra"',
				'/findings/0: missing required "fix"',
				'/summary/total: below 0'
			])
		);
	});

	it('validator: type, const, pattern, minLength, $ref', () => {
		const schema = {
			type: 'object',
			properties: { a: { $ref: '#/$defs/s' }, b: { const: 1 }, c: { type: ['string', 'null'] } },
			$defs: { s: { type: 'string', pattern: '^x', minLength: 2 } }
		};
		expect(validateAgainstSchema({ a: 'xy', b: 1, c: null }, schema).valid).toBe(true);
		expect(validateAgainstSchema({ a: 'y', b: 2, c: 3 }, schema).errors).toEqual([
			'/a: shorter than 2',
			'/a: does not match ^x',
			'/b: must equal 1',
			'/c: must be string | null, got integer'
		]);
	});
});

describe('walker: .gitignore subset', () => {
	const rules = parseGitignore(
		['# c', '*.log', '/build-out', 'tmp/', 'docs/**/draft.md', '!keep.log', 'a/b'].join('\n')
	);
	it.each([
		['x.log', false, true],
		['deep/x.log', false, true],
		['keep.log', false, false],
		['build-out', true, true],
		['src/build-out', true, false],
		['tmp', true, true],
		['tmp', false, false],
		['docs/x/y/draft.md', false, true],
		['docs/draft.md', false, true],
		['a/b', true, true],
		['z/a/b', true, false]
	])('%s (dir=%s) ignored=%s', (path, isDir, expected) => {
		expect(isIgnored(rules, path, isDir)).toBe(expected);
	});

	it('nested .gitignore rules are relative to their directory', () => {
		const nested = parseGitignore('/gen\n', 'pkg');
		expect(isIgnored(nested, 'pkg/gen', true)).toBe(true);
		expect(isIgnored(nested, 'gen', true)).toBe(false);
	});
});

describe('file classification', () => {
	it.each([
		['src/lib/server/db.ts', 'server'],
		['src/lib/server/nested/x.ts', 'server'],
		['src/lib/secrets.server.ts', 'server'],
		['src/hooks.server.ts', 'server'],
		['src/routes/+page.server.ts', 'server'],
		['src/routes/+layout.server.js', 'server'],
		['src/routes/api/+server.ts', 'server'],
		['src/lib/todos.remote.ts', 'server'],
		['src/lib/config.ts', 'client'],
		['src/routes/+page.svelte', 'client'],
		['src/routes/+page.ts', 'client'],
		['src/hooks.client.ts', 'client'],
		['src/routes/test/+page.svelte', 'client'],
		['static/sw.js', 'client'],
		['src/lib/a.test.ts', 'test'],
		['tests/x.ts', 'test'],
		['tests/fixtures/app/src/routes/+page.svelte', 'test'],
		['tests/fixtures/app/src/lib/todos.remote.ts', 'test'],
		['src/lib/server/db.test.ts', 'test'],
		['src/routes/e2e/+page.ts', 'client'],
		['svelte.config.js', 'tooling'],
		['src/vite.config.ts', 'tooling'],
		['scripts/seed.js', 'tooling'],
		['.env.local', 'env']
	])('%s -> %s', (rel, context) => {
		expect(classifyFile(rel)).toBe(context);
	});

	it('serverless names that merely contain "server" are not server-only', () => {
		expect(isServerOnly('src/lib/serverless-info.ts')).toBe(false);
		expect(isServerOnly('src/lib/observer.ts')).toBe(false);
	});
});

describe('source helpers', () => {
	it('maskComments keeps offsets and strings', () => {
		const code = "a(); // eval(x)\nconst s = '// not a comment'; /* eval(y) */ b();";
		const masked = maskComments(code);
		expect(masked.length).toBe(code.length);
		expect(masked).not.toContain('eval');
		expect(masked).toContain("'// not a comment'");
	});

	it('functionBodyAfter: arrow, async function, single param, expression body', () => {
		const pick = (code: string, at = 0) => {
			const b = functionBodyAfter(code, at);
			return b ? code.slice(b.start, b.end).trim() : null;
		};
		expect(pick('async ({ a }: T) => { return a; }')).toBe('return a;');
		expect(pick('function f(x) { x(); }')).toBe('x();');
		expect(pick('e => { go(e) }')).toBe('go(e)');
		expect(pick('(e) => e.origin;')).toBe('e.origin');
	});

	it('lineColAt is 1-based', () => {
		const text = 'ab\ncd\n';
		expect(lineColAt(lineStarts(text), 4)).toEqual({ line: 2, column: 2 });
	});
});

describe('rules: edge cases', () => {
	const run = (files: Record<string, string>) => audit({ path: makeProject(files) }).findings;

	it('load wrapped in `satisfies` and returning a direct DB call', () => {
		const f = run({
			'src/routes/+page.server.ts':
				'export const load = (async () => {\n\treturn { rows: await db.select().from(users) };\n}) satisfies PageServerLoad;\n'
		});
		expect(f.map((x) => x.rule)).toEqual(['kit/load-overexposure']);
	});

	it('load returning locals data or selected fields is not flagged', () => {
		const f = run({
			'src/routes/+layout.server.ts':
				'export const load = ({ locals }) => ({ user: locals.user });\n',
			'src/routes/a/+page.server.ts':
				"export async function load() {\n\tconst { data: user } = await supabase.from('users').select('id, name').single();\n\treturn { user };\n}\n"
		});
		expect(f).toEqual([]);
	});

	it('actions referencing named handlers are resolved', () => {
		const f = run({
			'src/routes/+page.server.ts': [
				'async function save({ locals }) { if (!locals.user) redirect(303, "/login"); }',
				'async function wipe() { await db.query("DELETE"); }',
				'export const actions = { save, wipe: wipe, default: async ({ request }) => { await request.formData(); } };',
				''
			].join('\n')
		});
		expect(f.filter((x) => x.rule === 'kit/action-no-auth').map((x) => x.title)).toEqual([
			'Form action "wipe" without an obvious auth check',
			'Form action "default" without an obvious auth check'
		]);
	});

	it('remote form with an aliased import, auth via a helper call', () => {
		const f = run({
			'src/lib/a.remote.ts': [
				"import { form as remoteForm, command } from '$app/server';",
				'export const create = remoteForm(async (data) => { requireUser(); });',
				'export const update = command(async () => {});',
				''
			].join('\n')
		});
		expect(f.filter((x) => x.rule === 'kit/remote-no-auth').map((x) => x.title)).toEqual([
			'Remote command "update" without an obvious auth check'
		]);
	});

	it('message handler declared elsewhere: resolved, or needs_validation when not found', () => {
		const f = run({
			'src/lib/a.ts': [
				'function onMsg(e) { if (e.origin !== ORIGIN) return; }',
				"window.addEventListener('message', onMsg);",
				"window.addEventListener('message', imported);",
				'window.onmessage = (e) => { use(e.data); };',
				''
			].join('\n')
		});
		const msg = f.filter((x) => x.rule === 'js/postmessage-no-origin');
		expect(msg.map((x) => [x.line, x.verdict])).toEqual([
			[3, 'needs_validation'],
			[4, 'confirmed']
		]);
	});

	it('sessionStorage is low; key held in a token-named constant is needs_validation', () => {
		const f = run({
			'src/lib/a.ts':
				"sessionStorage.setItem('jwt', t);\nlocalStorage.setItem(TOKEN_KEY, t);\nlocalStorage.refreshToken = t;\n"
		});
		expect(f.map((x) => [x.line, x.severity, x.verdict])).toEqual([
			[2, 'medium', 'needs_validation'],
			[3, 'medium', 'confirmed'],
			[1, 'low', 'confirmed']
		]);
	});

	it('high-entropy literal under a sensitive name in client code', () => {
		const f = run({ 'src/lib/a.ts': "const apiSecret = 'Zx8kQ2mN7pL4vR9tW3yB6cF1hJ5';\n" });
		expect(f).toMatchObject([
			{ rule: 'secrets/client-exposure', severity: 'medium', verdict: 'needs_validation' }
		]);
	});

	it('redaction holds on long minified lines and for name-only secrets with punctuation', () => {
		const pad = 'a=1;'.repeat(120);
		const odd = 'Zx8.kQ2!mN7pL4vR9tW3yB6cF1hJ5q';
		const report = audit({
			path: makeProject({
				'src/lib/min.js': `${pad}eval(x);${'b=2;'.repeat(70)}const k='${FAKE.stripe}';${pad}\n`,
				'src/lib/b.ts': `const clientSecret = '${odd}';\n`
			})
		});
		const out = JSON.stringify(report);
		expect(out).not.toContain(FAKE.stripe);
		expect(out).not.toContain('FAKEfake0000');
		expect(out).not.toContain(odd);
		expect(out).not.toContain('kQ2!mN7p');
		expect(report.findings.map((f) => f.rule).sort()).toEqual([
			'js/eval',
			'secrets/client-exposure',
			'secrets/client-exposure'
		]);
	});

	it('eval( inside strings, comments or as a method is not flagged', () => {
		const f = run({
			'src/lib/a.ts':
				"const msg = 'eval() is bad';\nconst t = `new Function(x)`;\npage.evaluate(x);\nobj.eval(x);\n/* eval(y) */\n"
		});
		expect(f).toEqual([]);
	});

	it('Supabase anon JWT in client code is public by design', () => {
		const anon = FAKE.anonJwt;
		expect(run({ 'src/lib/supabase.ts': `export const anon = '${anon}';\n` })).toEqual([]);
	});

	it('.env.example values are needs_validation', () => {
		const f = run({ '.env.example': `PUBLIC_KEY=${FAKE.stripe}\n` });
		expect(f).toMatchObject([
			{ rule: 'env/public-secret', severity: 'high', verdict: 'needs_validation' }
		]);
	});

	it('{@html} literal forms and sanitizer calls are not flagged; templates with expressions are', () => {
		const f = run({
			'src/routes/+page.svelte':
				'<script>let a = $state("");</script>\n{@html `<i>x</i>`}\n{@html DOMPurify.sanitize(a)}\n{@html `<b>${a}</b>`}\n'
		});
		expect(f.map((x) => [x.rule, x.line])).toEqual([['svelte/html-non-literal', 4]]);
	});

	it('target=_blank: dynamic href is needs_validation; spread or dynamic rel is skipped', () => {
		const f = run({
			'src/routes/+page.svelte':
				'<script>let { href, rel, rest } = $props();</script>\n<a {href} target="_blank">a</a>\n<a href="//cdn.example" target="_blank" {rel}>b</a>\n<a href="https://x.example" target="_blank" {...rest}>c</a>\n<a href="mailto:a@b.c" target="_blank">d</a>\n'
		});
		expect(f.map((x) => [x.line, x.verdict])).toEqual([[2, 'needs_validation']]);
	});

	it('regex fallback for {@html} without the Svelte compiler', () => {
		const notes: string[] = [];
		const file = { abs: '/x.svelte', rel: 'x.svelte', text: '{@html "<b>ok</b>"}\n{@html body}\n' };
		const sink = svelteRules(file, { files: new Map(), notes, parseSvelte: null });
		expect(sink.findings.map((x) => [x.rule, x.line])).toEqual([['svelte/html-non-literal', 2]]);
	});

	it('a Svelte parse error falls back to the regex scan with a note', () => {
		const report = audit({
			path: makeProject({ 'src/routes/+page.svelte': '{#if x}\n{@html body}\n' })
		});
		expect(report.findings.map((x) => x.rule)).toEqual(['svelte/html-non-literal']);
		expect(report.notes.some((n) => n.includes('Svelte parse error'))).toBe(true);
	});
});

describe('dependency advisories (--deps)', () => {
	const npmJson = JSON.stringify({
		auditReportVersion: 2,
		vulnerabilities: {
			svelte: {
				name: 'svelte',
				severity: 'moderate',
				isDirect: true,
				via: [
					{
						title: 'XSS in SSR attribute',
						url: 'https://github.com/advisories/GHSA-fake-0001',
						severity: 'moderate'
					}
				],
				range: '<5.0.1',
				fixAvailable: { name: 'svelte', version: '5.0.1', isSemVerMajor: false }
			},
			'@sveltejs/kit': {
				name: '@sveltejs/kit',
				severity: 'critical',
				isDirect: true,
				via: [{ title: 'Fake kit advisory', url: 'https://github.com/advisories/GHSA-fake-0002' }],
				range: '<2.0.0',
				fixAvailable: true
			},
			cookie: {
				name: 'cookie',
				severity: 'low',
				isDirect: false,
				via: ['@sveltejs/kit'],
				range: '<0.7.0',
				fixAvailable: false
			}
		}
	});

	it('maps npm severities and verdicts (framework confirmed, others needs_validation)', () => {
		const pkg =
			'{\n  "devDependencies": {\n    "@sveltejs/kit": "1.0.0",\n    "svelte": "4.0.0"\n  }\n}\n';
		const f = parseNpmAudit(npmJson, pkg);
		expect(f.map((x) => [x.title.split(' ')[0], x.severity, x.verdict, x.line])).toEqual([
			['svelte', 'medium', 'confirmed', 4],
			['@sveltejs/kit', 'high', 'confirmed', 3],
			['cookie', 'low', 'needs_validation', 1]
		]);
		expect(f[0].evidence).toContain('GHSA-fake-0001');
		expect(f[0].fix).toContain('5.0.1');
		expect(f[2].title).toContain('(transitive)');
	});

	it('audit({ deps: true }) runs the injected npm audit and keeps the report schema-valid', () => {
		const dir = makeProject({
			'package.json': '{ "name": "x" }\n',
			'src/lib/a.ts': 'export {};\n'
		});
		const calls: [string, number][] = [];
		const report = audit({
			path: dir,
			deps: true,
			npmAudit: (cwd, timeout) => {
				calls.push([cwd, timeout]);
				return npmJson;
			}
		});
		expect(calls).toEqual([[dir, 60_000]]);
		expect(report.findings.filter((x) => x.rule === 'deps/advisory')).toHaveLength(3);
		expect(report.failed).toBe(true);
		expect(validateAuditReport(report).valid).toBe(true);
	});

	it('npm audit errors become notes, never throws', () => {
		const dir = makeProject({ 'package.json': '{}\n' });
		const failing = audit({
			path: dir,
			deps: true,
			npmAudit: () =>
				JSON.stringify({
					error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.' }
				})
		});
		expect(failing.notes.some((n) => n.includes('ENOLOCK'))).toBe(true);
		const timeout = audit({
			path: dir,
			deps: true,
			npmAudit: () => {
				throw new Error('spawnSync npm ETIMEDOUT');
			}
		});
		expect(timeout.notes.some((n) => n.includes('ETIMEDOUT'))).toBe(true);
	});
});

describe('parseAuditArgs', () => {
	it('accepts --flag value and --flag=value', () => {
		expect(
			parseAuditArgs([
				'--path',
				'app',
				'--json',
				'o.json',
				'--html=r.html',
				'--ci',
				'--min-severity=low',
				'--deps'
			])
		).toEqual({
			path: 'app',
			json: 'o.json',
			html: 'r.html',
			ci: true,
			minSeverity: 'low',
			deps: true,
			schema: false,
			help: false
		});
	});

	it('--json without a value means stdout', () => {
		expect(parseAuditArgs(['--json', '--ci']).json).toBe('-');
		expect(parseAuditArgs(['--json']).json).toBe('-');
	});
});
