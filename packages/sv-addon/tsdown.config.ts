import { defineConfig } from 'tsdown';

// One ESM file (dist/index.mjs). tsdown leaves peer dependencies (`sv`, which
// the CLI provides at runtime) external and bundles the rest, including
// ../../src/cli/transforms.ts, shared with `svelte-grab init`.
export default defineConfig({
	entry: ['src/index.ts'],
	format: 'esm'
});
