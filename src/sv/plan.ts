/**
 * What the add-on does, written against the subset of sv's `run()` context it
 * uses. No import from `sv` or `@sveltejs/sv-utils`, so the root Vitest suite
 * (tests/sv-addon.test.ts) can drive it with a fake `sv` object.
 *
 * The string transforms are the same ones `svelte-grab init` uses
 * (src/cli/transforms.ts), and so is the skills planner
 * (src/cli/skills-plan.ts). `sv add svelte-grab` unpacks the whole svelte-grab
 * tarball and imports `svelte-grab/sv` (dist/sv/index.js) from it, so these
 * relative imports, the package's `skills/` folder and its package.json are
 * all on disk next to the add-on: no bundling, no embedded copies.
 */
import {
	CODEX_CONFIG_PATH,
	injectAppSvelte,
	injectKitLayout,
	injectVitePlugin,
	mergeCodexConfigToml,
	mergeMcpJson,
	VITE_PLUGIN_IMPORT,
	type McpServerName
} from '../cli/transforms.js';
import { planSkillsInstall, type SkillFile } from '../cli/skills-plan.js';
import {
	AGENT_SKILLS_DIRS,
	appendClaudeMdPointer,
	upsertAgentsMd,
	type AgentsMdAction,
	type ClaudeMdAction
} from '../cli/agents.js';
import { packagedSkillsDir, packageVersion, readSkillFiles } from '../utils/packaged-skills.js';

/** Add-on id: the npm package name, so `npx sv add svelte-grab` and the option prefix match. */
export const ADDON_ID = 'svelte-grab';

/** Used when the package's own version cannot be read (should not happen in a real install). */
const FALLBACK_SVELTE_GRAB_RANGE = '^2.0.0';

/** `^<version>` of the svelte-grab package the add-on runs from. */
export function svelteGrabRange(version: string | null = packageVersion()): string {
	return version ? `^${version}` : FALLBACK_SVELTE_GRAB_RANGE;
}

/** Dev dependencies the add-on declares (skipped when already present). */
export const DEV_DEPENDENCIES = {
	// The same version as the add-on: sv runs it from the svelte-grab tarball it downloaded.
	'svelte-grab': svelteGrabRange(),
	// Needed by `svelte-grab-mcp --stdio` (optional peers of svelte-grab).
	'@modelcontextprotocol/sdk': '^1.26.0',
	zod: '^4.0.0'
} as const;

export interface SvelteGrabAddonOptions {
	mcpJson: boolean;
	svelteMcp: boolean;
	playwrightMcp: boolean;
	vitePlugin: boolean;
	/** Copy the agent skills into .claude/skills/ (and .agents/skills/ with `codex`). */
	skills: boolean;
	/**
	 * Also set up OpenAI Codex: `.codex/config.toml` (with `mcpJson`), skills in
	 * `.agents/skills/` (with `skills`) and an AGENTS.md section (created if missing).
	 */
	codex: boolean;
}

export const DEFAULT_OPTIONS: SvelteGrabAddonOptions = {
	mcpJson: true,
	svelteMcp: true,
	playwrightMcp: false,
	vitePlugin: true,
	skills: true,
	codex: true
};

/** The part of sv's `run()` context (Workspace + sv API) the add-on reads. */
export interface AddonRunContext {
	sv: {
		/** Edit (or create, content '') a file; return the new content or false to leave it. */
		file(path: string, edit: (content: string) => string | false): void;
		devDependency(pkg: string, version: string): void;
	};
	/** Answers; a question skipped by its `condition` is undefined. */
	options: Partial<SvelteGrabAddonOptions>;
	isKit: boolean;
	language: 'ts' | 'js';
	file: { viteConfig: string };
	directory: { src: string; kitRoutes: string };
	dependencyVersion?: (pkg: string) => string | undefined;
	/** Skill files to install (default: the package's own `skills/` folder). */
	skillFiles?: readonly SkillFile[];
	/** Version recorded in the skills manifest (default: the package's own version). */
	skillsVersion?: string;
}

export interface AddonReport {
	/** Servers added to .mcp.json (Claude Code). */
	mcpServersAdded: McpServerName[];
	/** Servers added to .codex/config.toml (Codex). */
	codexServersAdded: McpServerName[];
	enableMcp: boolean;
	vitePlugin: 'added' | 'already-present' | 'manual' | 'skipped';
	layout: 'written' | 'already-present' | 'manual';
	devDependencies: string[];
	/** Skill files written in every skills dir (including `<file>.new` next to user-edited ones and the manifests); empty when skipped. */
	skillsWritten: string[];
	agentsMd: AgentsMdAction;
	claudeMd: ClaudeMdAction | 'skipped';
	/** Manual follow-ups for nextSteps. */
	notes: string[];
}

export function runSvelteGrabAddon(ctx: AddonRunContext): AddonReport {
	const options = { ...DEFAULT_OPTIONS, ...stripUndefined(ctx.options) };
	const report: AddonReport = {
		mcpServersAdded: [],
		codexServersAdded: [],
		enableMcp: false,
		vitePlugin: 'skipped',
		layout: 'manual',
		devDependencies: [],
		skillsWritten: [],
		agentsMd: 'absent',
		claudeMd: 'skipped',
		notes: []
	};

	// 1. .mcp.json (Claude Code project format; existing entries are kept)
	if (options.mcpJson) {
		ctx.sv.file('.mcp.json', (content) => {
			const merged = mergeMcpJson(content, {
				svelteMcp: options.svelteMcp,
				playwrightMcp: options.playwrightMcp
			});
			if (merged.error) {
				report.notes.push(`${merged.error}; add the svelte-grab server to .mcp.json yourself`);
				return false;
			}
			report.mcpServersAdded = merged.added;
			report.enableMcp =
				merged.added.includes('svelte-grab') || merged.kept.includes('svelte-grab');
			return merged.changed ? merged.content : false;
		});
	}

	// 1b. .codex/config.toml (Codex, trusted projects; existing tables are kept)
	if (options.mcpJson && options.codex) {
		ctx.sv.file(CODEX_CONFIG_PATH, (content) => {
			const merged = mergeCodexConfigToml(content || null, {
				svelteMcp: options.svelteMcp,
				playwrightMcp: options.playwrightMcp
			});
			report.codexServersAdded = merged.added;
			if (merged.added.includes('svelte-grab') || merged.kept.includes('svelte-grab'))
				report.enableMcp = true;
			return merged.changed ? merged.content : false;
		});
	}

	// 2. Vite plugin
	if (options.vitePlugin) {
		const viteConfig = ctx.file.viteConfig;
		ctx.sv.file(viteConfig, (content) => {
			if (!content) {
				report.vitePlugin = 'manual';
				report.notes.push(
					`No ${viteConfig} found: add svelteGrab() from svelte-grab/vite to your Vite plugins`
				);
				return false;
			}
			const injected = injectVitePlugin(content);
			report.vitePlugin = injected.status;
			if (injected.status === 'manual') {
				report.notes.push(
					`Could not edit ${viteConfig} safely: add \`${VITE_PLUGIN_IMPORT}\` and svelteGrab() after ` +
						`${ctx.isKit ? 'sveltekit()' : 'svelte()'} in plugins`
				);
			}
			return injected.changed ? injected.content : false;
		});
	}

	// 3. Root layout (Kit) or App.svelte (Vite + Svelte)
	const layoutOptions = { enableMcp: report.enableMcp, language: ctx.language };
	if (ctx.isKit) {
		ctx.sv.file(`${ctx.directory.kitRoutes}/+layout.svelte`, (content) => {
			const injected = injectKitLayout(content || null, layoutOptions);
			report.layout = injected.changed ? 'written' : 'already-present';
			return injected.changed ? injected.content : false;
		});
	} else {
		const appPath = `${ctx.directory.src}/App.svelte`;
		ctx.sv.file(appPath, (content) => {
			if (!content) {
				report.layout = 'manual';
				report.notes.push(
					`No ${appPath}: add ${report.enableMcp ? '<SvelteDevKit enableMcp />' : '<SvelteDevKit />'} ` +
						"(import { SvelteDevKit } from 'svelte-grab') to your root component"
				);
				return false;
			}
			const injected = injectAppSvelte(content, layoutOptions);
			report.layout = injected.changed ? 'written' : 'already-present';
			return injected.changed ? injected.content : false;
		});
	}

	// 4. Agent skills: same planner as `svelte-grab init` (src/cli/skills-plan.ts),
	// one install (and manifest, <dir>/.svelte-grab-skills.json) per agent dir:
	// unedited files from an older version are updated in place, edited ones
	// get a <file>.new.
	// sv.file passes '' for a missing file, so an empty file reads as missing
	// (for a manifest too: it is then treated as absent and rewritten).
	// Returning false leaves the file untouched.
	const read = (path: string): string | null => {
		let current: string | null = null;
		ctx.sv.file(path, (content) => {
			current = content === '' ? null : content;
			return false;
		});
		return current;
	};
	const skillFiles = options.skills ? (ctx.skillFiles ?? packagedSkillFiles()) : null;
	if (options.skills && !skillFiles) {
		report.notes.push(
			'The svelte-grab package has no skills/ folder: run `npx svelte-grab skills install` once it is installed'
		);
	}
	const skillsDirs = skillFiles
		? [AGENT_SKILLS_DIRS.claude, ...(options.codex ? [AGENT_SKILLS_DIRS.codex] : [])]
		: [];
	const skillNames: string[] = [];
	for (const skillsDir of skillsDirs) {
		// sv's file API cannot delete: files no longer shipped stay (as `obsolete`,
		// still in the manifest) and are listed in nextSteps instead.
		const plan = planSkillsInstall(skillFiles!, read, {
			skillsDir,
			version: ctx.skillsVersion ?? packageVersion() ?? 'unknown',
			removeObsolete: false
		});
		for (const name of plan.skills) if (!skillNames.includes(name)) skillNames.push(name);
		for (const write of plan.writes) {
			ctx.sv.file(write.path, () => write.content);
			report.skillsWritten.push(write.path);
		}
		const conflicts = plan.files.filter((f) => f.action === 'conflict');
		if (conflicts.length) {
			report.notes.push(
				`${conflicts.length} skill file(s) in ${skillsDir}/ differ from this version (edited?): ` +
					'the new version is next to each as <file>.new; merge it or run `npx svelte-grab skills install --force`'
			);
		}
		const leftovers = plan.files.filter((f) => f.action === 'obsolete' || f.action === 'orphaned');
		if (leftovers.length) {
			report.notes.push(
				`No longer shipped by svelte-grab, delete when done: ${leftovers.map((f) => f.path).join(', ')} ` +
					'(`npx svelte-grab skills install` removes the ones you did not edit)'
			);
		}
	}

	// 4b. AGENTS.md section (created for Codex, else only appended to an existing
	// file) and a pointer in an existing CLAUDE.md, as in `svelte-grab init`.
	const sectionDirs = [...skillsDirs].reverse();
	ctx.sv.file('AGENTS.md', (content) => {
		const agents = upsertAgentsMd(content || null, {
			skillsDirs: sectionDirs,
			skills: skillNames,
			create: options.codex
		});
		report.agentsMd = agents.action;
		return agents.action === 'created' || agents.action === 'appended' ? agents.content : false;
	});
	if (report.agentsMd !== 'absent') {
		ctx.sv.file('CLAUDE.md', (content) => {
			const claude = appendClaudeMdPointer(
				content || null,
				skillsDirs.includes(AGENT_SKILLS_DIRS.claude) ? AGENT_SKILLS_DIRS.claude : null
			);
			report.claudeMd = claude.action;
			return claude.action === 'appended' ? claude.content : false;
		});
	}

	// 5. Dev dependencies
	const wanted: (keyof typeof DEV_DEPENDENCIES)[] = ['svelte-grab'];
	if (report.enableMcp) wanted.push('@modelcontextprotocol/sdk', 'zod');
	for (const pkg of wanted) {
		if (ctx.dependencyVersion?.(pkg)) continue;
		ctx.sv.devDependency(pkg, DEV_DEPENDENCIES[pkg]);
		report.devDependencies.push(pkg);
	}

	return report;
}

/** Lines for sv's `nextSteps`. */
export function nextStepsFor(report: AddonReport | undefined): string[] {
	const steps: string[] = [];
	if (report?.notes.length) steps.push(...report.notes);
	steps.push('Start the dev server and open the app; svelte-grab only runs in dev builds');
	if (report?.enableMcp) {
		steps.push('Restart your agent so it loads the MCP config, then ask it to call ui_snapshot');
	}
	if (report?.codexServersAdded.length) {
		steps.push(
			`Codex reads ${CODEX_CONFIG_PATH} only in trusted projects: trust this folder when Codex asks (check with \`codex mcp list\`)`
		);
	}
	steps.push('Docs: https://github.com/HeiCg/svelte-grab#readme');
	return steps;
}

/** The skills shipped in the package's own `skills/` folder, or null when it is missing. */
export function packagedSkillFiles(): SkillFile[] | null {
	const dir = packagedSkillsDir();
	return dir ? readSkillFiles(dir) : null;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
