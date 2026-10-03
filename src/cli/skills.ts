/**
 * Agent skills install: `svelte-grab init` (default on) and
 * `svelte-grab skills install|list|path`.
 *
 * Copies the packaged `skills/<name>/` folders into the project
 * (`.claude/skills/` by default) and records what it wrote in
 * `<skillsDir>/.svelte-grab-skills.json` (version + SHA-256 per file).
 * Idempotent. On upgrade, a file still matching its recorded hash is replaced
 * in place; a file the user changed is never overwritten (the new version goes
 * to `<file>.new`) unless `--force-skills`. Files a newer version stopped
 * shipping are deleted only when unedited.
 * No npm `postinstall`: install-time scripts are a supply-chain risk and are
 * blocked by default in modern package managers, so this runs only when asked.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { packagedSkillsDir, packageVersion, readSkillFiles } from '../utils/packaged-skills.js';
import {
	appendAgentsMdPointer,
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
	/** AGENTS.md pointer: appended (or would be), already there, or no AGENTS.md. */
	agentsMd: 'appended' | 'already-present' | 'absent';
}

/** Value of `--name <v>` or `--name=<v>`. */
function stringFlag(args: string[], name: string): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
		if (arg === `--${name}` && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
	}
	return undefined;
}

/** Skill flags shared by `init` and `skills install`. */
export function parseSkillsFlags(args: string[]): { skills: boolean; skillsDir: string; forceSkills: boolean } {
	return {
		skills: !args.includes('--no-skills'),
		skillsDir: normalizeSkillsDir(stringFlag(args, 'skills-dir')),
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

/** Plan against the project in `cwd` (shared by install and list). */
function planForProject(cwd: string, files: readonly SkillFile[], skillsDir: string, force: boolean, version?: string): SkillsPlan {
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
export function installSkills(cwd: string, options: SkillsInstallOptions = {}): SkillsInstallResult {
	const skillsDir = normalizeSkillsDir(options.skillsDir);
	const result: SkillsInstallResult = {
		ok: false,
		skillsDir,
		skills: [],
		written: [],
		removed: [],
		files: [],
		agentsMd: 'absent'
	};

	let files = options.files;
	if (!files) {
		const dir = packagedSkillsDir();
		if (!dir) {
			console.error('[svelte-grab] Packaged skills not found (expected skills/ next to dist/). Skipping skills.');
			return result;
		}
		files = readSkillFiles(dir);
	}

	const read = projectReader(cwd);
	const save = (rel: string, content: string) => {
		const path = join(cwd, rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, 'utf-8');
		result.written.push(rel);
	};

	const plan = planForProject(cwd, files, skillsDir, options.force ?? false, options.version);
	result.skills = plan.skills;
	result.files = plan.files;

	const verb = (now: string, would: string) => (options.dryRun ? would : now);
	for (const file of plan.files) {
		if (file.action === 'create') console.log(`[svelte-grab] ${verb('Added', 'Would add')} ${file.path}`);
		else if (file.action === 'updated') {
			console.log(`[svelte-grab] ${verb('Updated', 'Would update')} ${file.path} (not edited since the last install)`);
		} else if (file.action === 'overwrite') console.log(`[svelte-grab] ${verb('Overwrote', 'Would overwrite')} ${file.path}`);
		else if (file.action === 'conflict') {
			console.log(
				file.writePath
					? `[svelte-grab] ${file.path} differs from the packaged version (edited by you?): ` +
							`${verb('wrote', 'would write')} ${file.writePath}. Merge it, or rerun with --force-skills to overwrite.`
					: `[svelte-grab] ${file.path} differs from the packaged version; ${file.path}.new is already up to date.`
			);
		} else if (file.action === 'removed') {
			console.log(`[svelte-grab] ${verb('Removed', 'Would remove')} ${file.path} (no longer shipped, not edited)`);
		} else if (file.action === 'orphaned') {
			console.log(`[svelte-grab] ${file.path} is no longer shipped but you edited it: left in place. Delete it when done.`);
		}
	}
	const unchanged = plan.files.filter((f) => f.action === 'unchanged').length;
	if (unchanged === plan.files.length) {
		console.log(`[svelte-grab] Skills already up to date in ${skillsDir}/ (${plan.skills.join(', ')}).`);
	}
	if (!options.dryRun) {
		for (const write of plan.writes) save(write.path, write.content);
		for (const rel of plan.removes) {
			removeSkillFile(cwd, skillsDir, rel);
			result.removed.push(rel);
		}
	}

	// AGENTS.md pointer (only when the project already has one)
	const agents = read('AGENTS.md');
	if (agents !== null) {
		const pointer = appendAgentsMdPointer(agents, skillsDir, plan.skills);
		result.agentsMd = pointer.changed ? 'appended' : 'already-present';
		if (pointer.changed) {
			console.log(`[svelte-grab] ${verb('Added', 'Would add')} a svelte-grab skills pointer to AGENTS.md`);
			if (!options.dryRun) save('AGENTS.md', pointer.content);
		}
	}

	result.ok = true;
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
	const statuses = (plan?.files ?? []).map((f) => ({ rel: f.path.slice(prefix.length), action: f.action }));
	const listed = new Set<string>();
	for (const file of files) {
		if (file.path !== `${file.skill}/SKILL.md`) continue;
		const description = parseSkillFrontmatter(file.content)?.data.description ?? '';
		const count = files.filter((f) => f.skill === file.skill).length;
		lines.push(`${file.skill} (${count} file${count === 1 ? '' : 's'})`);
		if (description) lines.push(`  ${description}`);
		for (const status of statuses) {
			if (!status.rel.startsWith(`${file.skill}/`)) continue;
			lines.push(`  - ${status.rel.slice(file.skill.length + 1)}: ${SKILL_STATUS_LABELS[status.action]}`);
			listed.add(status.rel);
		}
	}
	const rest = statuses.filter((s) => !listed.has(s.rel));
	if (rest.length) {
		lines.push('No longer shipped');
		for (const status of rest) lines.push(`  - ${status.rel}: ${SKILL_STATUS_LABELS[status.action]}`);
	}
	return lines;
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
		const { skillsDir } = parseSkillsFlags(args);
		const files = readSkillFiles(dir);
		console.log(`[svelte-grab] Packaged skills (svelte-grab ${packageVersion() ?? 'unknown'}) vs ${skillsDir}/:`);
		for (const line of listSkills(files, planForProject(cwd, files, skillsDir, false))) console.log(line);
		return 0;
	}

	if (sub === 'install') {
		const flags = parseSkillsFlags(args);
		const dryRun = args.includes('--dry-run');
		if (dryRun) console.log('[svelte-grab] Dry run mode - no files will be written\n');
		const force = flags.forceSkills || args.includes('--force');
		const result = installSkills(cwd, { skillsDir: flags.skillsDir, force, dryRun });
		return result.ok ? 0 : 1;
	}

	console.error(`[svelte-grab] Unknown skills command "${sub}". Use: svelte-grab skills install|list|path`);
	return 1;
}
