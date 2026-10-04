/**
 * Coding agents `svelte-grab init`, `svelte-grab skills install` and the `sv`
 * add-on set up, and the instruction files they touch (AGENTS.md, CLAUDE.md).
 *
 * Pure: no file system access (the sv add-on imports this module too).
 *
 * What each agent reads (see README "Agent setup"):
 * - Claude Code: `.mcp.json`, skills in `.claude/skills/`, CLAUDE.md (and
 *   AGENTS.md only when there is no CLAUDE.md).
 * - Codex: `.codex/config.toml` (trusted projects), skills in `.agents/skills/`,
 *   AGENTS.md.
 * Both load the MCP server instructions (src/mcp/instructions.ts).
 */

import { normalizeSkillsDir } from './skills-plan.js';

export const AGENT_NAMES = ['claude', 'codex'] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export const AGENT_LABELS: Record<AgentName, string> = {
	claude: 'Claude Code',
	codex: 'Codex'
};

/** Where each agent discovers project skills. */
export const AGENT_SKILLS_DIRS: Record<AgentName, string> = {
	claude: '.claude/skills',
	codex: '.agents/skills'
};

/** Value of `--name <v>` or `--name=<v>`. */
export function stringFlag(args: readonly string[], name: string): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
		if (arg === `--${name}` && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
	}
	return undefined;
}

/**
 * `--agents claude,codex` (default: both) and `--no-codex` (drops codex).
 * Names are lower-cased but not validated here: see {@link resolveAgents}.
 */
export function parseAgentsFlags(args: readonly string[]): { agents: string[] } {
	const raw = stringFlag(args, 'agents');
	let agents: string[] = raw
		? raw
				.split(',')
				.map((name) => name.trim().toLowerCase())
				.filter(Boolean)
		: [...AGENT_NAMES];
	if (args.includes('--no-codex')) agents = agents.filter((name) => name !== 'codex');
	return { agents };
}

/** Known agents in canonical order (deduplicated), plus the unknown names. */
export function resolveAgents(names: readonly string[] | undefined): {
	agents: AgentName[];
	unknown: string[];
} {
	const list = names ?? AGENT_NAMES;
	const unknown = list.filter((name) => !(AGENT_NAMES as readonly string[]).includes(name));
	const agents = AGENT_NAMES.filter((name) => list.includes(name));
	return { agents, unknown };
}

/**
 * Skills directories to install into: the explicit `skillsDir` alone when
 * given, else one per agent (`.claude/skills`, `.agents/skills`).
 */
export function skillsDirsFor(agents: readonly AgentName[], skillsDir?: string): string[] {
	if (skillsDir !== undefined) return [normalizeSkillsDir(skillsDir)];
	return [...new Set(agents.map((agent) => AGENT_SKILLS_DIRS[agent]))];
}

// ============================================================
// AGENTS.md
// ============================================================

/** Marker that makes the AGENTS.md section idempotent (kept from the older skills pointer). */
export const AGENTS_MD_MARKER = '<!-- svelte-grab-skills -->';

/** One-line purpose of each shipped skill. */
const SKILL_SUMMARIES: Record<string, string> = {
	'svelte-grab': 'the UI loop with the `ui_*` tools',
	'svelte-grab-audit':
		'per-screen security and performance audit (requests, credential leaks, hot components, memory)'
};

/**
 * The svelte-grab section of AGENTS.md: what it is, where the skills are and
 * the loop in five lines. `skillsDirs` empty (skills not installed) points at
 * the MCP prompt instead.
 */
export function agentsMdSection(skillsDirs: readonly string[], skills: readonly string[]): string {
	const where = skillsDirs.length
		? [
				`Read the skill before UI work (same files in ${skillsDirs.map((d) => `\`${d}/\``).join(' and ')}):`,
				'',
				...skills.map(
					(name) =>
						`- \`${skillsDirs[0]}/${name}/SKILL.md\`${SKILL_SUMMARIES[name] ? `: ${SKILL_SUMMARIES[name]}` : ''}`
				)
			]
		: ['The full guide is the `svelte-grab-loop` prompt of the svelte-grab MCP server.'];
	return [
		AGENTS_MD_MARKER,
		'## svelte-grab',
		'',
		'svelte-grab gives coding agents eyes into this Svelte app while it runs in dev: the `svelte-grab` MCP ' +
			'server reports every element with its component, `file:line` and a ref (`eN`). Use its `ui_*` tools ' +
			'for UI work instead of guessing from the source.',
		'',
		...where,
		'',
		'The loop:',
		'',
		'1. `ui_snapshot` / `ui_find` to get refs, `ui_inspect` for props, state and styles of one ref.',
		'2. `ui_component_impact` before editing a component that may be shared.',
		'3. Edit, then `ui_wait_for_hmr` with the edited files (fix compile errors first).',
		'4. `ui_verify` the element; `ui_profile` after reactive changes.',
		'5. `ui_tabs` empty or "No browser tab connected": ask the user to start the dev server and open the app.',
		''
	].join('\n');
}

export type AgentsMdAction = 'created' | 'appended' | 'already-present' | 'absent';

/**
 * Add the svelte-grab section to AGENTS.md once (the marker makes it
 * idempotent): appended to an existing file, or a new file when `create`.
 * `existing` null or blank = no AGENTS.md.
 */
export function upsertAgentsMd(
	existing: string | null,
	options: { skillsDirs: readonly string[]; skills: readonly string[]; create: boolean }
): { content: string; action: AgentsMdAction } {
	const section = agentsMdSection(options.skillsDirs, options.skills);
	if (existing === null || existing.trim() === '') {
		if (!options.create) return { content: existing ?? '', action: 'absent' };
		return { content: `# AGENTS.md\n\n${section}`, action: 'created' };
	}
	if (existing.includes(AGENTS_MD_MARKER)) return { content: existing, action: 'already-present' };
	const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
	return { content: `${existing}${separator}${section}`, action: 'appended' };
}

// ============================================================
// CLAUDE.md
// ============================================================

/** Marker that makes the CLAUDE.md pointer idempotent. */
export const CLAUDE_MD_MARKER = '<!-- svelte-grab -->';

/** True when CLAUDE.md imports AGENTS.md (`@AGENTS.md` / `@./AGENTS.md` outside code). */
export function claudeMdImportsAgentsMd(content: string): boolean {
	const withoutCode = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
	return /(^|\s)@(\.\/)?AGENTS\.md(?=\s|$)/m.test(withoutCode);
}

export type ClaudeMdAction = 'appended' | 'already-present' | 'imports-agents-md' | 'absent';

/**
 * Claude Code reads AGENTS.md only when the project has no CLAUDE.md. When it
 * has one that does not import AGENTS.md, append a one-line pointer to the
 * svelte-grab section (once). A missing CLAUDE.md is never created.
 */
export function appendClaudeMdPointer(
	existing: string | null,
	claudeSkillsDir: string | null
): { content: string; action: ClaudeMdAction } {
	if (existing === null || existing.trim() === '')
		return { content: existing ?? '', action: 'absent' };
	if (existing.includes(CLAUDE_MD_MARKER)) return { content: existing, action: 'already-present' };
	if (claudeMdImportsAgentsMd(existing)) return { content: existing, action: 'imports-agents-md' };
	const skill = claudeSkillsDir ? ` and \`${claudeSkillsDir}/svelte-grab/SKILL.md\`` : '';
	const line =
		`${CLAUDE_MD_MARKER} svelte-grab: for UI work in the running app use the svelte-grab MCP \`ui_*\` tools; ` +
		`see the svelte-grab section of \`AGENTS.md\`${skill}.`;
	const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
	return { content: `${existing}${separator}${line}\n`, action: 'appended' };
}
