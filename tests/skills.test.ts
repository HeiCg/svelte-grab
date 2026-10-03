import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import {
	AGENTS_MD_MARKER,
	appendAgentsMdPointer,
	normalizeSkillsDir,
	parseSkillFrontmatter,
	planSkillsInstall,
	type SkillFile
} from '../src/cli/skills-plan.js';
import { installSkills, listSkills, parseSkillsFlags, runSkillsCommand } from '../src/cli/skills.js';
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
	for (const name of readdirSync(runtimeDir)) if (name.endsWith('.ts')) files.push(join(runtimeDir, name));
	const names = new Set<string>();
	for (const file of files) {
		for (const match of readFileSync(file, 'utf-8').matchAll(/registerTool\(\s*'([a-z_]+)'/g)) names.add(match[1]);
	}
	return names;
}

const TOOLS = registeredToolNames();
const files = readSkillFiles(SKILLS_DIR);
const read = (rel: string) => readFileSync(join(SKILLS_DIR, rel), 'utf-8');

describe('packaged skills content', () => {
	it('finds the registered tools (sanity)', () => {
		for (const tool of ['ui_snapshot', 'ui_network', 'ui_security_scan', 'ui_leak_check', 'watch_for_grab']) {
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

	it.each(['svelte-grab', 'svelte-grab-audit'])('%s/SKILL.md has valid frontmatter (name = folder, description)', (skill) => {
		const fm = parseSkillFrontmatter(read(`${skill}/SKILL.md`));
		expect(fm).not.toBeNull();
		expect(fm!.data.name).toBe(skill);
		expect(fm!.data.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
		expect(fm!.data.name.length).toBeLessThanOrEqual(64);
		expect(fm!.data.description.length).toBeGreaterThan(50);
		expect(fm!.data.description.length).toBeLessThanOrEqual(1024);
		expect(fm!.data.description).toMatch(/Use when/);
		expect(fm!.body.trim().length).toBeGreaterThan(0);
	});

	it('the audit SKILL.md triggers on the audit questions and links its supporting files', () => {
		const skill = read('svelte-grab-audit/SKILL.md');
		const { description } = parseSkillFrontmatter(skill)!.data;
		for (const trigger of ['security audit', 'performance audit', 'what does screen X load', 'credential', 'why is this page slow', 'memory leak']) {
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
		] as const)('%s: every item maps to a tool or audit rule and has pass criteria', (heading, prefix, min) => {
			const items = rows(heading);
			expect(items.length).toBeGreaterThanOrEqual(min);
			items.forEach((row, i) => {
				const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
				expect(cells[0]).toBe(`${prefix}${i + 1}`);
				expect(cells).toHaveLength(4);
				const how = cells[2];
				expect(/`ui_[a-z_]+`/.test(how) || how.includes('npx svelte-grab audit'), `${cells[0]} has no tool`).toBe(true);
				expect(cells[3].length, `${cells[0]} has no pass criteria`).toBeGreaterThan(5);
			});
		});

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
		for (const heading of ['## Screens', '## Findings', '## Rejected candidates', '## Methodology']) expect(template).toContain(heading);
		for (const column of ['Requests', 'Bytes', '3rd-party', 'Duplicates', 'Failed', 'credential', 'Hot components', 'Memory']) {
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

describe('planSkillsInstall', () => {
	it('creates everything in a fresh project, under .claude/skills by default', () => {
		const plan = planSkillsInstall(SAMPLE, () => null);
		expect(plan.skills).toEqual(['a', 'b']);
		expect(plan.writes).toEqual([
			{ path: '.claude/skills/a/SKILL.md', content: 'A1' },
			{ path: '.claude/skills/a/extra.md', content: 'A2' },
			{ path: '.claude/skills/b/SKILL.md', content: 'B1' }
		]);
		expect(plan.files.every((f) => f.action === 'create')).toBe(true);
	});

	it('is idempotent and never overwrites a modified file (writes <file>.new once)', () => {
		const fs: Record<string, string> = { '.agents/skills/a/SKILL.md': 'A1', '.agents/skills/a/extra.md': 'mine' };
		const plan = planSkillsInstall(SAMPLE, (p) => fs[p] ?? null, { skillsDir: './.agents/skills/' });
		expect(plan.files.map((f) => f.action)).toEqual(['unchanged', 'conflict', 'create']);
		expect(plan.writes).toEqual([
			{ path: '.agents/skills/a/extra.md.new', content: 'A2' },
			{ path: '.agents/skills/b/SKILL.md', content: 'B1' }
		]);
		for (const w of plan.writes) fs[w.path] = w.content;
		const again = planSkillsInstall(SAMPLE, (p) => fs[p] ?? null, { skillsDir: '.agents/skills' });
		expect(again.writes).toEqual([]);
		expect(again.files[1]).toMatchObject({ action: 'conflict', writePath: null });
	});

	it('overwrites with force', () => {
		const plan = planSkillsInstall(SAMPLE, (p) => (p.endsWith('extra.md') ? 'mine' : null), { force: true });
		expect(plan.files[1]).toMatchObject({ action: 'overwrite', writePath: '.claude/skills/a/extra.md' });
		expect(plan.writes).toContainEqual({ path: '.claude/skills/a/extra.md', content: 'A2' });
	});

	it('normalizes the skills dir', () => {
		expect(normalizeSkillsDir(undefined)).toBe('.claude/skills');
		expect(normalizeSkillsDir('./.agents/skills/')).toBe('.agents/skills');
		expect(normalizeSkillsDir('a\\b')).toBe('a/b');
		expect(normalizeSkillsDir('.')).toBe('.claude/skills');
	});
});

describe('appendAgentsMdPointer', () => {
	it('appends once, with the marker, the dir and every skill', () => {
		const first = appendAgentsMdPointer('# Agents\n\nRules.\n', '.agents/skills', ['svelte-grab', 'svelte-grab-audit']);
		expect(first.changed).toBe(true);
		expect(first.content.startsWith('# Agents\n\nRules.\n\n' + AGENTS_MD_MARKER)).toBe(true);
		expect(first.content).toContain('`.agents/skills/svelte-grab/SKILL.md`');
		expect(first.content).toContain('`.agents/skills/svelte-grab-audit/SKILL.md`');
		expect(appendAgentsMdPointer(first.content, '.agents/skills', ['svelte-grab'])).toEqual({
			content: first.content,
			changed: false
		});
	});

	it('separates from content without a trailing newline', () => {
		expect(appendAgentsMdPointer('x', undefined, ['a']).content.startsWith(`x\n\n${AGENTS_MD_MARKER}`)).toBe(true);
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
	write('package.json', JSON.stringify({ devDependencies: { '@sveltejs/kit': '^2.20.0', svelte: '^5.40.0' } }));
	write('vite.config.ts', "import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit()] };\n");
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

	it('init copies the skills into .claude/skills by default', () => {
		kitProject();
		const result = init(dir);
		expect(result.ok).toBe(true);
		expect(result.skills?.written).toEqual(EXPECTED);
		for (const rel of EXPECTED) expect(result.written).toContain(rel);
		for (const f of files) expect(readFileSync(join(dir, '.claude/skills', f.path), 'utf-8')).toBe(f.content);
		expect(result.skills?.agentsMd).toBe('absent');
		expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
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
		expect(readFileSync(join(dir, `${rel}.new`), 'utf-8')).toBe(read('svelte-grab-audit/CHECKLIST.md'));
		const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
		expect(logged).toContain(`wrote ${rel}.new`);
		expect(logged).toContain('--force-skills');

		expect(installSkills(dir).written).toEqual([]);

		const forced = installSkills(dir, { force: true });
		expect(forced.written).toEqual([rel]);
		expect(readFileSync(join(dir, rel), 'utf-8')).toBe(read('svelte-grab-audit/CHECKLIST.md'));
	});

	it('--no-skills skips them', () => {
		kitProject();
		const result = init(dir, parseInitArgs(['--no-skills']));
		expect(result.skills).toBeNull();
		expect(existsSync(join(dir, '.claude'))).toBe(false);
	});

	it('--skills-dir puts them elsewhere', () => {
		kitProject();
		const result = init(dir, parseInitArgs(['--skills-dir', '.agents/skills']));
		expect(result.skills?.written).toEqual(files.map((f) => `.agents/skills/${f.path}`));
		expect(existsSync(join(dir, '.agents/skills/svelte-grab/SKILL.md'))).toBe(true);
		expect(existsSync(join(dir, '.claude'))).toBe(false);
	});

	it('appends the AGENTS.md pointer once when AGENTS.md exists', () => {
		kitProject();
		write('AGENTS.md', '# Project rules\n');
		const first = init(dir);
		expect(first.skills?.agentsMd).toBe('appended');
		expect(first.written).toContain('AGENTS.md');
		const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf-8');
		expect(agents.startsWith('# Project rules\n')).toBe(true);
		expect(agents.split(AGENTS_MD_MARKER)).toHaveLength(2);
		expect(agents).toContain('.claude/skills/svelte-grab-audit/SKILL.md');

		const second = init(dir);
		expect(second.skills?.agentsMd).toBe('already-present');
		expect(second.written).toEqual([]);
		expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toBe(agents);
	});

	it('dry run writes nothing (skills nor AGENTS.md)', () => {
		kitProject();
		write('AGENTS.md', '# Project rules\n');
		const before = tree();
		const result = init(dir, { dryRun: true });
		expect(result.written).toEqual([]);
		expect(result.skills?.files.every((f) => f.action === 'create')).toBe(true);
		expect(result.skills?.agentsMd).toBe('appended');
		expect(tree()).toEqual(before);
		const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
		expect(logged).toContain('Would add .claude/skills/svelte-grab/SKILL.md');
	});

	it('parses the skill flags', () => {
		expect(parseSkillsFlags([])).toEqual({ skills: true, skillsDir: '.claude/skills', forceSkills: false });
		expect(parseSkillsFlags(['--no-skills', '--skills-dir=.agents/skills/', '--force-skills'])).toEqual({
			skills: false,
			skillsDir: '.agents/skills',
			forceSkills: true
		});
	});

	describe('svelte-grab skills <sub>', () => {
		it('install (with --skills-dir and --dry-run)', () => {
			expect(runSkillsCommand(['skills', 'install', '--skills-dir', 'x/skills', '--dry-run'], dir)).toBe(0);
			expect(tree()).toEqual({});
			expect(runSkillsCommand(['skills', 'install', '--skills-dir', 'x/skills'], dir)).toBe(0);
			expect(Object.keys(tree()).sort()).toEqual(files.map((f) => `x/skills/${f.path}`).sort());
		});

		it('list and path', () => {
			expect(runSkillsCommand(['skills', 'list'], dir)).toBe(0);
			expect(runSkillsCommand(['skills', 'path'], dir)).toBe(0);
			const logged = logSpy.mock.calls.map((c) => c.join(' '));
			expect(logged).toContain('svelte-grab (1 file)');
			expect(logged).toContain('svelte-grab-audit (4 files)');
			expect(logged).toContain(join(ROOT, 'skills/'));
			expect(listSkills(files).filter((l) => !l.startsWith('  '))).toEqual(['svelte-grab (1 file)', 'svelte-grab-audit (4 files)']);
		});

		it('unknown subcommand fails', () => {
			expect(runSkillsCommand(['skills', 'nope'], dir)).toBe(1);
		});
	});
});
