import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
// The repo's own Vite plugin source (what `svelte-grab/vite` ships): HMR
// bridge, /__svelte-grab/importers and the editor-link root marker.
import { svelteGrab } from '../../src/vite/index.ts';

// Resolve the library's REAL source so e2e exercises the actual code in src/lib,
// not the published dist. The `@sveltejs/vite-plugin-svelte` dev build is what
// emits `__svelte_meta` on DOM nodes — which is exactly what svelte-grab's
// `detectDevMode()` scans for. That metadata only exists in a `vite dev` build,
// so this app MUST be served via `vite dev` for the tools to activate.
const libIndex = fileURLToPath(new URL('../../src/lib/index.ts', import.meta.url));

// e2e port: `SG_E2E_PORT` (set by playwright.config.ts) lets several Playwright
// runs serve their own playground side by side. strictPort: never drift to
// another port the tests would not be pointed at.
const port = Number(process.env.SG_E2E_PORT || 5189);

export default defineConfig({
	plugins: [
		svelte({
			// Svelte's experimental async mode: enables `await` in component
			// script/markup and `<svelte:boundary>` `pending` snippets. The
			// agent-runtime fixtures (AsyncFixture) depend on it.
			compilerOptions: {
				experimental: { async: true }
			}
		}),
		svelteGrab()
	],
	resolve: {
		alias: {
			// `import { SvelteDevKit } from 'svelte-grab'` -> repo's src/lib/index.ts
			'svelte-grab': libIndex
		}
	},
	server: {
		port,
		strictPort: true
	},
	preview: {
		port,
		strictPort: true
	},
	// The library imports a couple of optional peer deps via dynamic import()
	// (html-to-image, ws, etc.). They are never reached on the dev happy-path,
	// but tell Vite not to try to pre-bundle them.
	optimizeDeps: {
		exclude: ['html-to-image', 'ws', '@anthropic-ai/claude-agent-sdk', '@modelcontextprotocol/sdk', '@openai/codex-sdk']
	}
});
