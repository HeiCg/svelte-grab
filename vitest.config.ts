import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for svelte-grab.
 *
 * Pure-TS unit tests run in the default `node` environment.
 * DOM-dependent tests opt into jsdom per-file with a docblock pragma:
 *
 *   // @vitest-environment jsdom
 *
 * No Svelte plugin is needed here because we only unit-test plain
 * TypeScript modules (no .svelte component compilation).
 */
export default defineConfig({
	test: {
		environment: 'node',
		globals: true,
		include: ['tests/**/*.{test,spec}.ts'],
		// Each test file may declare its own environment via a docblock.
		environmentMatchGlobs: []
	}
});
