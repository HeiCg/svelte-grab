# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

svelte-grab is a Svelte 5 dev tool suite (published to npm) that captures and formats context for LLMs working with frontend code. The core tool (SvelteGrab) lets you Alt+Click any element to get component stack with source locations. Additional tools inspect state, styles, accessibility, errors, props hierarchy, and render performance. All tools read `__svelte_meta` metadata that Svelte 5 attaches to DOM elements in dev builds and auto-disable in production.

## Commands

- **Build:** `npm run build` — runs `svelte-package -i src/lib -o dist` to produce the publishable `dist/` directory
- **Type check:** `npm run check` — runs `svelte-check --tsconfig ./tsconfig.json`

There are no tests or lint commands configured.

## Architecture

All source lives in `src/lib/`. Components are self-contained Svelte files with scoped CSS. Shared logic lives in `src/lib/utils/`.

### Components

| Component | Trigger | Purpose |
|-----------|---------|---------|
| `SvelteGrab.svelte` | Alt+Click | Component location stack (original tool) |
| `SvelteStateGrab.svelte` | Alt+Shift+Click | Component state/props/attributes inspection |
| `SvelteStyleGrab.svelte` | Alt+Ctrl+Click | Computed CSS styles with source attribution |
| `SveltePropsTracer.svelte` | Alt+DoubleClick | Component hierarchy trace |
| `SvelteA11yReporter.svelte` | Alt+RightClick / Alt+A | Accessibility audit with fix suggestions |
| `SvelteErrorContext.svelte` | Alt+E | Console error/warning capture with context |
| `SvelteRenderProfiler.svelte` | Alt+P | DOM mutation profiling per component |
| `SvelteDevKit.svelte` | (wrapper) | Includes all tools above in one component |

### Utility Modules (`src/lib/utils/`)

- `shared.ts` — Common helpers: dev detection, element finding, clipboard, path shortening, theme resolution
- `serializer.ts` — Safe JSON serialization handling circular refs, functions, DOM elements, Maps, Sets
- `css-analyzer.ts` — CSS rule matching via CSSOM, specificity calculation, Tailwind/scoped detection, conflict analysis
- `a11y-checker.ts` — Accessibility checks: contrast (WCAG), labels, ARIA, heading hierarchy, focus order, score
- `error-parser.ts` — Stack trace parsing (Chrome/Firefox/Safari), error pattern detection, LLM suggestions
- `profiler-tracker.ts` — MutationObserver-based render tracking, burst detection, component profiling

### Other Files

- `types.ts` — All TypeScript interfaces for every component and utility
- `index.ts` — Public entry point re-exporting all components and types

### Key Patterns

- **Dev mode detection:** All components use `detectDevMode()` from `shared.ts` which scans DOM for `__svelte_meta`
- **Component stack walking:** Traverses `__svelte_meta.parent` chain, deduplicating by `file:line` and filtering internal paths
- **Each tool formats output for LLMs** with a `formatForAgent()` function that produces structured text optimized for coding agent prompts
- **Theme system:** All components accept `theme` (ThemeConfig) and `lightTheme` props, resolved via `$derived`

### Build & Package

- Uses `@sveltejs/package` (svelte-package) to build — not Vite or SvelteKit app builds
- Package exports from `dist/index.js` with TypeScript declarations
- Svelte 5 is a peer dependency (`^5.0.0`)
- `html-to-image` is an optional peer dependency (for screenshot feature in SvelteGrab)

## Svelte 5 Patterns Used

- `$props()` for component props with destructured defaults
- `$state()` for reactive state
- `$derived()` for computed values (theme merging)
- `SvelteSet` from `svelte/reactivity` for reactive Set operations (in SvelteGrab)
- `onMount`/`onDestroy` lifecycle (not `$effect`)
- Event handlers use `onclick` attribute syntax (not `on:click`)

## Important: Template Unicode

Do NOT use `\u{XXXX}` escapes in Svelte template markup — the `{XXXX}` part gets parsed as a Svelte expression. Use actual Unicode characters (emojis, symbols) directly in templates. `\uXXXX` (4-digit, no braces) is safe in JS strings inside `<script>` tags.
