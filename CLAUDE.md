# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

svelte-grab (published to npm) gives coding agents eyes into a Svelte 5 app. Since 2.0 it is an **agent runtime**: an in-page runtime answers the MCP server's `ui_*` tools, so the agent queries the live UI itself (component, source `file:line`, props, state, styles, a11y, HMR, verification). The human tools are still there: Alt+Click any element for its component stack, plus state, styles, accessibility, errors, props hierarchy and render profiling. Everything reads the `__svelte_meta` that Svelte 5 attaches to DOM elements in dev builds and auto-disables in production.

The agent loop the tools are designed for (spec: `docs/agent-runtime-spec.md`):

```
ui_snapshot -> ui_find -> ui_inspect -> ui_component_impact -> (agent edits code) -> ui_wait_for_hmr -> ui_verify -> ui_profile
```

Audit tools on top (2.1): `ui_network`, `ui_security_scan`, CDP-mode `ui_perf_metrics` / `ui_leak_check`, and the static `svelte-grab audit` CLI. Requires Node.js 22.12+ (`engines`).

Beyond the browser components: a CLI (`svelte-grab init|mcp|relay`), the MCP server (main integration surface), a Vite plugin (`svelte-grab/vite`), an `sv` add-on (`svelte-grab/sv`, `npx sv add svelte-grab`) and the WebSocket relay (maintenance mode).

## Commands

- **Build:** `npm run build` — runs `svelte-package -i src/lib -o dist` then `tsc -p tsconfig.server.json` (for relay/cli/mcp/vite)
- **Type check:** `npm run check` — runs `svelte-check --tsconfig ./tsconfig.json`
- **Unit tests:** `npm run test` (watch) / `npm run test:run` (CI) — Vitest, tests live in `tests/`
- **E2E:** `npm run test:e2e` — Playwright against the `examples/playground` demo app (run with `npm run dev:demo`). Dev server port: `SG_E2E_PORT` (default 5189; read by `playwright.config.ts` and the playground's `vite.config.ts`), so parallel runs can use their own port. Runners use at most 2 workers.
- **Lint / format:** `npm run lint` (ESLint flat config, must be clean) / `npm run format` / `npm run format:check` (Prettier; `skills/**/*.md` and `tests/fixtures/` are ignored on purpose: tests and MCP prompts read the checklist tables verbatim, audit tests assert exact positions)

CI (`.github/workflows/ci.yml`) runs build + check + unit + lint + format check + e2e on every PR; lint and format are blocking.

### Shared UI / design system (`src/lib/ui/`)

`DevToolPopup.svelte` (shared overlay/popup chrome), `DevToolButton.svelte`, `DevToolToggle.svelte`, and `tokens.ts` (spacing/radius/z-index/timing tokens). Tool components compose these instead of hand-rolling popup markup + CSS. Companion helpers in `utils/`: `resolve-theme.ts`, `copy-with-feedback.ts`, `use-devtool-mount.svelte.ts` (mount helper that fixes the within-100ms unmount race), `hide-from-third-parties.ts` (redacts the overlay from session-replay tools).

### Security (relay/MCP)

The relay (WS) and MCP (HTTP) servers are **dev-only, loopback-only** (bind `127.0.0.1`), validate the request `Origin` against a localhost allowlist (configurable via `SVELTE_GRAB_ALLOWED_ORIGINS`), support an optional bearer token (`SVELTE_GRAB_TOKEN`), and cap payloads/session stores. See `src/utils/security.ts` and the README Security section. Never expose these ports to a network.

## Architecture

### Two Build Targets

1. **Svelte components** (`src/lib/`) — built by `svelte-package`, uses `tsconfig.json`. Browser-side code.
2. **Server/Node code** (`src/relay/`, `src/cli/`, `src/mcp/`, `src/vite/`, `src/sv/`, `src/utils/`) — built by `tsc -p tsconfig.server.json`. Node.js code.

These are separate TypeScript projects. `src/lib/` uses Svelte's compiler; the rest use plain `tsc`.

### Package Exports

- `svelte-grab` — main entry, all Svelte components + core utilities + types
- `svelte-grab/mcp` — MCP server (Node.js)
- `svelte-grab/vite` — optional Vite plugin (Node.js)
- `svelte-grab/sv` — `sv` community add-on (`npx sv add svelte-grab`; Node.js)
- `svelte-grab/relay` — relay server, providers, protocol types (Node.js, maintenance mode)
- CLI binaries: `svelte-grab` and `svelte-grab-mcp`

### Components (`src/lib/*.svelte`)

| Component                     | Trigger                                                                      | Purpose                                     |
| ----------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------- |
| `SvelteGrab.svelte`           | Alt+Click                                                                    | Component location stack (original tool)    |
| `SvelteStateGrab.svelte`      | Alt+Shift+Click (Alt+Meta+Click inside DevKit with multi-select)             | Component state/props/attributes inspection |
| `SvelteStyleGrab.svelte`      | Alt+Ctrl+Click                                                               | Computed CSS styles with source attribution |
| `SveltePropsTracer.svelte`    | Alt+DoubleClick                                                              | Component hierarchy trace                   |
| `SvelteA11yReporter.svelte`   | Alt+RightClick / Alt+A (element audit is Alt+Shift+RightClick inside DevKit) | Accessibility audit with fix suggestions    |
| `SvelteErrorContext.svelte`   | Alt+E                                                                        | Console error/warning capture with context  |
| `SvelteRenderProfiler.svelte` | Alt+P                                                                        | DOM mutation profiling per component        |
| `SvelteDevKit.svelte`         | (wrapper)                                                                    | Includes all tools above in one component   |

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
- `component-stack.ts` — the **only** module that reads `__svelte_meta` (`getSvelteMeta`, `getSvelteLoc`, `findMetaElement`, `walkDevStack`, `getComponentStack`). Component names come from `componentTag`; for component entries `file:line` is the usage site; block entries (`if`/`each`/`await`/`key`/`render`) are labelled as blocks. Never walk `__svelte_meta` elsewhere.
- `agent-format.ts` — text formatting of a component stack for agents (blocks shown as `{#each}` etc.)
- `inspectable.svelte.ts` (+ plain-TS core `inspectable-registry.ts`; `inspectable.ts` re-exports) — components call `inspectable('Name', { count, name })` inside `$effect()`; values are `$state.snapshot`-ed, one entry per instance (`Name #1`, `#2`); returns a cleanup. Read by SvelteStateGrab and `ui_inspect` (`state-capture.ts` holds the shared logic).
- `hotkeys.ts` — `hotkeys="full"|"minimal"`, annotation key (N), and DevKit's single-owner shortcut resolution (`resolveReservedModifiers`, `resolveA11yElementModifier`, `shouldYieldDoubleClick`) feeding SvelteGrab's `reservedModifiers` / `reservedContextMenuModifiers` / `yieldDoubleClick` props.
- `annotations.ts` — annotation store and agent formatting (annotation mode).
- `editor-link.ts` — open-in-editor: Vite `/__open-in-editor` when the plugin is present, else editor deep links.
- `overflow.ts` — `overflowAxes()` (falls back to the `overflow` shorthand when longhands report `visible`).
- `unified-export.ts` — Aggregation store: each tool registers its `formatForAgent()` output; DevKit's "Copy All Context" (Alt+Shift+C) collects them all.
- `parse-activation-key.ts` — Parses keyboard shortcut strings (with modifier aliases like cmd/option/win) into matcher functions for `KeyboardEvent` and `MouseEvent`.
- `history-storage.ts` — Persistent grab history in `sessionStorage`, surviving navigations within a tab; handles quota/private-browsing errors gracefully.
- `element-selector.ts` — Generates unique CSS selectors (preferring stable test/ARIA attributes) so persisted history can reacquire elements after reload.
- `drag-selection.ts` — Multi-element drag selection via point-sampling: finds DOM elements covered by a drag rectangle.
- `freeze-animations.ts` — Freezes CSS/SVG/Web Animations API animations and transitions during context capture for a stable visual snapshot; returns an unfreeze cleanup.
- `freeze-pseudo-states.ts` — Freezes `:hover`/`:focus`/`:focus-visible` by baking computed styles inline during context capture.

### Security rules (`src/lib/security/`)

`secret-rules.ts` is pure TS (no DOM/Node globals; a test enforces it) shared by the page runtime and the Node audit CLI: secret detection (JWT, provider key shapes, entropy), sensitive key names, and `redact()` -> `kind:abcd…(len N, sha xxxxxx)`. **Redaction is mandatory**: no tool output may contain a full secret; tests assert fake secrets never appear. Fake secrets in fixtures are assembled at runtime so the repo has no literal secrets.

### SSR Support

`index.server.ts` exports noop stubs for all components (dev tools are client-only) and re-exports SSR-safe utilities. The `"node"` export condition in `package.json` points here.

### Agent Runtime, page side (`src/lib/runtime/`)

Mounted by SvelteGrab/DevKit when `enableMcp` (and `enableAgentRuntime`, default on). `connection.ts` listens for `runtime-command` on the MCP server's SSE `/events`, announces the tab with `POST /runtime/hello` and answers via `POST /runtime/result`; `commands.ts` dispatches to one module per tool: `snapshot.ts`, `find.ts`, `inspect.ts`, `hmr.ts` (`ui_wait_for_hmr`: `import.meta.hot`, then the Vite plugin bridge, then a DOM heuristic; must keep the literal `import.meta.hot`), `verify.ts`, `impact.ts`, `annotations.ts`, `profile.ts` (`ui_profile`, headless ProfilerTracker, optional in-page action), `leak.ts` (WeakRef tracking for `ui_leak_check`), `network.ts` (`ui_network`: transparent fetch/XHR/sendBeacon/WebSocket/EventSource wrappers + resource timing, initiator from the stack; capture starts at module eval in the Vite dev server), `security-scan.ts` (`ui_security_scan`). `refs.ts` holds the ref registry: session refs `eN` stamped as `data-sg-ref` (a locator for Playwright/chrome-devtools MCP) plus stable `ui://file:line:col#Component...` keys that re-resolve after re-render/HMR. `console-capture.ts` buffers console errors while connected; `server-probe.ts` finds the MCP port (4723-4732 via `GET /health`). The `mcpToken` prop is sent as `x-svelte-grab-token` / `?token=` when the server uses `SVELTE_GRAB_TOKEN`.

### MCP Server (`src/mcp/`)

HTTP + stdio MCP server (`server.ts`, `cli.ts`; stdio mode also runs the HTTP sidecar the page talks to). Human-handoff tools: `watch_for_grab`, `get_element_context`, `get_*_report/context`, `undo_last_action`, `get_session_history`, `list_available_tools`. `runtime/` holds the agent-runtime side: `tools.ts` registers `ui_tabs`, `ui_snapshot`, `ui_find`, `ui_inspect`, `ui_annotations`, `ui_verify`, `ui_component_impact`, plus `hmr-tool.ts` (`ui_wait_for_hmr`), `profile-tool.ts` (`ui_profile`), `network-tool.ts` (`ui_network`, server-orchestrated `reload`), `security-tool.ts` (`ui_security_scan`) and `cdp-tools.ts` (`ui_perf_metrics`, `ui_leak_check`; opt-in `--cdp=<url>` / `SVELTE_GRAB_CDP`, loopback hosts only, client in `cdp/client.ts` on Node 22's global `WebSocket`); `command-channel.ts` (pending map + timeouts for SSE commands), `tab-registry.ts` (active tab), `validate.ts`. The wire contract is in the spec; every endpoint goes through the same `checkAccess` and body cap (413 JSON). `instructions.ts` is the operating guide sent as MCP `instructions` on initialize (keep it under 2,048 chars, Claude Code's cap; first paragraph self-contained; a test checks every tool it names exists). `prompts.ts` exposes the prompts `svelte-grab-loop`, `security-audit`, `performance-audit` built from the packaged skills.

### Vite plugin (`src/vite/`)

`svelte-grab/vite`, dev server only: HMR bridge (`svelte-grab:hmr` window events, injected via `transformIndexHtml` and into modules importing `svelte-grab`), `GET /__svelte-grab/importers` from the module graph (used by `ui_component_impact`), and `window.__SVELTE_GRAB_VITE__` so open-in-editor uses Vite's `/__open-in-editor`.

### Agent Relay (`src/relay/`) — maintenance mode

Still supported, no new providers/features; new integrations use MCP. WebSocket relay server that bridges browser → relay → coding agent. Protocol uses typed messages (`agent-request`, `agent-status`, `agent-done`, `agent-error`, `handlers`). The provider pattern (`providers/base.ts`) defines the agent interface. `providers/claude-code.ts` consumes `query()` from `@anthropic-ai/claude-agent-sdk` as an async message stream (abortController, session resume, `acceptEdits`); `providers/codex.ts` uses `new Codex()` from `@openai/codex-sdk` with awaited `runStreamed()` (`workspace-write`). Both accept an injected SDK for tests (`tests/relay-providers.test.ts`); keep them in sync with the real SDK types.

### CLI (`src/cli/`)

- `svelte-grab init` — merges `.mcp.json` (svelte-grab + `@sveltejs/mcp`, optional `@playwright/mcp`), adds `svelteGrab()` to `vite.config`, injects `<SvelteDevKit />` (with `enableMcp` when an MCP config declares svelte-grab), and sets up the coding agents: `.codex/config.toml` for Codex, skills in `.claude/skills/` and `.agents/skills/` (hash manifest per dir), `AGENTS.md` section and a `CLAUDE.md` pointer (`src/cli/agents.ts`). Flags: `--dry-run`, `--no-mcp-json`, `--no-svelte-mcp`, `--with-playwright-mcp`, `--no-vite-plugin`, `--agents claude,codex`, `--no-codex`, `--no-skills`, `--no-agents-md`. The MCP server also sends `instructions` (`src/mcp/instructions.ts`) that every client injects into the model context. The file edits are pure string transforms in `transforms.ts` (no fs, idempotent), shared with the sv add-on.
- `svelte-grab mcp` — Starts the MCP server
- `svelte-grab skills install|list|path` — install/update the agent skills (`--agents`, `--skills-dir`, `--force`, `--dry-run`); planner in `skills-plan.ts` with a hash manifest (`.svelte-grab-skills.json`) so unedited files update in place and edited ones get `<file>.new`
- `svelte-grab audit` — Static security scanner (`src/cli/audit/`: walker, rules, text/JSON/HTML reporters, `finding-schema.json` + zero-dep validator); reuses `src/lib/security/secret-rules.ts` (pure, emitted by the server tsc as `dist/lib/security/`); fixtures in `tests/fixtures/audit-app/` keep secret placeholders filled at test time
- `svelte-grab relay` / `add` / `remove` — relay (maintenance mode)

### sv add-on (`src/sv/`)

The `sv` community add-on, shipped in the main package as the `./sv` export (`npx sv add svelte-grab`). sv 1.x unpacks the svelte-grab tarball into its own `node_modules` without installing dependencies and imports `svelte-grab/sv`, so the add-on module graph may only import relative modules and `node:` builtins (no runtime import of `sv`: `defineAddon` is an identity function, and `sv add file:<path>` resolves the symlinked add-on outside sv). sv requires `sv` in `peerDependencies` (optional here) and the keyword `sv-add`. `src/sv/plan.ts` holds the logic against a minimal sv-like interface, reuses `src/cli/transforms.ts` and `src/cli/skills-plan.ts`, and reads the skills and version from the package itself (`src/utils/packaged-skills.ts`); `src/sv/index.ts` is the add-on definition. Built by the server tsc into `dist/sv/`. Root Vitest covers it (`tests/sv-addon.test.ts`) with a fake `sv`; never install `sv` in the root.

### Agent skills (`skills/`)

Source of truth for the shipped skills: `skills/svelte-grab/SKILL.md` (the `ui_*` loop) and `skills/svelte-grab-audit/` (`SKILL.md`, `CHECKLIST.md`, `REPORT-TEMPLATE.md`, `finding-schema.json`). Shipped in the npm package (`files`), installed by `init` / `sv add` / `skills install`, inlined by the MCP prompts, and exposed via `.claude-plugin/`. Tests check frontmatter, that checklist items name real tools, and that the finding schema accepts audit CLI findings. No npm `postinstall` (supply-chain risk).

### Key Patterns

- **Dev mode detection:** All components use `detectDevMode()` from `shared.ts` which scans DOM for `__svelte_meta`
- **Component stack walking:** Traverses `__svelte_meta.parent` chain, deduplicating by `file:line` and filtering internal paths
- **LLM-optimized output:** Each tool has a `formatForAgent()` function producing structured text for coding agent prompts
- **Theme system:** All components accept `theme` (ThemeConfig) and `lightTheme` props, resolved via `$derived`
- **Plugin hooks:** Plugins register via `PluginRegistry`, providing hooks (async, error-isolated) and context menu actions. Content transforms pipe through all registered plugins.

### Optional Peer Dependencies

- `html-to-image` — Screenshot feature in SvelteGrab
- `ws` — WebSocket server for the relay
- `@anthropic-ai/claude-agent-sdk` / `@openai/codex-sdk` — relay providers
- `@modelcontextprotocol/sdk` (+ `zod`) — MCP protocol support
- `vite` — the `svelte-grab/vite` plugin
- `sv` — required by sv's add-on loader (never imported at runtime)

## Svelte 5 Patterns Used

- `$props()` for component props with destructured defaults
- `$state()` for reactive state
- `$derived()` for computed values (theme merging)
- `SvelteSet` from `svelte/reactivity` for reactive Set operations (in SvelteGrab)
- `onMount`/`onDestroy` lifecycle (not `$effect`)
- Event handlers use `onclick` attribute syntax (not `on:click`)

## Important: Template Unicode

Do NOT use `\u{XXXX}` escapes in Svelte template markup — the `{XXXX}` part gets parsed as a Svelte expression. Use actual Unicode characters (emojis, symbols) directly in templates. `\uXXXX` (4-digit, no braces) is safe in JS strings inside `<script>` tags.
