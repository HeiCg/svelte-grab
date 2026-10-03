import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright e2e config for svelte-grab.
 *
 * The tests drive the demo app in `examples/playground`, which mounts the REAL
 * library source (`src/lib`) via a Vite alias. The demo MUST be served by
 * `vite dev` (not a production build) because svelte-grab's dev tools only
 * activate when Svelte's dev-mode `__svelte_meta` is present on DOM nodes, and
 * that metadata is only emitted by the @sveltejs/vite-plugin-svelte dev build.
 */

const PORT = 5189;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
	testDir: './e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: process.env.CI ? 1 : 2,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
	timeout: 30_000,
	expect: { timeout: 7_000 },

	use: {
		baseURL: BASE_URL,
		headless: true,
		trace: 'on-first-retry',
		// The grab/style/a11y tools read & write the system clipboard; grant the
		// Chromium permissions so navigator.clipboard works headlessly.
		permissions: ['clipboard-read', 'clipboard-write']
	},

	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] }
		}
	],

	webServer: {
		command: 'npm --prefix examples/playground run dev',
		url: BASE_URL,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
		stdout: 'pipe',
		stderr: 'pipe'
	}
});
