import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	rmSync,
	readdirSync,
	statSync
} from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { AGENTS_MD_MARKER } from '../src/cli/agents.js';
import {
	normalizeSkillsDir,
	parseSkillFrontmatter,
	parseSkillsManifest,
	planSkillsInstall,
	serializeSkillsManifest,
	sha256Hex,
	skillsManifestPath,
	type SkillFile,
	type SkillsPlan
} from '../src/cli/skills-plan.js';
import { createHash } from 'crypto';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
import {
	installSkills,
	listSkills,
	parseSkillsFlags,
	runSkillsCommand
} from '../src/cli/skills.js';
import { init, parseInitArgs } from '../src/cli/init.js';
import { packagedSkillsDir, readSkillFiles } from '../src/utils/packaged-skills.js';
import { UI_INSPECT_SECTIONS, UI_VERIFY_CHECKS } from '../src/mcp/runtime/tools.js';
import { UI_SECURITY_CHECKS } from '../src/mcp/runtime/security-tool.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKILLS_DIR = join(ROOT, 'skills');

/** Tool names registered on the MCP server, parsed from the registerTool calls. */
function registeredToolNames(): Set<string> {
	const files = [join(ROOT, 'src/mcp/server.ts')];
	const runtimeDir = join(ROOT, 'src/mcp/runtime');
	for (const name of readdirSync(runtimeDir))
		if (name.endsWith('.ts')) files.push(join(runtimeDir, name));
	const names = new Set<string>();
	for (const file of files) {
		for (const match of readFileSync(file, 'utf-8').matchAll(/registerTool\(\s*'([a-z_]+)'/g))
			names.add(match[1]);
	}
	return names;
}

const TOOLS = registeredToolNames();
const files = readSkillFiles(SKILLS_DIR);
const read = (rel: string) => readFileSync(join(SKILLS_DIR, rel), 'utf-8');

describe('packaged skills content', () => {
	it('finds the registered tools (sanity)', () => {
		for (const tool of [
			'ui_snapshot',
			'ui_network',
			'ui_security_scan',
			'ui_leak_check',
			'watch_for_grab'
		]) {
			expect(TOOLS.has(tool)).toBe(true);
		}
	});

	it('ships svelte-grab and svelte-grab-audit with the expected files', () => {
		expect(files.map((f) => f.path)).toEqual([
			'svelte-grab/SKILL.md',
			'svelte-grab-audit/CHECKLIST.md',
			'svelte-grab-audit/REPORT-TEMPLATE.md',
			'svelte-grab-audit/SKILL.md',
			'svelte-grab-audit/finding-schema.json'
		]);
		expect(packagedSkillsDir()).toBe(join(ROOT, 'skills/'));
	});

	it.each(['svelte-grab', 'svelte-grab-audit'])(
		'%s/SKILL.md has valid frontmatter (name = folder, description)',
		(skill) => {
			const fm = parseSkillFrontmatter(read(`${skill}/SKILL.md`));
			expect(fm).not.toBeNull();
			expect(fm!.data.name).toBe(skill);
			expect(fm!.data.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
			expect(fm!.data.name.length).toBeLessThanOrEqual(64);
			expect(fm!.data.description.length).toBeGreaterThan(50);
			expect(fm!.data.description.length).toBeLessThanOrEqual(1024);
			expect(fm!.data.description).toMatch(/Use when/);
			expect(fm!.body.trim().length).toBeGreaterThan(0);
		}
	);

	it('the audit SKILL.md triggers on the audit questions and links its supporting files', () => {
		const skill = read('svelte-grab-audit/SKILL.md');
		const { description } = parseSkillFrontmatter(skill)!.data;
		for (const trigger of [
			'security audit',
			'performance audit',
			'what does screen X load',
			'credential',
			'why is this page slow',
			'memory leak'
		]) {
			expect(description).toContain(trigger);
		}
		for (const link of ['CHECKLIST.md', 'REPORT-TEMPLATE.md', 'finding-schema.json']) {
			expect(skill).toContain(`](${link})`);
		}
	});

	it('every ui_* / MCP tool name mentioned in the skills exists', () => {
		for (const file of files) {
			for (const match of file.content.matchAll(/\b((?:ui|get|watch|undo|list)_[a-z_]+)\b/g)) {
				expect(TOOLS.has(match[1]), `${file.path} mentions unknown tool ${match[1]}`).toBe(true);
			}
		}
	});

	describe('CHECKLIST.md', () => {
		const checklist = read('svelte-grab-audit/CHECKLIST.md');
		const rows = (heading: string) => {
			const start = checklist.indexOf(`## ${heading}`);
			expect(start).toBeGreaterThan(-1);
			const end = checklist.indexOf('\n## ', start + 3);
			const section = checklist.slice(start, end === -1 ? undefined : end);
			return section.split('\n').filter((line) => /^\| [SP]\d+ \|/.test(line));
		};

		it.each([
			['Security checklist', 'S', 14],
			['Performance checklist', 'P', 13]
		] as const)(
			'%s: every item maps to a tool or audit rule and has pass criteria',
			(heading, prefix, min) => {
				const items = rows(heading);
				expect(items.length).toBeGreaterThanOrEqual(min);
				items.forEach((row, i) => {
					const cells = row
						.split('|')
						.map((c) => c.trim())
						.filter(Boolean);
					expect(cells[0]).toBe(`${prefix}${i + 1}`);
					expect(cells).toHaveLength(4);
					const how = cells[2];
					expect(
						/`ui_[a-z_]+`/.test(how) || how.includes('npx svelte-grab audit'),
						`${cells[0]} has no tool`
					).toBe(true);
					expect(cells[3].length, `${cells[0]} has no pass criteria`).toBeGreaterThan(5);
				});
			}
		);

		it('bracketed checks exist on their tool', () => {
			const valid: Record<string, readonly string[]> = {
				ui_security_scan: UI_SECURITY_CHECKS,
				ui_verify: UI_VERIFY_CHECKS,
				ui_inspect: UI_INSPECT_SECTIONS
			};
			let seen = 0;
			for (const match of checklist.matchAll(/`(ui_[a-z_]+)` \[([a-z, ]+)\]/g)) {
				const allowed = valid[match[1]];
				expect(allowed, `no check list for ${match[1]}`).toBeDefined();
				for (const check of match[2].split(',').map((c) => c.trim())) {
					expect(allowed).toContain(check);
					seen++;
				}
			}
			expect(seen).toBeGreaterThan(10);
		});

		it('covers every ui_security_scan check', () => {
			for (const check of UI_SECURITY_CHECKS) expect(checklist).toContain(`[${check}]`);
		});
	});

	it('finding-schema.json matches the ui_security_scan finding shape', () => {
		const schema = JSON.parse(read('svelte-grab-audit/finding-schema.json'));
		const finding = schema.$defs.finding;
		expect(finding.required).toEqual(['id', 'severity', 'verdict', 'title', 'evidence', 'fix']);
		expect(finding.properties.severity.enum).toEqual(['high', 'medium', 'low', 'info']);
		expect(finding.properties.verdict.enum).toEqual(['confirmed', 'needs_validation']);
		expect(finding.properties.source.type).toBe('string');
	});

	it('the report template has the per-screen table, findings and methodology', () => {
		const template = read('svelte-grab-audit/REPORT-TEMPLATE.md');
		for (const heading of ['## Screens', '## Findings', '## Rejected candidates', '## Methodology'])
			expect(template).toContain(heading);
		for (const column of [
			'Requests',
			'Bytes',
			'3rd-party',
			'Duplicates',
			'Failed',
			'credential',
			'Hot components',
			'Memory'
		]) {
			expect(template).toContain(column);
		}
	});
});

// ============================================================
// Planner (pure)
// ============================================================

const SAMPLE: SkillFile[] = [
	{ skill: 'a', path: 'a/SKILL.md', content: 'A1' },
	{ skill: 'a', path: 'a/extra.md', content: 'A2' },
	{ skill: 'b', path: 'b/SKILL.md', content: 'B1' }
];

const MANIFEST = '.claude/skills/.svelte-grab-skills.json';

/** In-memory project for the planner: `apply` writes and deletes like the CLI does. */
function memoryProject(initial: Record<string, string> = {}) {
	const fs: Record<string, string> = { ...initial };
	const read = (p: string) => fs[p] ?? null;
	const apply = (plan: SkillsPlan) => {
		for (const w of plan.writes) fs[w.path] = w.content;
		for (const p of plan.removes) delete fs[p];
	};
	return { fs, read, apply };
}

describe('planSkillsInstall', () => {
	it('creates everything in a fresh project, under .claude/skills by default', () => {
		const plan = planSkillsInstall(SAMPLE, () => null, { version: '2.0.0' });
		expect(plan.skills).toEqual(['a', 'b']);
		expect(plan.writes.slice(0, 3)).toEqual([
			{ path: '.claude/skills/a/SKILL.md', content: 'A1' },
			{ path: '.claude/skills/a/extra.md', content: 'A2' },
			{ path: '.claude/skills/b/SKILL.md', content: 'B1' }
		]);
		expect(plan.files.every((f) => f.action === 'create')).toBe(true);
		expect(plan.manifestPath).toBe(MANIFEST);
		expect(plan.writes[3].path).toBe(MANIFEST);
		expect(JSON.parse(plan.writes[3].content)).toEqual({
			version: '2.0.0',
			files: { 'a/SKILL.md': sha256('A1'), 'a/extra.md': sha256('A2'), 'b/SKILL.md': sha256('B1') }
		});
		expect(plan.writes).toHaveLength(4);
		expect(plan.removes).toEqual([]);
	});

	it('is idempotent and never overwrites a modified file (writes <file>.new once)', () => {
		const fs: Record<string, string> = {
			'.agents/skills/a/SKILL.md': 'A1',
			'.agents/skills/a/extra.md': 'mine'
		};
		const plan = planSkillsInstall(SAMPLE, (p) => fs[p] ?? null, {
			skillsDir: './.agents/skills/'
		});
		expect(plan.files.map((f) => f.action)).toEqual(['unchanged', 'conflict', 'create']);
		expect(plan.writes.slice(0, 2)).toEqual([
			{ path: '.agents/skills/a/extra.md.new', content: 'A2' },
			{ path: '.agents/skills/b/SKILL.md', content: 'B1' }
		]);
		// No manifest + differs: no install record for the edited file.
		expect(plan.writes[2].path).toBe('.agents/skills/.svelte-grab-skills.json');
		expect(Object.keys(plan.manifest.files)).toEqual(['a/SKILL.md', 'b/SKILL.md']);
		for (const w of plan.writes) fs[w.path] = w.content;
		const again = planSkillsInstall(SAMPLE, (p) => fs[p] ?? null, { skillsDir: '.agents/skills' });
		expect(again.writes).toEqual([]);
		expect(again.files[1]).toMatchObject({ action: 'conflict', writePath: null });
	});

	it('overwrites with force', () => {
		const plan = planSkillsInstall(SAMPLE, (p) => (p.endsWith('extra.md') ? 'mine' : null), {
			force: true
		});
		expect(plan.files[1]).toMatchObject({
			action: 'overwrite',
			writePath: '.claude/skills/a/extra.md'
		});
		expect(plan.writes).toContainEqual({ path: '.claude/skills/a/extra.md', content: 'A2' });
	});

	it('normalizes the skills dir', () => {
		expect(normalizeSkillsDir(undefined)).toBe('.claude/skills');
		expect(normalizeSkillsDir('./.agents/skills/')).toBe('.agents/skills');
		expect(normalizeSkillsDir('a\\b')).toBe('a/b');
		expect(normalizeSkillsDir('.')).toBe('.claude/skills');
	});
});

describe('planSkillsInstall: upgrades with the install manifest', () => {
	const V1: SkillFile[] = [
		{ skill: 'svelte-grab', path: 'svelte-grab/SKILL.md', content: 'core v1' },
		{ skill: 'svelte-grab', path: 'svelte-grab/old.md', content: 'old v1' },
		{ skill: 'svelte-grab-x', path: 'svelte-grab-x/SKILL.md', content: 'x v1' }
	];
	const V2: SkillFile[] = [
		{ skill: 'svelte-grab', path: 'svelte-grab/SKILL.md', content: 'core v2' },
		{ skill: 'svelte-grab', path: 'svelte-grab/new.md', content: 'new v2' }
	];
	const D = '.claude/skills';

	/** Project with V1 installed (manifest included). */
	function installedV1() {
		const project = memoryProject();
		project.apply(planSkillsInstall(V1, project.read, { version: '1.0.0' }));
		return project;
	}

	it('updates unedited files in place, creates new ones and removes unedited files no longer shipped', () => {
		const project = installedV1();
		const plan = planSkillsInstall(V2, project.read, { version: '2.0.0' });
		expect(plan.files.map((f) => [f.path, f.action, f.writePath])).toEqual([
			[`${D}/svelte-grab/SKILL.md`, 'updated', `${D}/svelte-grab/SKILL.md`],
			[`${D}/svelte-grab/new.md`, 'create', `${D}/svelte-grab/new.md`],
			[`${D}/svelte-grab/old.md`, 'removed', null],
			[`${D}/svelte-grab-x/SKILL.md`, 'removed', null]
		]);
		expect(plan.removes).toEqual([`${D}/svelte-grab/old.md`, `${D}/svelte-grab-x/SKILL.md`]);
		expect(plan.manifest).toEqual({
			version: '2.0.0',
			files: { 'svelte-grab/SKILL.md': sha256('core v2'), 'svelte-grab/new.md': sha256('new v2') }
		});
		project.apply(plan);
		expect(project.fs).toEqual({
			[`${D}/svelte-grab/SKILL.md`]: 'core v2',
			[`${D}/svelte-grab/new.md`]: 'new v2',
			[MANIFEST]: serializeSkillsManifest(plan.manifest)
		});
		// Idempotent afterwards.
		const again = planSkillsInstall(V2, project.read, { version: '2.0.0' });
		expect(again.writes).toEqual([]);
		expect(again.removes).toEqual([]);
		expect(again.files.every((f) => f.action === 'unchanged')).toBe(true);
	});

	it('edited since the last install: conflict (<file>.new), the manifest keeps the old hash, rerun is a no-op', () => {
		const project = installedV1();
		project.fs[`${D}/svelte-grab/SKILL.md`] = 'core v1 + my notes';
		const plan = planSkillsInstall(V2, project.read, { version: '2.0.0' });
		expect(plan.files[0]).toEqual({
			path: `${D}/svelte-grab/SKILL.md`,
			action: 'conflict',
			writePath: `${D}/svelte-grab/SKILL.md.new`
		});
		expect(plan.writes).toContainEqual({
			path: `${D}/svelte-grab/SKILL.md.new`,
			content: 'core v2'
		});
		expect(plan.writes.some((w) => w.path === `${D}/svelte-grab/SKILL.md`)).toBe(false);
		expect(plan.manifest.files['svelte-grab/SKILL.md']).toBe(sha256('core v1'));
		project.apply(plan);
		expect(project.fs[`${D}/svelte-grab/SKILL.md`]).toBe('core v1 + my notes');

		const again = planSkillsInstall(V2, project.read, { version: '2.0.0' });
		expect(again.writes).toEqual([]);
		expect(again.files[0]).toMatchObject({ action: 'conflict', writePath: null });

		// Accepting the new version (copying .new over) makes it unchanged and recorded.
		project.fs[`${D}/svelte-grab/SKILL.md`] = 'core v2';
		const merged = planSkillsInstall(V2, project.read, { version: '2.0.0' });
		expect(merged.files[0].action).toBe('unchanged');
		expect(merged.manifest.files['svelte-grab/SKILL.md']).toBe(sha256('core v2'));
	});

	it('force overwrites an edited file and records the shipped hash', () => {
		const project = installedV1();
		project.fs[`${D}/svelte-grab/SKILL.md`] = 'mine';
		const plan = planSkillsInstall(V2, project.read, { version: '2.0.0', force: true });
		expect(plan.files[0]).toMatchObject({
			action: 'overwrite',
			writePath: `${D}/svelte-grab/SKILL.md`
		});
		expect(plan.writes).toContainEqual({ path: `${D}/svelte-grab/SKILL.md`, content: 'core v2' });
		expect(plan.manifest.files['svelte-grab/SKILL.md']).toBe(sha256('core v2'));
		// An unedited file is still reported as `updated` under force.
		const clean = installedV1();
		expect(planSkillsInstall(V2, clean.read, { force: true }).files[0].action).toBe('updated');
	});

	it('no longer shipped but edited: orphaned, left in place and dropped from the manifest (even with force)', () => {
		const project = installedV1();
		project.fs[`${D}/svelte-grab/old.md`] = 'old v1, edited';
		for (const force of [false, true]) {
			const plan = planSkillsInstall(V2, project.read, { version: '2.0.0', force });
			expect(plan.files.find((f) => f.path === `${D}/svelte-grab/old.md`)?.action).toBe('orphaned');
			expect(plan.removes).not.toContain(`${D}/svelte-grab/old.md`);
			expect(plan.manifest.files['svelte-grab/old.md']).toBeUndefined();
		}
		project.apply(planSkillsInstall(V2, project.read, { version: '2.0.0' }));
		expect(project.fs[`${D}/svelte-grab/old.md`]).toBe('old v1, edited');
		// Reported once: no longer tracked afterwards.
		const again = planSkillsInstall(V2, project.read, { version: '2.0.0' });
		expect(again.files.some((f) => f.path.endsWith('old.md'))).toBe(false);
		expect(again.writes).toEqual([]);
	});

	it('removeObsolete: false keeps unedited obsolete files (obsolete) and their manifest entries', () => {
		const project = installedV1();
		const plan = planSkillsInstall(V2, project.read, { version: '2.0.0', removeObsolete: false });
		expect(plan.files.filter((f) => f.action === 'obsolete').map((f) => f.path)).toEqual([
			`${D}/svelte-grab/old.md`,
			`${D}/svelte-grab-x/SKILL.md`
		]);
		expect(plan.removes).toEqual([]);
		expect(plan.manifest.files['svelte-grab/old.md']).toBe(sha256('old v1'));
		project.apply(plan);
		expect(
			planSkillsInstall(V2, project.read, { version: '2.0.0', removeObsolete: false }).writes
		).toEqual([]);
		// A later run that can delete removes them.
		expect(planSkillsInstall(V2, project.read, { version: '2.0.0' }).removes).toHaveLength(2);
	});

	it('a shipped file the user deleted is created again', () => {
		const project = installedV1();
		delete project.fs[`${D}/svelte-grab/SKILL.md`];
		expect(planSkillsInstall(V1, project.read, { version: '1.0.0' }).files[0].action).toBe(
			'create'
		);
	});

	it('a manifest entry whose file is gone is dropped silently', () => {
		const project = installedV1();
		delete project.fs[`${D}/svelte-grab/old.md`];
		const plan = planSkillsInstall(V2, project.read, { version: '2.0.0' });
		expect(plan.files.some((f) => f.path.endsWith('old.md'))).toBe(false);
		expect(plan.manifest.files['svelte-grab/old.md']).toBeUndefined();
	});

	it('a version bump with identical files only rewrites the manifest', () => {
		const project = installedV1();
		const plan = planSkillsInstall(V1, project.read, { version: '1.0.1' });
		expect(plan.writes.map((w) => w.path)).toEqual([MANIFEST]);
		expect(JSON.parse(plan.writes[0].content).version).toBe('1.0.1');
	});

	it('never reads or removes manifest paths outside the svelte-grab skill folders', () => {
		const hash = sha256('x');
		const outside = [
			'../../src/app.ts',
			'/etc/passwd',
			'other/notes.md',
			'svelte-grab/../../x',
			'svelte-grab\\x',
			'svelte-grab'
		];
		const project = memoryProject({
			[MANIFEST]: JSON.stringify({
				version: '1.0.0',
				files: Object.fromEntries(outside.map((p) => [p, hash]))
			}),
			// Each one "exists" with the recorded content, so only the path guard keeps it.
			...Object.fromEntries(outside.map((p) => [`${D}/${p}`, 'x']))
		});
		const reads: string[] = [];
		const plan = planSkillsInstall(V2, (p) => {
			reads.push(p);
			return project.read(p);
		});
		expect(plan.removes).toEqual([]);
		expect(plan.files.some((f) => f.action === 'orphaned' || f.action === 'removed')).toBe(false);
		expect(plan.files.map((f) => f.action)).toEqual(['create', 'create']);
		for (const p of outside) expect(reads).not.toContain(`${D}/${p}`);
		expect(Object.keys(plan.manifest.files)).toEqual([
			'svelte-grab/SKILL.md',
			'svelte-grab/new.md'
		]);
	});

	it('a malformed manifest is treated as missing (content compare only) and rewritten', () => {
		for (const raw of ['{ nope', '[]', '{"files": 3}', '']) {
			const project = memoryProject({ [MANIFEST]: raw, [`${D}/svelte-grab/SKILL.md`]: 'core v1' });
			const plan = planSkillsInstall(V2, project.read, { version: '2.0.0' });
			expect(plan.files[0].action).toBe('conflict');
			expect(plan.writes.at(-1)?.path).toBe(MANIFEST);
		}
		expect(
			parseSkillsManifest(
				'{"version": 1, "files": {"a/b.md": "zz", "a/c.md": "' + sha256('c') + '"}}'
			)
		).toEqual({
			version: 'unknown',
			files: { 'a/c.md': sha256('c') }
		});
		expect(skillsManifestPath('./.agents/skills/')).toBe('.agents/skills/.svelte-grab-skills.json');
	});
});

describe('sha256Hex', () => {
	it('matches node:crypto (ASCII, UTF-8, block boundaries, large input)', () => {
		const inputs = [
			'',
			'abc',
			'héllo wörld ✓ 🚀',
			'a'.repeat(55),
			'a'.repeat(56),
			'a'.repeat(63),
			'a'.repeat(64),
			'a'.repeat(65)
		];
		inputs.push(read('svelte-grab-audit/CHECKLIST.md'), 'x'.repeat(200_000));
		for (const input of inputs) expect(sha256Hex(input)).toBe(sha256(input));
		expect(sha256Hex('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});
});

// ============================================================
// File system: installSkills / init / CLI
// ============================================================

let dir: string;

function write(rel: string, content: string) {
	const path = join(dir, rel);
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, content, 'utf-8');
}

function tree(): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			if (statSync(p).isDirectory()) walk(p);
			else out[relative(dir, p)] = readFileSync(p, 'utf-8');
		}
	};
	walk(dir);
	return out;
}

function kitProject() {
	write(
		'package.json',
		JSON.stringify({ devDependencies: { '@sveltejs/kit': '^2.20.0', svelte: '^5.40.0' } })
	);
	write(
		'vite.config.ts',
		"import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit()] };\n"
	);
}

const EXPECTED = files.map((f) => `.claude/skills/${f.path}`);

describe('installSkills (file system)', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'svelte-grab-skills-'));
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it('init copies the skills into .claude/skills and .agents/skills by default', () => {
		kitProject();
		const result = init(dir);
		expect(result.ok).toBe(true);
		expect(result.skills?.targets.map((t) => t.skillsDir)).toEqual([
			'.claude/skills',
			'.agents/skills'
		]);
		expect(result.skills?.targets[0].written).toEqual([...EXPECTED, MANIFEST]);
		expect(result.skills?.targets[1].written).toEqual([
			...files.map((f) => `.agents/skills/${f.path}`),
			'.agents/skills/.svelte-grab-skills.json'
		]);
		expect(readFileSync(join(dir, '.agents/skills/.svelte-grab-skills.json'), 'utf-8')).toBe(
			readFileSync(join(dir, MANIFEST), 'utf-8')
		);
		for (const rel of EXPECTED) expect(result.written).toContain(rel);
		for (const f of files)
			expect(readFileSync(join(dir, '.claude/skills', f.path), 'utf-8')).toBe(f.content);
		const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf-8'));
		expect(manifest.version).toBe(
			JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version
		);
		expect(manifest.files).toEqual(
			Object.fromEntries(files.map((f) => [f.path, sha256(f.content)]))
		);
		// Codex reads AGENTS.md: created with the svelte-grab section.
		expect(result.agentsMd).toBe('created');
		expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toContain(AGENTS_MD_MARKER);
	});

	it('init --agents claude: .claude/skills only, no AGENTS.md created', () => {
		kitProject();
		const result = init(dir, parseInitArgs(['--agents', 'claude']));
		expect(result.skills?.targets.map((t) => t.skillsDir)).toEqual(['.claude/skills']);
		expect(result.agentsMd).toBe('absent');
		expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
		expect(existsSync(join(dir, '.agents'))).toBe(false);
	});

	it('is idempotent: a second run writes nothing', () => {
		kitProject();
		init(dir);
		const before = tree();
		const second = installSkills(dir);
		expect(second.written).toEqual([]);
		expect(second.files.every((f) => f.action === 'unchanged')).toBe(true);
		expect(tree()).toEqual(before);
	});

	it('keeps a user-modified file and writes <file>.new next to it (once), unless forced', () => {
		installSkills(dir);
		const rel = '.claude/skills/svelte-grab-audit/CHECKLIST.md';
		write(rel, '# my checklist\n');
		const second = installSkills(dir);
		expect(second.written).toEqual([`${rel}.new`]);
		expect(readFileSync(join(dir, rel), 'utf-8')).toBe('# my checklist\n');
		expect(readFileSync(join(dir, `${rel}.new`), 'utf-8')).toBe(
			read('svelte-grab-audit/CHECKLIST.md')
		);
		const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
		expect(logged).toContain(`wrote ${rel}.new`);
		expect(logged).toContain('--force-skills');

		expect(installSkills(dir).written).toEqual([]);

		const forced = installSkills(dir, { force: true });
		expect(forced.written).toEqual([rel]);
		expect(readFileSync(join(dir, rel), 'utf-8')).toBe(read('svelte-grab-audit/CHECKLIST.md'));
	});

	describe('upgrades (install manifest)', () => {
		const V1: SkillFile[] = [
			{ skill: 'svelte-grab', path: 'svelte-grab/SKILL.md', content: 'core v1\n' },
			{ skill: 'svelte-grab', path: 'svelte-grab/notes.md', content: 'notes v1\n' },
			{ skill: 'svelte-grab-old', path: 'svelte-grab-old/SKILL.md', content: 'old v1\n' }
		];
		const V2: SkillFile[] = [
			{ skill: 'svelte-grab', path: 'svelte-grab/SKILL.md', content: 'core v2\n' },
			{ skill: 'svelte-grab', path: 'svelte-grab/notes.md', content: 'notes v2\n' }
		];
		const core = '.claude/skills/svelte-grab/SKILL.md';
		const notes = '.claude/skills/svelte-grab/notes.md';
		const old = '.claude/skills/svelte-grab-old/SKILL.md';

		it('updates unedited files in place, keeps edited ones (<file>.new), removes unedited obsolete ones', () => {
			installSkills(dir, { files: V1, version: '1.0.0' });
			write(notes, 'notes v1 + mine\n');
			const result = installSkills(dir, { files: V2, version: '2.0.0' });
			expect(result.files.map((f) => [f.path, f.action])).toEqual([
				[core, 'updated'],
				[notes, 'conflict'],
				[old, 'removed']
			]);
			expect(result.written).toEqual([core, `${notes}.new`, MANIFEST]);
			expect(result.removed).toEqual([old]);
			expect(readFileSync(join(dir, core), 'utf-8')).toBe('core v2\n');
			expect(readFileSync(join(dir, notes), 'utf-8')).toBe('notes v1 + mine\n');
			expect(readFileSync(join(dir, `${notes}.new`), 'utf-8')).toBe('notes v2\n');
			// The emptied skill folder goes too; the skills dir stays.
			expect(existsSync(join(dir, '.claude/skills/svelte-grab-old'))).toBe(false);
			expect(JSON.parse(readFileSync(join(dir, MANIFEST), 'utf-8'))).toEqual({
				version: '2.0.0',
				files: {
					'svelte-grab/SKILL.md': sha256('core v2\n'),
					'svelte-grab/notes.md': sha256('notes v1\n')
				}
			});
			const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
			expect(logged).toContain(`Updated ${core} (not edited since the last install)`);
			expect(logged).toContain(`Removed ${old} (no longer shipped, not edited)`);

			// Idempotent.
			const before = tree();
			const again = installSkills(dir, { files: V2, version: '2.0.0' });
			expect(again.written).toEqual([]);
			expect(again.removed).toEqual([]);
			expect(tree()).toEqual(before);
		});

		it('keeps an edited file that is no longer shipped and says so', () => {
			installSkills(dir, { files: V1, version: '1.0.0' });
			write(old, 'old v1, my edits\n');
			const result = installSkills(dir, { files: V2, version: '2.0.0' });
			expect(result.files.find((f) => f.path === old)?.action).toBe('orphaned');
			expect(result.removed).toEqual([]);
			expect(readFileSync(join(dir, old), 'utf-8')).toBe('old v1, my edits\n');
			const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
			expect(logged).toContain(`${old} is no longer shipped but you edited it: left in place`);
		});

		it('force overwrites edited files and records them in the manifest', () => {
			installSkills(dir, { files: V1, version: '1.0.0' });
			write(notes, 'mine\n');
			const result = installSkills(dir, { files: V2, version: '2.0.0', force: true });
			expect(result.files.map((f) => f.action)).toEqual(['updated', 'overwrite', 'removed']);
			expect(readFileSync(join(dir, notes), 'utf-8')).toBe('notes v2\n');
			expect(
				JSON.parse(readFileSync(join(dir, MANIFEST), 'utf-8')).files['svelte-grab/notes.md']
			).toBe(sha256('notes v2\n'));
		});

		it('dry run reports the update and removal but writes and deletes nothing', () => {
			installSkills(dir, { files: V1, version: '1.0.0' });
			const before = tree();
			const result = installSkills(dir, { files: V2, version: '2.0.0', dryRun: true });
			expect(result.files.map((f) => f.action)).toEqual(['updated', 'updated', 'removed']);
			expect(result.written).toEqual([]);
			expect(result.removed).toEqual([]);
			expect(tree()).toEqual(before);
			const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
			expect(logged).toContain(`Would update ${core}`);
			expect(logged).toContain(`Would remove ${old}`);
		});

		it('an install from before manifests: identical files are adopted, differing ones conflict', () => {
			write(core, 'core v1\n');
			write(notes, 'whatever\n');
			const result = installSkills(dir, { files: V2, version: '2.0.0' });
			expect(result.files.map((f) => f.action)).toEqual(['conflict', 'conflict']);
			write(core, 'core v2\n');
			const again = installSkills(dir, { files: V2, version: '2.0.0' });
			expect(again.files.map((f) => f.action)).toEqual(['unchanged', 'conflict']);
			expect(Object.keys(JSON.parse(readFileSync(join(dir, MANIFEST), 'utf-8')).files)).toEqual([
				'svelte-grab/SKILL.md'
			]);
		});
	});

	it('--no-skills skips them', () => {
		kitProject();
		const result = init(dir, parseInitArgs(['--no-skills']));
		expect(result.skills).toBeNull();
		expect(existsSync(join(dir, '.claude'))).toBe(false);
	});

	it('--skills-dir puts them in that one directory instead', () => {
		kitProject();
		const result = init(dir, parseInitArgs(['--skills-dir', '.agents/skills']));
		expect(result.skills?.targets).toHaveLength(1);
		expect(result.skills?.written).toEqual([
			...files.map((f) => `.agents/skills/${f.path}`),
			'.agents/skills/.svelte-grab-skills.json'
		]);
		expect(existsSync(join(dir, '.agents/skills/svelte-grab/SKILL.md'))).toBe(true);
		expect(existsSync(join(dir, '.claude'))).toBe(false);
	});

	it('appends the AGENTS.md section once when AGENTS.md exists', () => {
		kitProject();
		write('AGENTS.md', '# Project rules\n');
		const first = init(dir);
		expect(first.agentsMd).toBe('appended');
		expect(first.written).toContain('AGENTS.md');
		const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf-8');
		expect(agents.startsWith('# Project rules\n')).toBe(true);
		expect(agents.split(AGENTS_MD_MARKER)).toHaveLength(2);
		expect(agents).toContain('.agents/skills/svelte-grab-audit/SKILL.md');
		expect(agents).toContain('`.claude/skills/`');

		const second = init(dir);
		expect(second.agentsMd).toBe('already-present');
		expect(second.written).toEqual([]);
		expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toBe(agents);
	});

	it('dry run writes nothing (skills nor AGENTS.md)', () => {
		kitProject();
		write('AGENTS.md', '# Project rules\n');
		const before = tree();
		const result = init(dir, { dryRun: true });
		expect(result.written).toEqual([]);
		for (const target of result.skills?.targets ?? [])
			expect(target.files.every((f) => f.action === 'create')).toBe(true);
		expect(result.agentsMd).toBe('appended');
		expect(tree()).toEqual(before);
		const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
		expect(logged).toContain('Would add .claude/skills/svelte-grab/SKILL.md');
	});

	it('parses the skill flags', () => {
		expect(parseSkillsFlags([])).toEqual({
			skills: true,
			skillsDir: undefined,
			forceSkills: false
		});
		expect(
			parseSkillsFlags(['--no-skills', '--skills-dir=.agents/skills/', '--force-skills'])
		).toEqual({
			skills: false,
			skillsDir: '.agents/skills',
			forceSkills: true
		});
	});

	describe('svelte-grab skills <sub>', () => {
		it('install (with --skills-dir and --dry-run)', () => {
			expect(
				runSkillsCommand(['skills', 'install', '--skills-dir', 'x/skills', '--dry-run'], dir)
			).toBe(0);
			expect(tree()).toEqual({});
			expect(runSkillsCommand(['skills', 'install', '--skills-dir', 'x/skills'], dir)).toBe(0);
			expect(Object.keys(tree()).sort()).toEqual(
				[
					...files.map((f) => `x/skills/${f.path}`),
					'x/skills/.svelte-grab-skills.json',
					'AGENTS.md'
				].sort()
			);
			expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toContain(
				'x/skills/svelte-grab/SKILL.md'
			);
		});

		it('install: one target per agent (--agents, --no-codex, --no-agents-md), idempotent', () => {
			expect(runSkillsCommand(['skills', 'install'], dir)).toBe(0);
			const both = tree();
			expect(
				Object.keys(both)
					.filter((p) => p.endsWith('SKILL.md'))
					.sort()
			).toEqual(
				[
					'.agents/skills/svelte-grab-audit/SKILL.md',
					'.agents/skills/svelte-grab/SKILL.md',
					'.claude/skills/svelte-grab-audit/SKILL.md',
					'.claude/skills/svelte-grab/SKILL.md'
				].sort()
			);
			expect(both['AGENTS.md']).toContain(AGENTS_MD_MARKER);
			expect(runSkillsCommand(['skills', 'install'], dir)).toBe(0);
			expect(tree()).toEqual(both);

			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dir);
			expect(runSkillsCommand(['skills', 'install', '--no-codex'], dir)).toBe(0);
			expect(Object.keys(tree()).some((p) => p.startsWith('.agents/') || p === 'AGENTS.md')).toBe(
				false
			);

			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dir);
			expect(runSkillsCommand(['skills', 'install', '--agents=codex', '--no-agents-md'], dir)).toBe(
				0
			);
			expect(Object.keys(tree()).some((p) => p.startsWith('.claude/') || p === 'AGENTS.md')).toBe(
				false
			);
			expect(existsSync(join(dir, '.agents/skills/svelte-grab/SKILL.md'))).toBe(true);
		});

		it('install rejects unknown agents and an empty selection', () => {
			expect(runSkillsCommand(['skills', 'install', '--agents', 'cursor'], dir)).toBe(1);
			expect(runSkillsCommand(['skills', 'install', '--agents', 'codex', '--no-codex'], dir)).toBe(
				1
			);
			expect(tree()).toEqual({});
		});

		it('list and path', () => {
			expect(runSkillsCommand(['skills', 'list'], dir)).toBe(0);
			expect(runSkillsCommand(['skills', 'path'], dir)).toBe(0);
			const logged = logSpy.mock.calls.map((c) => c.join(' '));
			expect(logged).toContain('svelte-grab (1 file)');
			expect(logged).toContain('svelte-grab-audit (4 files)');
			expect(logged).toContain(join(ROOT, 'skills/'));
			expect(listSkills(files).filter((l) => !l.startsWith('  '))).toEqual([
				'svelte-grab (1 file)',
				'svelte-grab-audit (4 files)'
			]);
		});

		it('list shows each file: new / up to date / will update / edited by you', () => {
			const lines = () => logSpy.mock.calls.map((c) => c.join(' '));
			expect(runSkillsCommand(['skills', 'list'], dir)).toBe(0);
			expect(lines()).toContain('  - SKILL.md: new');
			expect(lines()).toContain('  - CHECKLIST.md: new');

			installSkills(dir);
			// Simulate an older unedited version of SKILL.md (manifest records what is on disk).
			const skill = '.claude/skills/svelte-grab/SKILL.md';
			write(skill, 'older packaged version\n');
			const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf-8'));
			manifest.files['svelte-grab/SKILL.md'] = sha256('older packaged version\n');
			write(MANIFEST, JSON.stringify(manifest));
			write('.claude/skills/svelte-grab-audit/CHECKLIST.md', 'my checklist\n');

			logSpy.mockClear();
			expect(runSkillsCommand(['skills', 'list'], dir)).toBe(0);
			const listed = lines();
			expect(listed[0]).toMatch(
				/^\[svelte-grab\] Packaged skills \(svelte-grab \S+\) vs \.claude\/skills\/:$/
			);
			const core = listed.indexOf('svelte-grab (1 file)');
			expect(listed.slice(core + 2, core + 3)).toEqual(['  - SKILL.md: will update']);
			expect(listed).toContain('  - CHECKLIST.md: edited by you');
			expect(listed).toContain('  - REPORT-TEMPLATE.md: up to date');
			// list never writes.
			expect(readFileSync(join(dir, skill), 'utf-8')).toBe('older packaged version\n');

			// --skills-dir is honoured.
			logSpy.mockClear();
			runSkillsCommand(['skills', 'list', '--skills-dir', '.agents/skills'], dir);
			expect(lines()).toContain('  - CHECKLIST.md: new');
		});

		it('listSkills groups files no longer shipped at the end', () => {
			const plan = planSkillsInstall(files, () => null);
			plan.files.push({
				path: '.claude/skills/svelte-grab-gone/SKILL.md',
				action: 'orphaned',
				writePath: null
			});
			const out = listSkills(files, plan);
			expect(out.slice(-2)).toEqual([
				'No longer shipped',
				'  - svelte-grab-gone/SKILL.md: no longer shipped, edited by you'
			]);
		});

		it('unknown subcommand fails', () => {
			expect(runSkillsCommand(['skills', 'nope'], dir)).toBe(1);
		});
	});
});
