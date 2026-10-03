/**
 * Agent skills install: `svelte-grab init` (default on) and
 * `svelte-grab skills install|list|path`.
 *
 * Copies the packaged `skills/<name>/` folders into the project
 * (`.claude/skills/` by default). Idempotent; a file the user changed is never
 * overwritten (the new version goes to `<file>.new`) unless `--force-skills`.
 * No npm `postinstall`: install-time scripts are a supply-chain risk and are
 * blocked by default in modern package managers, so this runs only when asked.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { packagedSkillsDir, readSkillFiles } from '../utils/packaged-skills.js';
import {
	appendAgentsMdPointer,
	normalizeSkillsDir,
	parseSkillFrontmatter,
	planSkillsInstall,
	type SkillFile,
	type SkillFilePlan
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
}

export interface SkillsInstallResult {
	ok: boolean;
	skillsDir: string;
	skills: string[];
	/** Project-relative files written (empty in dry-run mode). */
	written: string[];
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

	const read = (rel: string): string | null => {
		const path = join(cwd, rel);
		return existsSync(path) ? readFileSync(path, 'utf-8') : null;
	};
	const save = (rel: string, content: string) => {
		const path = join(cwd, rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, 'utf-8');
		result.written.push(rel);
	};

	const plan = planSkillsInstall(files, read, { skillsDir, force: options.force });
	result.skills = plan.skills;
	result.files = plan.files;

	const verb = (now: string, would: string) => (options.dryRun ? would : now);
	for (const file of plan.files) {
		if (file.action === 'create') console.log(`[svelte-grab] ${verb('Added', 'Would add')} ${file.path}`);
		else if (file.action === 'overwrite') console.log(`[svelte-grab] ${verb('Overwrote', 'Would overwrite')} ${file.path}`);
		else if (file.action === 'conflict') {
			console.log(
				file.writePath
					? `[svelte-grab] ${file.path} differs from the packaged version (edited by you?): ` +
							`${verb('wrote', 'would write')} ${file.writePath}. Merge it, or rerun with --force-skills to overwrite.`
					: `[svelte-grab] ${file.path} differs from the packaged version; ${file.path}.new is already up to date.`
			);
		}
	}
	const unchanged = plan.files.filter((f) => f.action === 'unchanged').length;
	if (unchanged === plan.files.length) {
		console.log(`[svelte-grab] Skills already up to date in ${skillsDir}/ (${plan.skills.join(', ')}).`);
	}
	if (!options.dryRun) for (const write of plan.writes) save(write.path, write.content);

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

/** `svelte-grab skills list`: the packaged skills with their descriptions. */
export function listSkills(files: SkillFile[]): string[] {
	const lines: string[] = [];
	for (const file of files) {
		if (file.path !== `${file.skill}/SKILL.md`) continue;
		const description = parseSkillFrontmatter(file.content)?.data.description ?? '';
		const count = files.filter((f) => f.skill === file.skill).length;
		lines.push(`${file.skill} (${count} file${count === 1 ? '' : 's'})`);
		if (description) lines.push(`  ${description}`);
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
		for (const line of listSkills(readSkillFiles(dir))) console.log(line);
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
