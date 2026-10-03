import { describe, it, expect } from 'vitest';
import {
	injectKitLayout,
	injectAppSvelte,
	injectVitePlugin,
	mergeMcpJson,
	devKitMissingEnableMcp,
	MCP_SERVERS,
	lineDiff
} from '../src/cli/transforms.js';

// The vite.config.ts that `sv create` (sv 1.0) writes: the Kit config lives
// inside the sveltekit() call, spread over several lines.
const SV_VITE_CONFIG = `import adapter from '@sveltejs/adapter-auto';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// 1) force runes mode; a stray ")" in a comment or "string)" is ignored
				runes: ({ filename }) =>
					filename.split(/[/\\\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		})
	]
});
`;

describe('injectVitePlugin', () => {
	it('adds the import and svelteGrab() after a multi-line sveltekit() call', () => {
		const result = injectVitePlugin(SV_VITE_CONFIG);
		expect(result.status).toBe('added');
		expect(result.changed).toBe(true);
		expect(result.content).toContain(
			"import { defineConfig } from 'vite';\nimport { svelteGrab } from 'svelte-grab/vite';\n"
		);
		expect(result.content).toContain('\t\t\tadapter: adapter()\n\t\t}),\n\t\tsvelteGrab()\n\t]');
	});

	it('adds svelteGrab() after an inline svelte() call', () => {
		const input = `import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
});
`;
		const result = injectVitePlugin(input);
		expect(result.status).toBe('added');
		expect(result.content).toContain('plugins: [svelte(), svelteGrab()],');
		expect(result.content).toContain("import { svelteGrab } from 'svelte-grab/vite';");
	});

	it('keeps a trailing comma and following plugins in place', () => {
		const input = `import { sveltekit } from '@sveltejs/kit/vite';
export default {
	plugins: [
		sveltekit(),
		other()
	]
};
`;
		const result = injectVitePlugin(input);
		expect(result.content).toContain('\t\tsveltekit(),\n\t\tsvelteGrab(),\n\t\tother()');
	});

	it('handles multi-line imports when placing the new import', () => {
		const input = `import {
	sveltekit
} from '@sveltejs/kit/vite';

export default { plugins: [sveltekit()] };
`;
		const result = injectVitePlugin(input);
		expect(result.content.startsWith(
			"import {\n\tsveltekit\n} from '@sveltejs/kit/vite';\nimport { svelteGrab } from 'svelte-grab/vite';\n"
		)).toBe(true);
		expect(result.content).toContain('plugins: [sveltekit(), svelteGrab()]');
	});

	it('is idempotent', () => {
		const once = injectVitePlugin(SV_VITE_CONFIG).content;
		const twice = injectVitePlugin(once);
		expect(twice.status).toBe('already-present');
		expect(twice.changed).toBe(false);
		expect(twice.content).toBe(once);
	});

	it('asks for a manual edit without a plugins array', () => {
		const input = `export default defineConfig(async () => ({ plugins: getPlugins() }));\n`;
		const result = injectVitePlugin(input);
		expect(result.status).toBe('manual');
		expect(result.changed).toBe(false);
		expect(result.content).toBe(input);
	});

	it('asks for a manual edit when no svelte()/sveltekit() call is in the array', () => {
		const input = `export default { plugins: [react()] };\n`;
		expect(injectVitePlugin(input).status).toBe('manual');
	});

	it('does not match look-alike calls such as mysvelte()', () => {
		const input = `export default { plugins: [mysvelte()] };\n`;
		expect(injectVitePlugin(input).status).toBe('manual');
	});
});

describe('mergeMcpJson', () => {
	it('creates the file with svelte-grab and svelte by default', () => {
		const result = mergeMcpJson(null, { svelteMcp: true, playwrightMcp: false });
		expect(result.error).toBeUndefined();
		expect(result.changed).toBe(true);
		expect(result.added).toEqual(['svelte-grab', 'svelte']);
		const data = JSON.parse(result.content);
		expect(data.mcpServers['svelte-grab']).toEqual(MCP_SERVERS['svelte-grab']);
		expect(data.mcpServers['svelte-grab'].args).toEqual(['svelte-grab-mcp', '--stdio']);
		expect(data.mcpServers.svelte).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@sveltejs/mcp'] });
		expect(data.mcpServers.playwright).toBeUndefined();
		expect(result.content.endsWith('\n')).toBe(true);
	});

	it('adds playwright only when asked', () => {
		const result = mergeMcpJson('', { svelteMcp: false, playwrightMcp: true });
		expect(result.added).toEqual(['svelte-grab', 'playwright']);
		const data = JSON.parse(result.content);
		expect(data.mcpServers.playwright.args).toEqual(['-y', '@playwright/mcp@latest']);
		expect(data.mcpServers.svelte).toBeUndefined();
	});

	it('never clobbers existing entries and keeps unrelated keys and indentation', () => {
		const existing = JSON.stringify(
			{ $schema: 'x', mcpServers: { svelte: { type: 'http', url: 'https://mcp.svelte.dev/mcp' }, other: { command: 'o' } } },
			null,
			'\t'
		);
		const result = mergeMcpJson(existing, { svelteMcp: true, playwrightMcp: false });
		expect(result.added).toEqual(['svelte-grab']);
		expect(result.kept).toEqual(['svelte']);
		const data = JSON.parse(result.content);
		expect(data.$schema).toBe('x');
		expect(data.mcpServers.svelte).toEqual({ type: 'http', url: 'https://mcp.svelte.dev/mcp' });
		expect(data.mcpServers.other).toEqual({ command: 'o' });
		expect(result.content).toContain('\n\t"mcpServers"');
	});

	it('reports no change when every entry is already there', () => {
		const first = mergeMcpJson(null, { svelteMcp: true, playwrightMcp: true }).content;
		const second = mergeMcpJson(first, { svelteMcp: true, playwrightMcp: true });
		expect(second.changed).toBe(false);
		expect(second.added).toEqual([]);
		expect(second.kept).toEqual(['svelte-grab', 'svelte', 'playwright']);
		expect(second.content).toBe(first);
	});

	it('refuses to touch invalid JSON or a non-object mcpServers', () => {
		expect(mergeMcpJson('{ nope', { svelteMcp: true, playwrightMcp: false }).error).toMatch(/not valid JSON/);
		expect(mergeMcpJson('[]', { svelteMcp: true, playwrightMcp: false }).error).toMatch(/JSON object/);
		const bad = mergeMcpJson('{"mcpServers": []}', { svelteMcp: true, playwrightMcp: false });
		expect(bad.error).toMatch(/mcpServers/);
		expect(bad.changed).toBe(false);
	});
});

describe('injectKitLayout', () => {
	it('creates a dev-gated layout, with enableMcp when asked', () => {
		const result = injectKitLayout(null, { enableMcp: true });
		expect(result.changed).toBe(true);
		expect(result.content).toContain("import { dev } from '$app/environment';");
		expect(result.content).toContain("import { SvelteDevKit } from 'svelte-grab';");
		expect(result.content).toContain('{@render children?.()}');
		expect(result.content).toContain('{#if dev}\n\t<SvelteDevKit enableMcp />\n{/if}');
		expect(result.content.startsWith('<script>')).toBe(true);
	});

	it('uses lang="ts" for a new layout in a TypeScript project', () => {
		const result = injectKitLayout('', { language: 'ts' });
		expect(result.content.startsWith('<script lang="ts">')).toBe(true);
		expect(result.content).toContain('<SvelteDevKit />');
	});

	it('injects into the instance script, not <script module>', () => {
		const input = `<script module>
	export const x = 1;
</script>

<script lang="ts">
	let { children } = $props();
</script>

{@render children()}
`;
		const result = injectKitLayout(input);
		expect(result.content).toContain(
			"<script lang=\"ts\">\n\timport { dev } from '$app/environment';\n\timport { SvelteDevKit } from 'svelte-grab';\n\tlet { children }"
		);
		expect(result.content).toContain('<script module>\n\texport const x = 1;');
		expect(result.content.trimEnd().endsWith('{#if dev}\n\t<SvelteDevKit />\n{/if}')).toBe(true);
	});

	it('adds a script block and children prop when the layout has none', () => {
		const result = injectKitLayout('<slot />\n');
		expect(result.content.startsWith('<script>\n')).toBe(true);
		expect(result.content).toContain('let { children } = $props();');
	});

	it('leaves a layout that already imports svelte-grab alone', () => {
		const input = `<script>\n\timport { SvelteGrab } from "svelte-grab";\n</script>\n<SvelteGrab />\n`;
		const result = injectKitLayout(input, { enableMcp: true });
		expect(result.changed).toBe(false);
		expect(result.content).toBe(input);
	});

	it('is idempotent', () => {
		const once = injectKitLayout(null, { enableMcp: true }).content;
		expect(injectKitLayout(once, { enableMcp: true }).changed).toBe(false);
	});
});

describe('injectAppSvelte', () => {
	it('adds the import and the component at the end', () => {
		const result = injectAppSvelte('<script>\n\tlet x = 1;\n</script>\n\n<main>{x}</main>\n', { enableMcp: true });
		expect(result.content).toContain("<script>\n\timport { SvelteDevKit } from 'svelte-grab';\n\tlet x = 1;");
		expect(result.content.endsWith('<main>{x}</main>\n\n<SvelteDevKit enableMcp />\n')).toBe(true);
	});

	it('creates a script block when missing and is idempotent', () => {
		const once = injectAppSvelte('<h1>hi</h1>\n');
		expect(once.content.startsWith("<script>\n\timport { SvelteDevKit } from 'svelte-grab';\n</script>")).toBe(true);
		expect(injectAppSvelte(once.content).changed).toBe(false);
	});
});

describe('devKitMissingEnableMcp', () => {
	it('detects a SvelteDevKit/SvelteGrab tag without enableMcp', () => {
		expect(devKitMissingEnableMcp('<SvelteDevKit />')).toBe(true);
		expect(devKitMissingEnableMcp('<SvelteGrab\n\tlightTheme\n/>')).toBe(true);
		expect(devKitMissingEnableMcp('<SvelteDevKit enableMcp />')).toBe(false);
		expect(devKitMissingEnableMcp('<SvelteDevKit enableMcp={true} />')).toBe(false);
		expect(devKitMissingEnableMcp('<p>nothing</p>')).toBe(false);
	});
});

describe('lineDiff', () => {
	it('marks only inserted and removed lines', () => {
		expect(lineDiff('a\nb\nc\n', 'a\nx\nb\nc\n')).toEqual(['  a', '+ x', '  b', '  c']);
		expect(lineDiff('a\nb\n', 'a\n')).toEqual(['  a', '- b']);
		expect(lineDiff('', '{\n}\n')).toEqual(['+ {', '+ }']);
	});
});
