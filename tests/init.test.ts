import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { init, parseInitArgs } from '../src/cli/init.js';

const KIT_VITE = `import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()]
});
`;

const PLAIN_VITE = `import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [svelte()]
});
`;

let dir: string;

function write(rel: string, content: string) {
	const path = join(dir, rel);
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, content, 'utf-8');
}

function read(rel: string): string {
	return readFileSync(join(dir, rel), 'utf-8');
}

/** Snapshot of every file under the temp project (path -> content). */
function tree(): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			if (statSync(p).isDirectory()) walk(p);
			else out[relative(dir, p)] = readFileSync(p, 'utf-8');
		}
	};
	walk(dir);
	return out;
}

function kitProject(deps: Record<string, string> = {}) {
	write(
		'package.json',
		JSON.stringify({ devDependencies: { '@sveltejs/kit': '^2.20.0', svelte: '^5.40.0', ...deps } }, null, 2)
	);
	write('vite.config.ts', KIT_VITE);
}

function viteProject() {
	write('package.json', JSON.stringify({ devDependencies: { svelte: '^5.40.0' } }, null, 2));
	write('vite.config.js', PLAIN_VITE);
	write('src/App.svelte', '<script>\n\tlet n = 1;\n</script>\n\n<p>{n}</p>\n');
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'sg-init-'));
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

describe('parseInitArgs', () => {
	it('defaults: .mcp.json with Svelte MCP, no Playwright, vite plugin on', () => {
		expect(parseInitArgs([])).toEqual({
			dryRun: false,
			mcpJson: true,
			svelteMcp: true,
			playwrightMcp: false,
			vitePlugin: true
		});
	});

	it('reads every flag', () => {
		expect(
			parseInitArgs(['--dry-run', '--no-mcp-json', '--no-svelte-mcp', '--with-playwright-mcp', '--no-vite-plugin'])
		).toEqual({ dryRun: true, mcpJson: false, svelteMcp: false, playwrightMcp: true, vitePlugin: false });
		expect(parseInitArgs(['--with-svelte-mcp=false', '--with-playwright-mcp=true'])).toMatchObject({
			svelteMcp: false,
			playwrightMcp: true
		});
		expect(parseInitArgs(['--with-svelte-mcp'])).toMatchObject({ svelteMcp: true });
	});
});

describe('init: SvelteKit', () => {
	it('writes .mcp.json, the vite plugin and a layout with enableMcp', () => {
		kitProject();
		const result = init(dir);

		expect(result.ok).toBe(true);
		expect(result.enableMcp).toBe(true);
		expect(result.mcpServersAdded).toEqual(['svelte-grab', 'svelte']);
		expect(result.vitePlugin).toBe('added');
		expect(result.layout).toBe('created');
		expect(result.written.sort()).toEqual(['.mcp.json', 'src/routes/+layout.svelte', 'vite.config.ts']);

		const mcp = JSON.parse(read('.mcp.json'));
		expect(mcp.mcpServers['svelte-grab']).toEqual({ type: 'stdio', command: 'npx', args: ['svelte-grab-mcp', '--stdio'] });
		expect(mcp.mcpServers.svelte.args).toEqual(['-y', '@sveltejs/mcp']);
		expect(mcp.mcpServers.playwright).toBeUndefined();

		expect(read('vite.config.ts')).toContain("import { svelteGrab } from 'svelte-grab/vite';");
		expect(read('vite.config.ts')).toContain('plugins: [sveltekit(), svelteGrab()]');

		const layout = read('src/routes/+layout.svelte');
		expect(layout).toContain("import { dev } from '$app/environment';");
		expect(layout).toContain('<SvelteDevKit enableMcp />');
	});

	it('is idempotent: a second run changes nothing', () => {
		kitProject();
		init(dir, { playwrightMcp: true });
		const before = tree();
		const second = init(dir, { playwrightMcp: true });
		expect(second.ok).toBe(true);
		expect(second.written).toEqual([]);
		expect(second.mcpServersAdded).toEqual([]);
		expect(second.vitePlugin).toBe('already-present');
		expect(second.layout).toBe('already-present');
		expect(tree()).toEqual(before);
	});

	it('merges into an existing .mcp.json without clobbering entries', () => {
		kitProject();
		write('.mcp.json', JSON.stringify({ mcpServers: { svelte: { type: 'http', url: 'https://mcp.svelte.dev/mcp' } } }, null, 2));
		const result = init(dir, { playwrightMcp: true });
		expect(result.mcpServersAdded).toEqual(['svelte-grab', 'playwright']);
		const mcp = JSON.parse(read('.mcp.json'));
		expect(mcp.mcpServers.svelte).toEqual({ type: 'http', url: 'https://mcp.svelte.dev/mcp' });
		expect(mcp.mcpServers.playwright.args).toEqual(['-y', '@playwright/mcp@latest']);
	});

	it('keeps an existing svelte-grab server and still enables MCP in the layout', () => {
		kitProject();
		const custom = { mcpServers: { 'svelte-grab': { command: 'node', args: ['dist/mcp/cli.js', '--stdio'] } } };
		write('.mcp.json', JSON.stringify(custom, null, 2));
		const result = init(dir, { svelteMcp: false });
		expect(result.mcpServersAdded).toEqual([]);
		expect(result.written).not.toContain('.mcp.json');
		expect(JSON.parse(read('.mcp.json'))).toEqual(custom);
		expect(result.enableMcp).toBe(true);
		expect(read('src/routes/+layout.svelte')).toContain('<SvelteDevKit enableMcp />');
	});

	it('leaves an invalid .mcp.json alone, warns and does not enable MCP', () => {
		kitProject();
		write('.mcp.json', '{ broken');
		const result = init(dir);
		expect(result.ok).toBe(true);
		expect(read('.mcp.json')).toBe('{ broken');
		expect(result.enableMcp).toBe(false);
		expect(read('src/routes/+layout.svelte')).toContain('<SvelteDevKit />');
		expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toMatch(/not valid JSON/);
	});

	it('--no-mcp-json: no .mcp.json and no enableMcp', () => {
		kitProject();
		const result = init(dir, { mcpJson: false });
		expect(existsSync(join(dir, '.mcp.json'))).toBe(false);
		expect(result.enableMcp).toBe(false);
		expect(read('src/routes/+layout.svelte')).toContain('<SvelteDevKit />');
		expect(read('src/routes/+layout.svelte')).not.toContain('enableMcp');
	});

	it('--no-vite-plugin leaves vite.config untouched', () => {
		kitProject();
		const result = init(dir, { vitePlugin: false });
		expect(result.vitePlugin).toBe('skipped');
		expect(read('vite.config.ts')).toBe(KIT_VITE);
	});

	it('prints manual instructions when the vite config shape is unknown', () => {
		kitProject();
		const custom = 'export default defineConfig(() => ({ plugins: makePlugins() }));\n';
		write('vite.config.ts', custom);
		const result = init(dir);
		expect(result.vitePlugin).toBe('manual');
		expect(read('vite.config.ts')).toBe(custom);
		expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain("import { svelteGrab } from 'svelte-grab/vite'");
	});

	it('reports a missing vite config', () => {
		write('package.json', JSON.stringify({ devDependencies: { '@sveltejs/kit': '^2.0.0', svelte: '^5.40.0' } }));
		expect(init(dir).vitePlugin).toBe('missing');
	});

	it('injects into an existing layout', () => {
		kitProject();
		write('src/routes/+layout.svelte', '<script lang="ts">\n\tlet { children } = $props();\n</script>\n\n{@render children()}\n');
		const result = init(dir);
		expect(result.layout).toBe('modified');
		const layout = read('src/routes/+layout.svelte');
		expect(layout).toContain("<script lang=\"ts\">\n\timport { dev } from '$app/environment';");
		expect(layout.trimEnd().endsWith('{#if dev}\n\t<SvelteDevKit enableMcp />\n{/if}')).toBe(true);
	});

	it('hints at enableMcp when svelte-grab is already in the layout without it', () => {
		kitProject();
		const layout = "<script>\n\timport { SvelteDevKit } from 'svelte-grab';\n</script>\n\n<SvelteDevKit />\n";
		write('src/routes/+layout.svelte', layout);
		const result = init(dir);
		expect(result.layout).toBe('already-present');
		expect(read('src/routes/+layout.svelte')).toBe(layout);
		expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('enableMcp');
	});

	it('--dry-run writes nothing but reports the same plan', () => {
		kitProject();
		const before = tree();
		const result = init(dir, { dryRun: true });
		expect(tree()).toEqual(before);
		expect(result.written).toEqual([]);
		expect(result.enableMcp).toBe(true);
		expect(result.vitePlugin).toBe('added');
		expect(result.layout).toBe('created');
		const out = vi.mocked(console.log).mock.calls.flat().join('\n');
		expect(out).toContain('Would write .mcp.json');
		expect(out).toContain('svelte-grab-mcp');
	});

	it('lists missing dev dependencies with an install command', () => {
		kitProject();
		write('pnpm-lock.yaml', '');
		init(dir);
		const out = vi.mocked(console.log).mock.calls.flat().join('\n');
		expect(out).toContain('pnpm add -D svelte-grab @modelcontextprotocol/sdk zod');
	});

	it('does not list dependencies that are already installed', () => {
		kitProject({ 'svelte-grab': '^2.0.0', '@modelcontextprotocol/sdk': '^1.26.0', zod: '^4.0.0' });
		init(dir);
		const out = vi.mocked(console.log).mock.calls.flat().join('\n');
		expect(out).not.toContain('add -D');
		expect(out).not.toContain('install -D');
	});
});

describe('init: plain Vite + Svelte', () => {
	it('injects into src/App.svelte and vite.config.js', () => {
		viteProject();
		const result = init(dir);
		expect(result.ok).toBe(true);
		expect(result.layout).toBe('modified');
		expect(read('src/App.svelte')).toContain("import { SvelteDevKit } from 'svelte-grab';");
		expect(read('src/App.svelte').trimEnd().endsWith('<SvelteDevKit enableMcp />')).toBe(true);
		expect(read('vite.config.js')).toContain('plugins: [svelte(), svelteGrab()]');
	});

	it('prints manual instructions without src/App.svelte', () => {
		write('package.json', JSON.stringify({ dependencies: { svelte: '^5.40.0' } }));
		write('vite.config.js', PLAIN_VITE);
		const result = init(dir);
		expect(result.layout).toBe('manual');
		expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('<SvelteDevKit enableMcp />');
	});
});

describe('init: errors', () => {
	it('fails without package.json', () => {
		const result = init(dir);
		expect(result.ok).toBe(false);
		expect(tree()).toEqual({});
	});

	it('fails when svelte is not a dependency', () => {
		write('package.json', JSON.stringify({ dependencies: { react: '^19.0.0' } }));
		expect(init(dir).ok).toBe(false);
		expect(existsSync(join(dir, '.mcp.json'))).toBe(false);
	});

	it('fails below Svelte 5', () => {
		write('package.json', JSON.stringify({ devDependencies: { svelte: '^4.2.0' } }));
		expect(init(dir).ok).toBe(false);
	});

	it('warns but continues for Svelte 5 below 5.35.1', () => {
		write('package.json', JSON.stringify({ devDependencies: { '@sveltejs/kit': '^2.0.0', svelte: '^5.20.0' } }));
		expect(init(dir).ok).toBe(true);
		expect(vi.mocked(console.warn).mock.calls.flat().join('\n')).toContain('5.35.1');
	});
});
