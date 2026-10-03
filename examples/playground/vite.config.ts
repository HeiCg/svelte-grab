import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

// Resolve the library's REAL source so e2e exercises the actual code in src/lib,
// not the published dist. The `@sveltejs/vite-plugin-svelte` dev build is what
// emits `__svelte_meta` on DOM nodes — which is exactly what svelte-grab's
// `detectDevMode()` scans for. That metadata only exists in a `vite dev` build,
// so this app MUST be served via `vite dev` for the tools to activate.
const libIndex = fileURLToPath(new URL('../../src/lib/index.ts', import.meta.url));

export default defineConfig({
	plugins: [
		svelte({
			// Svelte's experimental async mode: enables `await` in component
			// script/markup and `<svelte:boundary>` `pending` snippets. The
			// agent-runtime fixtures (AsyncFixture) depend on it.
			compilerOptions: {
				experimental: { async: true }
			}
		})
	],
	resolve: {
		alias: {
			// `import { SvelteDevKit } from 'svelte-grab'` -> repo's src/lib/index.ts
			'svelte-grab': libIndex
		}
	},
	server: {
		port: 5189,
		strictPort: true
	},
	// The library imports a couple of optional peer deps via dynamic import()
	// (html-to-image, ws, etc.). They are never reached on the dev happy-path,
	// but tell Vite not to try to pre-bundle them.
	optimizeDeps: {
		exclude: ['html-to-image', 'ws', '@anthropic-ai/claude-agent-sdk', '@modelcontextprotocol/sdk', '@openai/codex-sdk']
	}
});
