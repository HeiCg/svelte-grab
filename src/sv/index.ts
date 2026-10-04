/**
 * `sv` community add-on for svelte-grab: `npx sv add svelte-grab`.
 *
 * Does what `npx svelte-grab init` does: svelte-grab dev dependency, `.mcp.json`
 * (svelte-grab + optional @sveltejs/mcp and @playwright/mcp), `svelteGrab()` in
 * the Vite config, `<SvelteDevKit />` in the root layout, the agent skills in
 * `.claude/skills/` and, with the `codex` option (default yes), the same for
 * OpenAI Codex: `.codex/config.toml`, `.agents/skills/` and AGENTS.md.
 *
 * sv (1.x) loads it as the `./sv` export of the svelte-grab package: it unpacks
 * the npm tarball into its own node_modules (no dependency install) and
 * `import('svelte-grab/sv')`s the default export. package.json must list `sv`
 * in peerDependencies (sv refuses the package otherwise; optional here, so
 * regular svelte-grab installs do not pull it in).
 *
 * No runtime import from `sv`: `defineAddon` and `defineAddonOptions` only
 * return the object they are given, and importing `sv` would fail with
 * `sv add file:<path>`, where Node resolves the symlinked add-on from its real
 * path, outside sv's node_modules. The shape below follows sv's `Addon` type.
 */
import {
	ADDON_ID,
	DEFAULT_OPTIONS,
	nextStepsFor,
	runSvelteGrabAddon,
	type AddonReport,
	type AddonRunContext,
	type SvelteGrabAddonOptions
} from './plan.js';

/** sv's boolean question (`defineAddonOptions().add(key, question)`). */
export interface SvBooleanQuestion {
	question: string;
	type: 'boolean';
	default: boolean;
	/** Asked only when this returns true; otherwise the answer is undefined. */
	condition?: (answers: Partial<SvelteGrabAddonOptions>) => boolean;
}

/** The subset of sv's `Addon` definition this add-on uses. */
export interface SvelteGrabSvAddon {
	id: string;
	shortDescription: string;
	homepage: string;
	options: Record<keyof SvelteGrabAddonOptions, SvBooleanQuestion>;
	run: (workspace: AddonRunContext) => void;
	nextSteps: () => string[];
}

const options: SvelteGrabSvAddon['options'] = {
	mcpJson: {
		question:
			'Write the MCP config so your coding agent starts the svelte-grab MCP server (.mcp.json; .codex/config.toml for Codex)?',
		type: 'boolean',
		default: DEFAULT_OPTIONS.mcpJson
	},
	svelteMcp: {
		question: 'Also add the official Svelte MCP (@sveltejs/mcp: docs + autofixer)?',
		type: 'boolean',
		default: DEFAULT_OPTIONS.svelteMcp,
		condition: ({ mcpJson }) => mcpJson === true
	},
	playwrightMcp: {
		question: 'Also add Playwright MCP (@playwright/mcp: real clicks, screenshots, viewports)?',
		type: 'boolean',
		default: DEFAULT_OPTIONS.playwrightMcp,
		condition: ({ mcpJson }) => mcpJson === true
	},
	vitePlugin: {
		question: 'Add the svelte-grab Vite plugin (HMR file list, importers, open-in-editor)?',
		type: 'boolean',
		default: DEFAULT_OPTIONS.vitePlugin
	},
	skills: {
		question:
			'Install the svelte-grab agent skills into .claude/skills/ (UI loop + security/performance audit)?',
		type: 'boolean',
		default: DEFAULT_OPTIONS.skills
	},
	codex: {
		question:
			'Also set up OpenAI Codex (.codex/config.toml, skills in .agents/skills/, AGENTS.md section)?',
		type: 'boolean',
		default: DEFAULT_OPTIONS.codex
	}
};

// nextSteps runs after run(); keep the report to tell the user about manual steps.
let lastReport: AddonReport | undefined;

const addon: SvelteGrabSvAddon = {
	id: ADDON_ID,
	shortDescription: 'give coding agents eyes into your Svelte app',
	homepage: 'https://github.com/HeiCg/svelte-grab',
	options,

	run: ({ sv, options, isKit, language, file, directory, dependencyVersion }) => {
		lastReport = runSvelteGrabAddon({
			sv,
			options,
			isKit,
			language,
			file,
			directory,
			dependencyVersion
		});
	},

	nextSteps: () => nextStepsFor(lastReport)
};

export default addon;
