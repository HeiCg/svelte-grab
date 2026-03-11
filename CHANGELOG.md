# Changelog

## 1.4.1 (2026-03-11)

### Bug Fixes

- **SvelteA11yReporter:** Fix SSR crash — `clearHighlights()` called from `onDestroy` used `document.querySelectorAll()` without a browser guard, causing `ReferenceError: document is not defined` when Svelte's SSR compiler runs `onDestroy` callbacks in Node.js ([#8](https://github.com/HeiCg/svelte-grab/pull/8))

### Template Improvements

- **SvelteA11yReporter:** Add keyed `{#each}` blocks for critical issues, warnings, and passes lists

### Dev Dependencies

- Add `svelte-check-rs` for faster type checking

## 1.4.0 (2026-03-05)

### Highlights

**Live browser-to-Claude Code bridge** — Select a component, type what you want changed, and Claude Code acts on it instantly. No copy-paste, no context switching.

### Claude Code Integration

- **`watch_for_grab` MCP tool** — Blocks until the user sends context from the browser, creating a reactive loop. Claude Code calls it, user selects element + types prompt, tool resolves with everything. Call in a loop for continuous interaction.
- **Sidecar HTTP server in stdio mode** — When Claude Code connects via stdio, a sidecar HTTP server starts automatically so the browser can POST context to it.
- **SSE `/events` endpoint** — Real-time status updates from MCP server to browser (agent listening, processing, sent).
- **Live connection status** — Prompt overlay shows green dot when Claude Code is listening, red when disconnected. Button text adapts: "Send to Claude Code" / "Send (queued)" / "Copy with Context".
- **Prompt mode sends to MCP** — `confirmPrompt()` now sends to MCP server when `enableMcp` is true, not just clipboard.

### react-grab Feature Parity

Features inspired by [react-grab](https://github.com/aidenybai/react-grab):

- **Animation freezing** — Pauses CSS animations, transitions, SVG animations, and Web Animations API during selection for stable captures (`freezeAnimations` prop, default: `true`).
- **Pseudo-state preservation** — Freezes :hover/:focus computed styles as inline styles so you can grab transient UI states (`freezePseudoStates` prop, default: `true`).
- **Point-sampling drag selection** — Replaces naive `querySelectorAll('*')` with `elementsFromPoint()` grid sampling, coverage filtering, and nested element dedup.
- **CSS selector generation** — 3-tier strategy (ID, test attributes, nth-child) for element reacquisition after DOM changes.
- **History persistence** — Grab history persisted to sessionStorage with byte-size trimming (`enableHistoryPersistence` prop, default: `true`).
- **Prompt mode** — Inline prompt overlay for adding context/instructions to selections (`enablePromptMode` prop, default: `true`).

### Agent Providers

- **CursorProvider** — Spawns `cursor-agent` CLI with streaming JSON event parsing. Supports resume/abort/undo.
- **CopilotProvider** — Spawns `copilot` CLI with `--silent --allow-all` flags, reads stdout as plain text.
- **CodexProvider** — Lazy-loads `@openai/codex-sdk`, uses `startThread()`/`resumeThread()` API.
- **`connectToRelay()`** — Browser-side function to register remote handlers via WebSocket.

### CLI

- **`svelte-grab add <provider>`** — Add an agent provider to `svelte-grab.config.json` (claude-code, cursor, copilot, codex).
- **`svelte-grab remove <provider>`** — Remove a provider from configuration.
- **`svelte-grab configure`** — Interactive configuration (activation key, editor, ports, theme) via readline prompts.
- **Config file** — `svelte-grab.config.json` with `loadConfig()`, `saveConfig()`, `showDiff()` utilities.
- **Help text** — Step-by-step Claude Code integration guide in CLI help output.

### Utilities

- `parse-activation-key.ts` — Configurable activation key parsing for keyboard shortcuts.
- `safe-polygon.ts` — Triangle-based hover zone tracking for dropdown menus.
- `copy-content.ts` — Multi-format clipboard (text/plain + text/html + application/x-svelte-grab).
- `action-cycle.ts` — Cycle through a list of actions with `next()`/`reset()`/`current`.
- `element-visibility.ts` — Element visibility checker using computed styles.
- `confirmation-focus-manager.ts` — Singleton focus manager for confirmation dialogs.
- `log-intro.ts` — Console intro banner with npm registry version check.

## 1.3.0 (2026-03-04)

### Documentation

- **README:** Add 3 missing props to SvelteGrab props table (`copyOnKeyboard`, `projectRoot`, `showActiveIndicator`)
- **README:** Expand theming section with `lightTheme` + `theme` override semantics and example
- **types.ts:** Add JSDoc to all properties in `SvelteStateGrabProps`, `SvelteStyleGrabProps`, `SveltePropsTracerProps`, `SvelteA11yReporterProps`, `SvelteErrorContextProps`, `SvelteRenderProfilerProps`
- **types.ts:** Document `secondaryModifier` rationale (different defaults avoid shortcut conflicts) and `ThemeConfig` override pattern
- **CLI:** Expand `help` text with detailed command descriptions, usage examples, and `--version` / `-v` flag

### DX Improvements

- **SvelteGrab:** Cursor changes to crosshair when selection mode is active (hold & toggle modes)
- **SvelteGrab:** First-time hint toast on activation ("Alt+Click to grab | Alt+? for help"), shown once per session
- **SvelteGrab:** Add `Alt+?` help overlay listing all SvelteGrab-specific keyboard shortcuts
- **SvelteGrab:** Actionable "no component found" messages now include the element tag and guidance
- **SvelteGrab:** Expanded "disabled" message listing possible causes (production build, Svelte 4, SSR-only)
- **SvelteGrab:** Better `html-to-image` missing dependency message with recovery guidance
- **SvelteStateGrab:** Actionable "no component found" message with element tag and guidance
- **SveltePropsTracer:** Actionable "no component found" message with element tag and guidance
- **CLI relay:** Better Claude Code SDK missing message explaining when it's needed

### Features

- **CLI init:** Support Vite+Svelte projects (detects `vite.config` + `src/App.svelte`, injects `SvelteDevKit`)
- **CLI init:** Add `--dry-run` flag to preview changes without writing files
- **Relay server:** Auto-port selection — if preferred port is in use, automatically tries next available
- **MCP server:** Auto-port selection — replaces manual `EADDRINUSE` error with automatic fallback

### Robustness

- **global-api:** Warn on multiple `<SvelteGrab />` / `<SvelteDevKit />` instances with guidance to use a single root instance
- **SvelteGrab:** Smarter `detectProjectRoot()` with `/src/routes/` SvelteKit pattern and `import.meta.env.BASE_URL` fallback
- **SvelteDevKit:** Add clarifying comment that `{#if isEnabled}` already prevents mounting disabled tools (no tree-shaking needed)

### Internal

- Add shared `findAvailablePort()` utility (`src/utils/port.ts`) for relay and MCP servers
- Include `src/utils/` in `tsconfig.server.json` compilation

## 1.2.0 (2026-03-04)

### Bug Fixes

- **SvelteGrab:** Fix "Open in Editor" not working — `window.open()` silently fails for custom protocol URLs (`vscode://`, `cursor://`, etc.); now uses anchor element click which reliably triggers protocol handlers ([#6](https://github.com/HeiCg/svelte-grab/issues/6))
- **SvelteGrab:** Fix `detectProjectRoot` treating Vite dev-relative paths (`/src/...`, `/lib/...`) as absolute, which produced empty root strings and broken editor URLs
- **SvelteGrab:** Add console warning when editor URL cannot be resolved to an absolute path, with guidance to set the `projectRoot` prop

## 1.1.0 (2026-02-25)

### Bug Fixes

- **SvelteGrab:** Fix setTimeout/onDestroy race condition — if the component unmounts within 100ms, event listeners are no longer registered on a destroyed component
- **profiler-tracker:** Fix `detectBursts` early-exit that skipped per-component analysis when total events were below threshold
- **profiler-tracker:** Fix `characterData` mutations being silently discarded (`Text` nodes are not `HTMLElement`) — now uses `parentElement` as target
- **profiler-tracker:** Cache `detectBursts()` results with dirty-flag invalidation to avoid redundant recomputation
- **agent-client:** Fix pending request history entry being silently overwritten when a new request arrives before the previous one completes
- **agent-client:** Add exponential backoff with 60s cap to WebSocket reconnect (was fixed 3s)
- **agent-client:** Fix `disconnect()` not resolving pending requests — now calls `onError` and saves to history
- **SvelteRenderProfiler:** Add explicit `clearInterval(countdownInterval)` guard in `onDestroy`
- **css-analyzer:** Add explicit parentheses for operator precedence clarity in property filter
- **css-analyzer:** Include inline styles in conflict detection (`propertyRules` map)
- **css-analyzer:** Descend into `@supports` rules (like `@media` rules) when the condition is supported

### Performance

- **profiler-tracker:** Replace O(N*M) event filtering in `getProfiles()` with pre-grouped `Map<file, events[]>` for O(1) lookup

### Features

- **SvelteGrab:** Enrich `formatForAgent()` output — now includes element tag/role/text, component name, and full numbered component stack (not just 2 paths)
- **SvelteDevKit:** Forward all SvelteGrab props (`autoCopyFormat`, `showPopup`, `includeHtml`, `copyOnKeyboard`, `enableScreenshot`, `enableMultiSelect`, `showActiveIndicator`, `maxHistorySize`) and sub-tool config props (`stateSecondaryModifier`, `styleSecondaryModifier`, `maxSnapshots`, `profileDuration`, `burstThreshold`, `burstWindow`, `maxErrors`, `bufferMinutes`, `filterNodeModules`, `showCategories`, `includeSubtree`)
- **SvelteDevKit:** Add help overlay (Alt+?) showing all active keyboard shortcuts based on enabled tools
- **CLI init:** Use `SvelteDevKit` instead of `SvelteGrab` in generated layouts
- **CLI init:** Add Svelte 5+ version check with clear error message
- **CLI init:** Skip `<script context="module">` tags when injecting imports
- **CLI init:** Wrap `<SvelteDevKit />` in `{#if dev}` gate using `$app/environment`
- **All components:** Show "Copy failed" feedback when clipboard API fails (SvelteGrab, SvelteStateGrab, SvelteStyleGrab, SveltePropsTracer, SvelteA11yReporter, SvelteErrorContext)

### Code Quality

- **SvelteGrab:** Deduplicate utility functions — now imports `detectDevMode`, `shortenPath`, `isExcludedPath`, `extractComponentName`, `checkModifier`, `copyToClipboard` from `shared.ts` instead of defining local copies
- **shared.ts:** Remove dead `resolveTheme` function

## 1.0.1

Initial release.
