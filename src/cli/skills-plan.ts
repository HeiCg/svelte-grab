/**
 * Pure planner for installing the agent skills (`skills/` in the package) into
 * a project. Shared by `svelte-grab init` / `svelte-grab skills install`
 * (src/cli/skills.ts, which reads and writes the files) and the `sv` add-on
 * (packages/sv-addon, which embeds the skill files at build time).
 *
 * No file system access here: callers pass the skill files and a reader for
 * the project, and write back `plan.writes`.
 */

/** One file of a packaged skill, e.g. `{ skill: 'svelte-grab-audit', path: 'svelte-grab-audit/CHECKLIST.md' }`. */
export interface SkillFile {
	/** Skill (folder) name. */
	skill: string;
	/** Path relative to the skills root, `/`-separated, starting with the skill folder. */
	path: string;
	content: string;
}

/** Default install location (Claude Code project skills). */
export const DEFAULT_SKILLS_DIR = '.claude/skills';

/** Suffix of the copy written next to a user-modified file. */
export const CONFLICT_SUFFIX = '.new';

export type SkillFileAction =
	/** Did not exist: written. */
	| 'create'
	/** Same content already there: nothing to do. */
	| 'unchanged'
	/** Different content, `force`: overwritten. */
	| 'overwrite'
	/** Different content (user-modified or older version): new version written to `<path>.new`. */
	| 'conflict';

export interface SkillFilePlan {
	/** Project-relative target path (`<skillsDir>/<skill path>`). */
	path: string;
	action: SkillFileAction;
	/** File actually written for this entry (path, `<path>.new`), or null when nothing changes. */
	writePath: string | null;
}

export interface SkillsPlan {
	files: SkillFilePlan[];
	/** What to write: the list both init and the sv add-on apply. */
	writes: { path: string; content: string }[];
	/** Skill names covered by the plan, in order. */
	skills: string[];
}

export interface SkillsPlanOptions {
	/** Project-relative directory the skill folders go into (default `.claude/skills`). */
	skillsDir?: string;
	/** Overwrite files whose content differs instead of writing `<file>.new`. */
	force?: boolean;
}

/** Normalize a project-relative directory: `/` separators, no leading `./`, no trailing `/`. */
export function normalizeSkillsDir(dir: string | undefined): string {
	const normalized = (dir ?? DEFAULT_SKILLS_DIR)
		.replace(/\\/g, '/')
		.replace(/^(\.\/)+/, '')
		.replace(/\/+$/, '');
	return normalized === '' || normalized === '.' ? DEFAULT_SKILLS_DIR : normalized;
}

/**
 * Plan the install of `files` under `skillsDir`. `readExisting(path)` returns
 * the current content of a project-relative file, or null when it does not
 * exist. Idempotent: a second run with the same files plans no writes.
 * User-modified files are never overwritten unless `force`; their new version
 * goes to `<file>.new` (skipped when that already holds the same content).
 */
export function planSkillsInstall(
	files: readonly SkillFile[],
	readExisting: (path: string) => string | null,
	options: SkillsPlanOptions = {}
): SkillsPlan {
	const dir = normalizeSkillsDir(options.skillsDir);
	const plan: SkillsPlan = { files: [], writes: [], skills: [] };

	for (const file of files) {
		if (!plan.skills.includes(file.skill)) plan.skills.push(file.skill);
		const path = `${dir}/${file.path}`;
		const existing = readExisting(path);

		if (existing === null) {
			plan.files.push({ path, action: 'create', writePath: path });
			plan.writes.push({ path, content: file.content });
		} else if (existing === file.content) {
			plan.files.push({ path, action: 'unchanged', writePath: null });
		} else if (options.force) {
			plan.files.push({ path, action: 'overwrite', writePath: path });
			plan.writes.push({ path, content: file.content });
		} else {
			const newPath = `${path}${CONFLICT_SUFFIX}`;
			const pending = readExisting(newPath) === file.content;
			plan.files.push({ path, action: 'conflict', writePath: pending ? null : newPath });
			if (!pending) plan.writes.push({ path: newPath, content: file.content });
		}
	}

	return plan;
}

// ============================================================
// AGENTS.md pointer
// ============================================================

/** Marker that makes the AGENTS.md pointer idempotent. */
export const AGENTS_MD_MARKER = '<!-- svelte-grab-skills -->';

/** One-line purpose of each shipped skill, for the AGENTS.md pointer. */
const SKILL_SUMMARIES: Record<string, string> = {
	'svelte-grab': 'inspect, edit and verify the live UI with the svelte-grab `ui_*` MCP tools',
	'svelte-grab-audit': 'per-screen security and performance audit (requests, credential leaks, hot components, memory)'
};

/**
 * Append a short "svelte-grab skills" section to an existing AGENTS.md, once
 * (the marker comment makes it idempotent). Returns `changed: false` when the
 * marker is already there.
 */
export function appendAgentsMdPointer(
	existing: string,
	skillsDir: string | undefined,
	skills: readonly string[]
): { content: string; changed: boolean } {
	if (existing.includes(AGENTS_MD_MARKER)) return { content: existing, changed: false };
	const dir = normalizeSkillsDir(skillsDir);
	const lines = [
		AGENTS_MD_MARKER,
		'## svelte-grab skills',
		'',
		`Agent skills installed by svelte-grab live in \`${dir}/\`. Read the SKILL.md before using the svelte-grab MCP tools:`,
		'',
		...skills.map((name) => `- \`${dir}/${name}/SKILL.md\`${SKILL_SUMMARIES[name] ? `: ${SKILL_SUMMARIES[name]}` : ''}`),
		''
	];
	const separator = existing === '' || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
	return { content: `${existing}${separator}${lines.join('\n')}`, changed: true };
}

// ============================================================
// SKILL.md frontmatter
// ============================================================

/**
 * Minimal YAML frontmatter reader for SKILL.md (`---` block with `key: value`
 * lines; values may be quoted). Returns null when there is no frontmatter.
 */
export function parseSkillFrontmatter(content: string): { data: Record<string, string>; body: string } | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return null;
	const data: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
		if (!kv) continue;
		let value = kv[2].trim();
		if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
		data[kv[1]] = value;
	}
	return { data, body: content.slice(match[0].length) };
}
