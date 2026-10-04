/**
 * Agent skills install: `svelte-grab init` (default on) and
 * `svelte-grab skills install|list|path`.
 *
 * Copies the packaged `skills/<name>/` folders into the project, once per
 * agent (`.claude/skills/` for Claude Code, `.agents/skills/` for Codex; a
 * single `--skills-dir` instead when given) and records what it wrote in
 * `<skillsDir>/.svelte-grab-skills.json` (version + SHA-256 per file, one
 * manifest per directory). Then adds the svelte-grab section to AGENTS.md
 * (and a pointer in CLAUDE.md), see {@link updateAgentDocs}.
 * Idempotent. On upgrade, a file still matching its recorded hash is replaced
 * in place; a file the user changed is never overwritten (the new version goes
 * to `<file>.new`) unless `--force-skills`. Files a newer version stopped
 * shipping are deleted only when unedited.
 * No npm `postinstall`: install-time scripts are a supply-chain risk and are
 * blocked by default in modern package managers, so this runs only when asked.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { packagedSkillsDir, packageVersion, readSkillFiles } from '../utils/packaged-skills.js';
import {
	AGENT_SKILLS_DIRS,
	appendClaudeMdPointer,
	parseAgentsFlags,
	resolveAgents,
	skillsDirsFor,
	stringFlag,
	upsertAgentsMd,
	type AgentName,
	type AgentsMdAction,
	type ClaudeMdAction
} from './agents.js';
import {
	normalizeSkillsDir,
	parseSkillFrontmatter,
	planSkillsInstall,
	type SkillFile,
	type SkillFileAction,
	type SkillFilePlan,
	type SkillsPlan
} from './skills-plan.js';

export interface SkillsInstallOptions {
	/** Project-relative directory for the skill folders (default `.claude/skills`). */
	skillsDir?: string;
	/** Overwrite files that differ instead of writing `<file>.new`. */
	force?: boolean;
	/** Print what would change without writing. */
	dryRun?: boolean;
	/** Skill files to install (default: the packaged `skills/` directory). */
	files?: SkillFile[];
	/** Version recorded in the manifest (default: the installed svelte-grab version). */
	version?: string;
}

export interface SkillsInstallResult {
	ok: boolean;
	skillsDir: string;
	skills: string[];
	/** Project-relative files written, including the manifest when it changed (empty in dry-run mode). */
	written: string[];
	/** Project-relative files deleted: no longer shipped and never edited (empty in dry-run mode). */
	removed: string[];
	files: SkillFilePlan[];
}

/** Skill flags shared by `init` and `skills install`. */
export function parseSkillsFlags(args: string[]): {
	skills: boolean;
	/** Explicit single target directory, or undefined for one per agent. */
	skillsDir: string | undefined;
	forceSkills: boolean;
} {
	const dir = stringFlag(args, 'skills-dir');
	return {
		skills: !args.includes('--no-skills'),
		skillsDir: dir === undefined ? undefined : normalizeSkillsDir(dir),
		forceSkills: args.includes('--force-skills')
	};
}

/** Reader for project-relative files, null when missing. */
function projectReader(cwd: string): (rel: string) => string | null {
	return (rel) => {
		const path = join(cwd, rel);
		return existsSync(path) ? readFileSync(path, 'utf-8') : null;
	};
}

/** Write a project-relative file, creating its folders. */
function saveProjectFile(cwd: string, rel: string, content: string): void {
	const path = join(cwd, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, 'utf-8');
}

/** Plan against the project in `cwd` (shared by install and list). */
function planForProject(
	cwd: string,
	files: readonly SkillFile[],
	skillsDir: string,
	force: boolean,
	version?: string
): SkillsPlan {
	return planSkillsInstall(files, projectReader(cwd), {
		skillsDir,
		force,
		version: version ?? packageVersion() ?? 'unknown'
	});
}

/** Delete `rel`, then its parent folders inside `skillsDir` that became empty. */
function removeSkillFile(cwd: string, skillsDir: string, rel: string): void {
	unlinkSync(join(cwd, rel));
	const root = join(cwd, skillsDir);
	for (let dir = dirname(join(cwd, rel)); dir.startsWith(root + sep); dir = dirname(dir)) {
		if (readdirSync(dir).length > 0) break;
		rmdirSync(dir);
	}
}

/**
 * Install (or update) the skills into `cwd`. Prints one line per change.
 * Returns `ok: false` only when the packaged skills cannot be found.
 */
export function installSkills(
	cwd: string,
	options: SkillsInstallOptions = {}
): SkillsInstallResult {
	const skillsDir = normalizeSkillsDir(options.skillsDir);
	const result: SkillsInstallResult = {
		ok: false,
		skillsDir,
		skills: [],
		written: [],
		removed: [],
		files: []
	};

	let files = options.files;
	if (!files) {
		const dir = packagedSkillsDir();
		if (!dir) {
			console.error(
				'[svelte-grab] Packaged skills not found (expected skills/ next to dist/). Skipping skills.'
			);
			return result;
		}
		files = readSkillFiles(dir);
	}

	const save = (rel: string, content: string) => {
		saveProjectFile(cwd, rel, content);
		result.written.push(rel);
	};

	const plan = planForProject(cwd, files, skillsDir, options.force ?? false, options.version);
	result.skills = plan.skills;
	result.files = plan.files;

	const verb = (now: string, would: string) => (options.dryRun ? would : now);
	for (const file of plan.files) {
		if (file.action === 'create')
			console.log(`[svelte-grab] ${verb('Added', 'Would add')} ${file.path}`);
		else if (file.action === 'updated') {
			console.log(
				`[svelte-grab] ${verb('Updated', 'Would update')} ${file.path} (not edited since the last install)`
			);
		} else if (file.action === 'overwrite')
			console.log(`[svelte-grab] ${verb('Overwrote', 'Would overwrite')} ${file.path}`);
		else if (file.action === 'conflict') {
			console.log(
				file.writePath
					? `[svelte-grab] ${file.path} differs from the packaged version (edited by you?): ` +
							`${verb('wrote', 'would write')} ${file.writePath}. Merge it, or rerun with --force-skills to overwrite.`
					: `[svelte-grab] ${file.path} differs from the packaged version; ${file.path}.new is already up to date.`
			);
		} else if (file.action === 'removed') {
			console.log(
				`[svelte-grab] ${verb('Removed', 'Would remove')} ${file.path} (no longer shipped, not edited)`
			);
		} else if (file.action === 'orphaned') {
			console.log(
				`[svelte-grab] ${file.path} is no longer shipped but you edited it: left in place. Delete it when done.`
			);
		}
	}
	const unchanged = plan.files.filter((f) => f.action === 'unchanged').length;
	if (unchanged === plan.files.length) {
		console.log(
			`[svelte-grab] Skills already up to date in ${skillsDir}/ (${plan.skills.join(', ')}).`
		);
	}
	if (!options.dryRun) {
		for (const write of plan.writes) save(write.path, write.content);
		for (const rel of plan.removes) {
			removeSkillFile(cwd, skillsDir, rel);
			result.removed.push(rel);
		}
	}

	result.ok = true;
	return result;
}

export interface AgentSkillsInstallOptions extends Omit<SkillsInstallOptions, 'skillsDir'> {
	/** Project-relative directories to install into, each with its own manifest. */
	skillsDirs: readonly string[];
}

export interface AgentSkillsInstallResult {
	ok: boolean;
	/** Skill names installed. */
	skills: string[];
	/** One install per directory, in order. */
	targets: SkillsInstallResult[];
	/** Every target's `written`, in order. */
	written: string[];
}

/**
 * Install the skills into several directories (one per agent): the same
 * packaged files and planner for each, so every directory gets its own
 * manifest and the same upgrade rules.
 */
export function installAgentSkills(
	cwd: string,
	options: AgentSkillsInstallOptions
): AgentSkillsInstallResult {
	const result: AgentSkillsInstallResult = { ok: false, skills: [], targets: [], written: [] };
	let files = options.files;
	if (!files) {
		const dir = packagedSkillsDir();
		if (!dir) {
			console.error(
				'[svelte-grab] Packaged skills not found (expected skills/ next to dist/). Skipping skills.'
			);
			return result;
		}
		files = readSkillFiles(dir);
	}
	for (const skillsDir of options.skillsDirs) {
		const target = installSkills(cwd, { ...options, files, skillsDir });
		result.targets.push(target);
		result.written.push(...target.written);
		for (const skill of target.skills)
			if (!result.skills.includes(skill)) result.skills.push(skill);
	}
	result.ok = result.targets.every((t) => t.ok);
	return result;
}

export interface AgentDocsOptions {
	agents: readonly AgentName[];
	/** Skills directories installed by this run (empty when skills are skipped). */
	skillsDirs: readonly string[];
	/** Skill names installed. */
	skills: readonly string[];
	dryRun?: boolean;
}

export interface AgentDocsResult {
	/** Project-relative files written (empty in dry-run mode). */
	written: string[];
	agentsMd: AgentsMdAction;
	/** `skipped`: Claude Code not selected, or AGENTS.md has no svelte-grab section. */
	claudeMd: ClaudeMdAction | 'skipped';
}

/**
 * AGENTS.md and CLAUDE.md:
 * - AGENTS.md gets the svelte-grab section once: created when Codex is
 *   selected (Codex reads AGENTS.md), else appended only to an existing file.
 * - CLAUDE.md, when Claude Code is selected and the project has one: Claude
 *   Code then ignores AGENTS.md unless CLAUDE.md imports it, so a one-line
 *   pointer to the section is appended once. CLAUDE.md is never created.
 */
export function updateAgentDocs(cwd: string, options: AgentDocsOptions): AgentDocsResult {
	const read = projectReader(cwd);
	const result: AgentDocsResult = { written: [], agentsMd: 'absent', claudeMd: 'skipped' };
	const verb = (now: string, would: string) => (options.dryRun ? would : now);
	const save = (rel: string, content: string) => {
		if (options.dryRun) return;
		saveProjectFile(cwd, rel, content);
		result.written.push(rel);
	};

	// AGENTS.md is read by Codex first: list its skills directory first.
	const codexDir = AGENT_SKILLS_DIRS.codex;
	const sectionDirs = [...options.skillsDirs].sort(
		(a, b) => Number(b === codexDir) - Number(a === codexDir)
	);
	const agentsMd = upsertAgentsMd(read('AGENTS.md'), {
		skillsDirs: sectionDirs,
		skills: options.skills,
		create: options.agents.includes('codex')
	});
	result.agentsMd = agentsMd.action;
	if (agentsMd.action === 'created' || agentsMd.action === 'appended') {
		console.log(
			`[svelte-grab] ${agentsMd.action === 'created' ? verb('Created', 'Would create') : verb('Added', 'Would add')} ` +
				`${agentsMd.action === 'created' ? 'AGENTS.md with ' : ''}a svelte-grab section${agentsMd.action === 'appended' ? ' to AGENTS.md' : ''}`
		);
		save('AGENTS.md', agentsMd.content);
	}

	if (options.agents.includes('claude') && agentsMd.action !== 'absent') {
		const claudeDir = options.skillsDirs.includes(AGENT_SKILLS_DIRS.claude)
			? AGENT_SKILLS_DIRS.claude
			: null;
		const claudeMd = appendClaudeMdPointer(read('CLAUDE.md'), claudeDir);
		result.claudeMd = claudeMd.action;
		if (claudeMd.action === 'appended') {
			console.log(
				`[svelte-grab] ${verb('Added', 'Would add')} a one-line svelte-grab pointer to CLAUDE.md ` +
					'(Claude Code skips AGENTS.md when CLAUDE.md exists)'
			);
			save('CLAUDE.md', claudeMd.content);
		}
	}
	return result;
}

/** What `skills list` says about each file, by planned action. */
export const SKILL_STATUS_LABELS: Record<SkillFileAction, string> = {
	create: 'new',
	unchanged: 'up to date',
	updated: 'will update',
	overwrite: 'will overwrite',
	conflict: 'edited by you',
	removed: 'no longer shipped, will remove',
	orphaned: 'no longer shipped, edited by you',
	obsolete: 'no longer shipped'
};

/**
 * `svelte-grab skills list`: the packaged skills with their descriptions and,
 * given a plan against the project, one `  - <file>: <status>` line per file.
 */
export function listSkills(files: readonly SkillFile[], plan?: SkillsPlan): string[] {
	const lines: string[] = [];
	const prefix = plan ? plan.manifestPath.slice(0, plan.manifestPath.lastIndexOf('/') + 1) : '';
	const statuses = (plan?.files ?? []).map((f) => ({
		rel: f.path.slice(prefix.length),
		action: f.action
	}));
	const listed = new Set<string>();
	for (const file of files) {
		if (file.path !== `${file.skill}/SKILL.md`) continue;
		const description = parseSkillFrontmatter(file.content)?.data.description ?? '';
		const count = files.filter((f) => f.skill === file.skill).length;
		lines.push(`${file.skill} (${count} file${count === 1 ? '' : 's'})`);
		if (description) lines.push(`  ${description}`);
		for (const status of statuses) {
			if (!status.rel.startsWith(`${file.skill}/`)) continue;
			lines.push(
				`  - ${status.rel.slice(file.skill.length + 1)}: ${SKILL_STATUS_LABELS[status.action]}`
			);
			listed.add(status.rel);
		}
	}
	const rest = statuses.filter((s) => !listed.has(s.rel));
	if (rest.length) {
		lines.push('No longer shipped');
		for (const status of rest)
			lines.push(`  - ${status.rel}: ${SKILL_STATUS_LABELS[status.action]}`);
	}
	return lines;
}

/** Agents and skills directories from `--agents` / `--no-codex` / `--skills-dir`; null (after an error) on unknown agents. */
function skillsTargets(args: string[]): { agents: AgentName[]; skillsDirs: string[] } | null {
	const { agents, unknown } = resolveAgents(parseAgentsFlags(args).agents);
	if (unknown.length) {
		console.error(
			`[svelte-grab] Unknown agent(s): ${unknown.join(', ')}. Use --agents claude,codex (or a subset).`
		);
		return null;
	}
	const { skillsDir } = parseSkillsFlags(args);
	if (agents.length === 0 && skillsDir === undefined) {
		console.error('[svelte-grab] No agent selected. Use --agents claude,codex (or a subset).');
		return null;
	}
	return { agents, skillsDirs: skillsDirsFor(agents, skillsDir) };
}

/**
 * `svelte-grab skills <install|list|path>`. Returns the process exit code.
 */
export function runSkillsCommand(args: string[], cwd: string = process.cwd()): number {
	const sub = args[1] ?? 'install';
	const dir = packagedSkillsDir();

	if (sub === 'path') {
		if (!dir) {
			console.error('[svelte-grab] Packaged skills not found.');
			return 1;
		}
		console.log(dir);
		return 0;
	}

	if (sub === 'list') {
		if (!dir) {
			console.error('[svelte-grab] Packaged skills not found.');
			return 1;
		}
		const targets = skillsTargets(args);
		if (!targets) return 1;
		const files = readSkillFiles(dir);
		for (const skillsDir of targets.skillsDirs) {
			console.log(
				`[svelte-grab] Packaged skills (svelte-grab ${packageVersion() ?? 'unknown'}) vs ${skillsDir}/:`
			);
			for (const line of listSkills(files, planForProject(cwd, files, skillsDir, false)))
				console.log(line);
		}
		return 0;
	}

	if (sub === 'install') {
		const targets = skillsTargets(args);
		if (!targets) return 1;
		const flags = parseSkillsFlags(args);
		const dryRun = args.includes('--dry-run');
		if (dryRun) console.log('[svelte-grab] Dry run mode - no files will be written\n');
		const force = flags.forceSkills || args.includes('--force');
		const result = installAgentSkills(cwd, { skillsDirs: targets.skillsDirs, force, dryRun });
		if (!result.ok) return 1;
		if (!args.includes('--no-agents-md')) {
			updateAgentDocs(cwd, {
				agents: targets.agents,
				skillsDirs: targets.skillsDirs,
				skills: result.skills,
				dryRun
			});
		}
		return 0;
	}

	console.error(
		`[svelte-grab] Unknown skills command "${sub}". Use: svelte-grab skills install|list|path`
	);
	return 1;
}
