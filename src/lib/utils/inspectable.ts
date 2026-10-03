/**
 * Backward-compatible path for the inspectable registry.
 *
 * The implementation moved to `inspectable.svelte.ts` (it needs
 * `$state.snapshot` / `$effect`). Importing from here keeps working.
 */
export * from './inspectable.svelte.js';
