import { describe, it, expect } from 'vitest';
import {
	runSvelteGrabAddon,
	nextStepsFor,
	DEV_DEPENDENCIES,
	type AddonRunContext,
	type SvelteGrabAddonOptions
} from '../packages/sv-addon/src/plan.js';

/**
 * In-memory stand-in for sv's `run()` context: `sv.file` runs the edit
 * synchronously like sv's engine does (content '' for a missing file, `false`
 * leaves the file as is).
 */
function fakeWorkspace(
	files: Record<string, string>,
	opts: { isKit?: boolean; language?: 'ts' | 'js'; deps?: Record<string, string>; options?: Partial<SvelteGrabAddonOptions> } = {}
) {
	const fs = { ...files };
	const devDeps: Record<string, string> = {};
	const touched: string[] = [];
	const ctx: AddonRunContext = {
		sv: {
			file(path, edit) {
				const next = edit(fs[path] ?? '');
				if (next !== false) {
					fs[path] = next;
					touched.push(path);
				}
			},
			devDependency(pkg, version) {
				devDeps[pkg] = version;
			}
		},
		options: opts.options ?? {},
		isKit: opts.isKit ?? true,
		language: opts.language ?? 'ts',
		file: { viteConfig: 'vite.config.ts' },
		directory: { src: 'src', kitRoutes: 'src/routes' },
		dependencyVersion: (pkg) => opts.deps?.[pkg]
	};
	return { ctx, fs, devDeps, touched };
}

const SV_KIT_VITE = `import adapter from '@sveltejs/adapter-auto';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			adapter: adapter()
		})
	]
});
`;

const SV_KIT_LAYOUT = `<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
`;

describe('sv add-on (runSvelteGrabAddon)', () => {
	it('sets up a fresh `sv create` Kit project with the defaults', () => {
		const ws = fakeWorkspace({ 'vite.config.ts': SV_KIT_VITE, 'src/routes/+layout.svelte': SV_KIT_LAYOUT });
		const report = runSvelteGrabAddon(ws.ctx);

		expect(report.enableMcp).toBe(true);
		expect(report.mcpServersAdded).toEqual(['svelte-grab', 'svelte']);
		expect(report.vitePlugin).toBe('added');
		expect(report.layout).toBe('written');
		expect(ws.touched).toEqual(['.mcp.json', 'vite.config.ts', 'src/routes/+layout.svelte']);

		const mcp = JSON.parse(ws.fs['.mcp.json']);
		expect(Object.keys(mcp.mcpServers)).toEqual(['svelte-grab', 'svelte']);
		expect(ws.fs['vite.config.ts']).toContain("import { svelteGrab } from 'svelte-grab/vite';");
		expect(ws.fs['vite.config.ts']).toContain('\t\t}),\n\t\tsvelteGrab()\n\t]');
		expect(ws.fs['src/routes/+layout.svelte']).toContain("import { dev } from '$app/environment';");
		expect(ws.fs['src/routes/+layout.svelte']).toContain('{#if dev}\n\t<SvelteDevKit enableMcp />\n{/if}');

		expect(ws.devDeps).toEqual(DEV_DEPENDENCIES);
	});

	it('creates the layout (lang="ts") when the project has none', () => {
		const ws = fakeWorkspace({ 'vite.config.ts': SV_KIT_VITE });
		runSvelteGrabAddon(ws.ctx);
		expect(ws.fs['src/routes/+layout.svelte'].startsWith('<script lang="ts">')).toBe(true);
	});

	it('is idempotent', () => {
		const ws = fakeWorkspace({ 'vite.config.ts': SV_KIT_VITE, 'src/routes/+layout.svelte': SV_KIT_LAYOUT });
		runSvelteGrabAddon(ws.ctx);
		const snapshot = { ...ws.fs };
		ws.touched.length = 0;
		const second = runSvelteGrabAddon(ws.ctx);
		expect(ws.touched).toEqual([]);
		expect(ws.fs).toEqual(snapshot);
		expect(second.vitePlugin).toBe('already-present');
		expect(second.layout).toBe('already-present');
		expect(second.enableMcp).toBe(true);
	});

	it('honours the options: no .mcp.json, no vite plugin', () => {
		const ws = fakeWorkspace(
			{ 'vite.config.ts': SV_KIT_VITE },
			{ options: { mcpJson: false, svelteMcp: undefined, playwrightMcp: undefined, vitePlugin: false } }
		);
		const report = runSvelteGrabAddon(ws.ctx);
		expect(ws.fs['.mcp.json']).toBeUndefined();
		expect(ws.fs['vite.config.ts']).toBe(SV_KIT_VITE);
		expect(report.enableMcp).toBe(false);
		expect(ws.fs['src/routes/+layout.svelte']).toContain('<SvelteDevKit />');
		expect(ws.devDeps).toEqual({ 'svelte-grab': DEV_DEPENDENCIES['svelte-grab'] });
	});

	it('adds playwright, keeps existing servers and skips installed deps', () => {
		const existing = JSON.stringify({ mcpServers: { svelte: { type: 'http', url: 'https://mcp.svelte.dev/mcp' } } }, null, '\t');
		const ws = fakeWorkspace(
			{ '.mcp.json': existing, 'vite.config.ts': SV_KIT_VITE },
			{ options: { playwrightMcp: true }, deps: { 'svelte-grab': '2.0.0', zod: '4.1.0' } }
		);
		const report = runSvelteGrabAddon(ws.ctx);
		expect(report.mcpServersAdded).toEqual(['svelte-grab', 'playwright']);
		const mcp = JSON.parse(ws.fs['.mcp.json']);
		expect(mcp.mcpServers.svelte).toEqual({ type: 'http', url: 'https://mcp.svelte.dev/mcp' });
		expect(Object.keys(ws.devDeps)).toEqual(['@modelcontextprotocol/sdk']);
	});

	it('leaves an invalid .mcp.json alone and reports it', () => {
		const ws = fakeWorkspace({ '.mcp.json': '{ nope', 'vite.config.ts': SV_KIT_VITE });
		const report = runSvelteGrabAddon(ws.ctx);
		expect(ws.fs['.mcp.json']).toBe('{ nope');
		expect(report.enableMcp).toBe(false);
		expect(nextStepsFor(report).join('\n')).toMatch(/not valid JSON/);
	});

	it('reports a vite config it cannot edit in nextSteps', () => {
		const custom = 'export default defineConfig(() => ({ plugins: plugins() }));\n';
		const ws = fakeWorkspace({ 'vite.config.ts': custom });
		const report = runSvelteGrabAddon(ws.ctx);
		expect(report.vitePlugin).toBe('manual');
		expect(ws.fs['vite.config.ts']).toBe(custom);
		expect(nextStepsFor(report).join('\n')).toContain('svelte-grab/vite');
	});

	it('plain Vite + Svelte: edits src/App.svelte, or asks for a manual step without it', () => {
		const vite = "import { svelte } from '@sveltejs/vite-plugin-svelte';\nexport default { plugins: [svelte()] };\n";
		const withApp = fakeWorkspace({ 'vite.config.ts': vite, 'src/App.svelte': '<h1>hi</h1>\n' }, { isKit: false });
		expect(runSvelteGrabAddon(withApp.ctx).layout).toBe('written');
		expect(withApp.fs['src/App.svelte']).toContain('<SvelteDevKit enableMcp />');
		expect(withApp.fs['vite.config.ts']).toContain('plugins: [svelte(), svelteGrab()]');

		const noApp = fakeWorkspace({ 'vite.config.ts': vite }, { isKit: false });
		const report = runSvelteGrabAddon(noApp.ctx);
		expect(report.layout).toBe('manual');
		expect(noApp.fs['src/App.svelte']).toBeUndefined();
		expect(nextStepsFor(report).join('\n')).toContain('<SvelteDevKit enableMcp />');
	});
});
