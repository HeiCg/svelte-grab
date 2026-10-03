import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SKILL_FILES, SKILLS_VERSION } from '../packages/sv-addon/src/skills.generated.js';
import { readSkillFiles } from '../src/utils/packaged-skills.js';
import { AGENTS_MD_MARKER, type SkillFile } from '../src/cli/skills-plan.js';

const MANIFEST = '.claude/skills/.svelte-grab-skills.json';
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
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
		expect(ws.touched).toEqual([
			'.mcp.json',
			'vite.config.ts',
			'src/routes/+layout.svelte',
			...SKILL_FILES.map((f) => `.claude/skills/${f.path}`),
			MANIFEST
		]);

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

describe('sv add-on: agent skills', () => {
	const KIT = { 'vite.config.ts': SV_KIT_VITE, 'src/routes/+layout.svelte': SV_KIT_LAYOUT };

	it('embeds the current skills/ folder (rerun packages/sv-addon/scripts/embed-skills.mjs if this fails)', () => {
		const root = fileURLToPath(new URL('../skills/', import.meta.url));
		expect(SKILL_FILES).toEqual(readSkillFiles(root));
		expect(SKILL_FILES.map((f) => f.skill)).toContain('svelte-grab-audit');
		const generated = readFileSync(new URL('../packages/sv-addon/src/skills.generated.ts', import.meta.url), 'utf-8');
		expect(generated.startsWith('// Generated by packages/sv-addon/scripts/embed-skills.mjs')).toBe(true);
		// The version is informational (manifest only), so a release bump without a rebuild is not an error.
		expect(SKILLS_VERSION).toMatch(/^\d+\.\d+\.\d+/);
	});

	it('installs the skills into .claude/skills by default (same planner as init), with the manifest', () => {
		const ws = fakeWorkspace(KIT);
		const report = runSvelteGrabAddon(ws.ctx);
		expect(report.skillsWritten).toEqual([...SKILL_FILES.map((f) => `.claude/skills/${f.path}`), MANIFEST]);
		for (const f of SKILL_FILES) expect(ws.fs[`.claude/skills/${f.path}`]).toBe(f.content);
		expect(JSON.parse(ws.fs[MANIFEST])).toEqual({
			version: SKILLS_VERSION,
			files: Object.fromEntries(SKILL_FILES.map((f) => [f.path, sha256(f.content)]))
		});
		expect(ws.fs['AGENTS.md']).toBeUndefined();
	});

	describe('upgrades through sv.file (manifest read and written like any file)', () => {
		const V1: SkillFile[] = [
			{ skill: 'svelte-grab', path: 'svelte-grab/SKILL.md', content: 'core v1' },
			{ skill: 'svelte-grab', path: 'svelte-grab/notes.md', content: 'notes v1' },
			{ skill: 'svelte-grab', path: 'svelte-grab/old.md', content: 'old v1' }
		];
		const V2: SkillFile[] = [
			{ skill: 'svelte-grab', path: 'svelte-grab/SKILL.md', content: 'core v2' },
			{ skill: 'svelte-grab', path: 'svelte-grab/notes.md', content: 'notes v2' }
		];
		const run = (ws: ReturnType<typeof fakeWorkspace>, files: SkillFile[], version: string) => {
			ws.ctx.skillFiles = files;
			ws.ctx.skillsVersion = version;
			ws.touched.length = 0;
			return runSvelteGrabAddon(ws.ctx);
		};

		it('updates unedited files in place, writes <file>.new for edited ones, reports what it cannot delete', () => {
			const ws = fakeWorkspace(KIT);
			run(ws, V1, '1.0.0');
			expect(JSON.parse(ws.fs[MANIFEST]).version).toBe('1.0.0');
			ws.fs['.claude/skills/svelte-grab/notes.md'] = 'notes v1, mine';

			const report = run(ws, V2, '2.0.0');
			expect(report.skillsWritten).toEqual([
				'.claude/skills/svelte-grab/SKILL.md',
				'.claude/skills/svelte-grab/notes.md.new',
				MANIFEST
			]);
			expect(ws.fs['.claude/skills/svelte-grab/SKILL.md']).toBe('core v2');
			expect(ws.fs['.claude/skills/svelte-grab/notes.md']).toBe('notes v1, mine');
			expect(ws.fs['.claude/skills/svelte-grab/notes.md.new']).toBe('notes v2');
			// sv cannot delete: the obsolete file stays, stays in the manifest, and nextSteps names it.
			expect(ws.fs['.claude/skills/svelte-grab/old.md']).toBe('old v1');
			expect(JSON.parse(ws.fs[MANIFEST])).toEqual({
				version: '2.0.0',
				files: {
					'svelte-grab/SKILL.md': sha256('core v2'),
					'svelte-grab/notes.md': sha256('notes v1'),
					'svelte-grab/old.md': sha256('old v1')
				}
			});
			const steps = nextStepsFor(report).join('\n');
			expect(steps).toContain('<file>.new');
			expect(steps).toContain('No longer shipped by svelte-grab, delete when done: .claude/skills/svelte-grab/old.md');

			// Idempotent.
			const snapshot = { ...ws.fs };
			run(ws, V2, '2.0.0');
			expect(ws.touched).toEqual([]);
			expect(ws.fs).toEqual(snapshot);
		});

		it('an empty manifest file reads as missing and is rewritten', () => {
			const ws = fakeWorkspace({ ...KIT, '.claude/skills/svelte-grab/SKILL.md': 'core v1', [MANIFEST]: '' });
			const report = run(ws, V2, '2.0.0');
			expect(report.skillsWritten).toContain('.claude/skills/svelte-grab/SKILL.md.new');
			expect(JSON.parse(ws.fs[MANIFEST]).version).toBe('2.0.0');
		});
	});

	it('skills: false skips them', () => {
		const ws = fakeWorkspace(KIT, { options: { skills: false } });
		const report = runSvelteGrabAddon(ws.ctx);
		expect(report.skillsWritten).toEqual([]);
		expect(Object.keys(ws.fs).some((p) => p.startsWith('.claude/'))).toBe(false);
	});

	it('keeps an edited skill file, writes <file>.new and says so in nextSteps', () => {
		const rel = '.claude/skills/svelte-grab/SKILL.md';
		const ws = fakeWorkspace({ ...KIT, [rel]: 'my notes\n' });
		const report = runSvelteGrabAddon(ws.ctx);
		expect(ws.fs[rel]).toBe('my notes\n');
		expect(ws.fs[`${rel}.new`]).toBe(SKILL_FILES.find((f) => f.path === 'svelte-grab/SKILL.md')!.content);
		expect(report.skillsWritten).toContain(`${rel}.new`);
		expect(nextStepsFor(report).join('\n')).toContain('<file>.new');
	});

	it('points an existing AGENTS.md at the skills once', () => {
		const ws = fakeWorkspace({ ...KIT, 'AGENTS.md': '# Rules\n' });
		runSvelteGrabAddon(ws.ctx);
		expect(ws.fs['AGENTS.md']).toContain(AGENTS_MD_MARKER);
		expect(ws.fs['AGENTS.md']).toContain('.claude/skills/svelte-grab-audit/SKILL.md');
		const once = ws.fs['AGENTS.md'];
		ws.touched.length = 0;
		runSvelteGrabAddon(ws.ctx);
		expect(ws.fs['AGENTS.md']).toBe(once);
		expect(ws.touched).toEqual([]);
	});

	it('takes skill files from the context when given', () => {
		const ws = fakeWorkspace(KIT, {});
		ws.ctx.skillFiles = [{ skill: 'x', path: 'x/SKILL.md', content: 'X' }];
		expect(runSvelteGrabAddon(ws.ctx).skillsWritten).toEqual(['.claude/skills/x/SKILL.md', MANIFEST]);
	});
});
