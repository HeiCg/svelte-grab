/**
 * `sv` community add-on for svelte-grab: `npx sv add @svelte-grab`.
 *
 * Does what `npx svelte-grab init` does: svelte-grab dev dependency, `.mcp.json`
 * (svelte-grab + optional @sveltejs/mcp and @playwright/mcp), `svelteGrab()` in
 * the Vite config and `<SvelteDevKit />` in the root layout.
 */
import { defineAddon, defineAddonOptions } from 'sv';
import { ADDON_ID, DEFAULT_OPTIONS, nextStepsFor, runSvelteGrabAddon, type AddonReport } from './plan.js';

const options = defineAddonOptions()
	.add('mcpJson', {
		question: 'Write .mcp.json so your coding agent starts the svelte-grab MCP server?',
		type: 'boolean',
		default: DEFAULT_OPTIONS.mcpJson
	})
	.add('svelteMcp', {
		question: 'Also add the official Svelte MCP (@sveltejs/mcp: docs + autofixer)?',
		type: 'boolean',
		default: DEFAULT_OPTIONS.svelteMcp,
		condition: ({ mcpJson }) => mcpJson === true
	})
	.add('playwrightMcp', {
		question: 'Also add Playwright MCP (@playwright/mcp: real clicks, screenshots, viewports)?',
		type: 'boolean',
		default: DEFAULT_OPTIONS.playwrightMcp,
		condition: ({ mcpJson }) => mcpJson === true
	})
	.add('vitePlugin', {
		question: 'Add the svelte-grab Vite plugin (HMR file list, importers, open-in-editor)?',
		type: 'boolean',
		default: DEFAULT_OPTIONS.vitePlugin
	})
	.build();

// nextSteps runs after run(); keep the report to tell the user about manual steps.
let lastReport: AddonReport | undefined;

export default defineAddon({
	id: ADDON_ID,
	shortDescription: 'give coding agents eyes into your Svelte app',
	homepage: 'https://github.com/HeiCg/svelte-grab',
	options,

	run: ({ sv, options, isKit, language, file, directory, dependencyVersion }) => {
		lastReport = runSvelteGrabAddon({ sv, options, isKit, language, file, directory, dependencyVersion });
	},

	nextSteps: () => nextStepsFor(lastReport)
});
