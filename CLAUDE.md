# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

svelte-grab is a Svelte 5 dev tool suite (published to npm) that captures and formats context for LLMs working with frontend code. The core tool (SvelteGrab) lets you Alt+Click any element to get component stack with source locations. Additional tools inspect state, styles, accessibility, errors, props hierarchy, and render performance. All tools read `__svelte_meta` metadata that Svelte 5 attaches to DOM elements in dev builds and auto-disable in production.

Beyond the browser components, svelte-grab includes a CLI (`svelte-grab init|relay|mcp`), a WebSocket agent relay server, and an MCP server for direct coding agent integration.

## Commands

- **Build:** `npm run build` — runs `svelte-package -i src/lib -o dist` then `tsc -p tsconfig.server.json` (for relay/cli/mcp)
- **Type check:** `npm run check` — runs `svelte-check --tsconfig ./tsconfig.json`

There are no tests or lint commands configured.

## Architecture

### Two Build Targets

1. **Svelte components** (`src/lib/`) — built by `svelte-package`, uses `tsconfig.json`. Browser-side code.
2. **Server/Node code** (`src/relay/`, `src/cli/`, `src/mcp/`) — built by `tsc -p tsconfig.server.json`. Node.js code.

These are separate TypeScript projects. `src/lib/` uses Svelte's compiler; the rest use plain `tsc`.

### Package Exports

- `svelte-grab` — main entry, all Svelte components + core utilities + types
- `svelte-grab/relay` — relay server, providers, protocol types (Node.js)
- `svelte-grab/mcp` — MCP server (Node.js)
- CLI binaries: `svelte-grab` and `svelte-grab-mcp`

### Components (`src/lib/*.svelte`)

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

### Core Modules (`src/lib/core/`)

- `global-api.ts` — Creates `window.__SVELTE_GRAB__` API (activate/deactivate/grab/registerPlugin). Uses a callbacks pattern: creates proxy API first, SvelteGrab component wires real implementations in `onMount`.
- `plugin-registry.ts` — `PluginRegistry` class managing plugin lifecycle (register/unregister), hook execution (async, with error isolation), content transforms (piped through plugins), and context menu action collection.
- `agent-client.ts` — Browser-side WebSocket client for agent relay. Handles reconnection, request/abort/undo/redo/resume/retry protocol, and request history tracking.
- `context-menu-actions.ts` — Default right-click context menu actions (copy for agent, copy HTML, copy paths, open in editor, screenshot, send to agent).
- `dom-navigation.ts` — Helpers to navigate the DOM tree by `__svelte_meta` (find parent/child/sibling with Svelte metadata).

### Utility Modules (`src/lib/utils/`)

- `shared.ts` — Dev detection, element finding, clipboard, path shortening, theme resolution
- `serializer.ts` — Safe JSON serialization (circular refs, functions, DOM elements, Maps, Sets)
- `css-analyzer.ts` — CSS rule matching via CSSOM, specificity, Tailwind/scoped detection
- `a11y-checker.ts` — Accessibility checks: contrast (WCAG), labels, ARIA, heading hierarchy, focus order
- `error-parser.ts` — Stack trace parsing (Chrome/Firefox/Safari), error pattern detection
- `profiler-tracker.ts` — MutationObserver-based render tracking, burst detection
- `inspectable.ts` — Global registry for components to expose `$state` values. Components call `inspectable('Name', { count, name })` inside `$effect()`, and SvelteStateGrab reads from this registry.
- `unified-export.ts` — Aggregation store: each tool registers its `formatForAgent()` output; DevKit's "Copy All Context" (Alt+Shift+C) collects them all.

### SSR Support

`index.server.ts` exports noop stubs for all components (dev tools are client-only) and re-exports SSR-safe utilities. The `"node"` export condition in `package.json` points here.

### Agent Relay (`src/relay/`)

WebSocket relay server that bridges browser → relay → coding agent. Protocol uses typed messages (`agent-request`, `agent-status`, `agent-done`, `agent-error`, `handlers`). The provider pattern (`providers/base.ts`) defines the agent interface; `providers/claude-code.ts` implements it using `@anthropic-ai/claude-agent-sdk`.

### MCP Server (`src/mcp/`)

HTTP + stdio MCP server. Exposes tools: `get_element_context` (reads last browser grab), `undo_last_action`, `get_session_history`. The browser POSTs context to `/context`; MCP clients read it via the standard MCP protocol on `/mcp`.

### CLI (`src/cli/`)

- `svelte-grab init` — Adds SvelteGrab to a SvelteKit project's layout
- `svelte-grab relay` — Starts the WebSocket relay server
- `svelte-grab mcp` — Starts the MCP server

### Key Patterns

- **Dev mode detection:** All components use `detectDevMode()` from `shared.ts` which scans DOM for `__svelte_meta`
- **Component stack walking:** Traverses `__svelte_meta.parent` chain, deduplicating by `file:line` and filtering internal paths
- **LLM-optimized output:** Each tool has a `formatForAgent()` function producing structured text for coding agent prompts
- **Theme system:** All components accept `theme` (ThemeConfig) and `lightTheme` props, resolved via `$derived`
- **Plugin hooks:** Plugins register via `PluginRegistry`, providing hooks (async, error-isolated) and context menu actions. Content transforms pipe through all registered plugins.

### Optional Peer Dependencies

- `html-to-image` — Screenshot feature in SvelteGrab
- `ws` — WebSocket server for the relay
- `@anthropic-ai/claude-agent-sdk` — Claude Code agent provider
- `@modelcontextprotocol/sdk` — MCP protocol support

## Svelte 5 Patterns Used

- `$props()` for component props with destructured defaults
- `$state()` for reactive state
- `$derived()` for computed values (theme merging)
- `SvelteSet` from `svelte/reactivity` for reactive Set operations (in SvelteGrab)
- `onMount`/`onDestroy` lifecycle (not `$effect`)
- Event handlers use `onclick` attribute syntax (not `on:click`)

## Important: Template Unicode

Do NOT use `\u{XXXX}` escapes in Svelte template markup — the `{XXXX}` part gets parsed as a Svelte expression. Use actual Unicode characters (emojis, symbols) directly in templates. `\uXXXX` (4-digit, no braces) is safe in JS strings inside `<script>` tags.
