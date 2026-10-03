# svelte-grab

A complete dev tool suite for Svelte 5 that captures component context for LLM coding agents. Alt+Click any element to get exact file locations, inspect state, analyze styles, audit accessibility, trace errors, and profile renders — all formatted for AI prompts.

Inspired by [React Grab](https://github.com/aidenybai/react-grab) which demonstrated 3x speedup for React projects.

## The Problem

Coding agents are slow at frontend because translating intent is lossy:

1. You want to change a button's spacing
2. You describe it: "make the button in the header bigger"
3. The agent searches the codebase (grep, glob, multiple attempts)
4. Eventually finds the file and makes the change

This search phase is slow and non-deterministic.

## The Solution

svelte-grab eliminates the search phase entirely:

1. Alt+Click the element you want to change
2. Type your instruction right there in the overlay
3. Claude Code receives component context + your prompt and acts immediately

```
<button class="btn-primary"> in src/lib/components/Header.svelte:42
  in src/routes/+layout.svelte:15

User instruction: Make this button bigger and change the color to blue
```

## Quick Start: Claude Code Integration

The fastest way to use svelte-grab with Claude Code:

### 1. Install

```bash
npm install svelte-grab
```

### 2. Add to your layout

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { SvelteDevKit } from 'svelte-grab';
</script>

{@render children()}
<SvelteDevKit enableMcp />
```

### 3. Configure Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "svelte-grab": {
      "command": "npx",
      "args": ["svelte-grab-mcp", "--stdio"]
    }
  }
}
```

### 4. Use it

In Claude Code, say:

> "use watch_for_grab to listen for my selections"

Then in your browser:
1. **Alt+Click** any element
2. **Type your prompt** in the overlay (e.g. "make this button bigger")
3. **Cmd+Enter** to send

Claude Code receives everything — file paths, component stack, HTML preview, and your instruction — and makes the change.

The overlay shows a **green dot** when Claude Code is listening and a **red dot** when disconnected.

```
Browser                    MCP Server                  Claude Code
   |                           |                            |
   |  Alt+Click + prompt       |                            |
   |------ POST /context ----->|                            |
   |                           |-- resolve watch_for_grab ->|
   |                           |                            |-- reads files, makes change
   |<---- SSE: processing -----|                            |
```

## Tools Overview

svelte-grab ships 7 specialized tools + a unified wrapper:

| Tool | Trigger | What it does |
|------|---------|--------------|
| **SvelteGrab** | Alt+Click | Component location stack with file:line |
| **SvelteStateGrab** | Alt+Shift+Click | Props, attributes, bound values inspection |
| **SvelteStyleGrab** | Alt+Ctrl+Click | CSS analysis with source attribution |
| **SveltePropsTracer** | Alt+DoubleClick | Component hierarchy trace |
| **SvelteA11yReporter** | Alt+RightClick / Alt+A | Accessibility audit with WCAG scoring |
| **SvelteErrorContext** | Alt+E | Console errors/warnings with stack parsing |
| **SvelteRenderProfiler** | Alt+P | DOM mutation profiling per component |
| **SvelteDevKit** | (wrapper) | All tools in one component |

## Installation

```bash
npm install svelte-grab
# or
yarn add svelte-grab
# or
pnpm add svelte-grab
```

### Setup

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { SvelteGrab } from 'svelte-grab';
</script>

{@render children()}
<SvelteGrab />
```

Or use **SvelteDevKit** to enable all tools at once:

```svelte
<script>
  import { SvelteDevKit } from 'svelte-grab';
</script>

{@render children()}
<SvelteDevKit />
```

Or use the CLI to auto-inject:

```bash
npx svelte-grab init
```

## SvelteGrab — Component Inspector

The core tool. Hold Alt, hover to see file:line tooltips, click to capture the component stack.

### Features

- **Selection mode** — Hold Alt to highlight elements with Svelte metadata
- **Multi-select** — Shift+Alt+Click to select multiple elements
- **Drag selection** — Click+drag in selection mode to box-select elements (point-sampling grid)
- **Editor integration** — Press `O` to open file in VSCode, Cursor, WebStorm, Zed, or Sublime
- **Screenshot capture** — Press `S` to capture element screenshot (requires `html-to-image`)
- **Context menu** — Right-click in selection mode for quick actions
- **Floating toolbar** — Optional draggable toolbar for common actions
- **History** — Tracks last 20 grabs with timestamps, persisted to sessionStorage
- **Arrow navigation** — Use arrow keys in selection mode to walk the component tree
- **Prompt mode** — Type instructions inline and send directly to Claude Code
- **Annotation mode** — Press `N` while selecting to note "change this" on an element or a selection, collect several, then send them as one task (see [Annotation mode](#annotation-mode))
- **Agent relay** — Send selections to Claude Code or other agents via WebSocket
- **MCP integration** — Direct bridge to Claude Code with live connection status
- **Animation freezing** — Pauses CSS animations/transitions during selection for stable captures
- **Pseudo-state preservation** — Freezes :hover/:focus states so you can grab transient UI
- **Session management** — Undo, redo, resume, and retry agent actions from the UI
- **Plugin system** — Extend with custom hooks, actions, and content transforms
- **Keyboard copy** — Cmd+C / Ctrl+C to copy in selection mode

### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `modifier` | `'alt' \| 'ctrl' \| 'meta' \| 'shift'` | `'alt'` | Modifier key to activate |
| `activationMode` | `'hold' \| 'toggle'` | `'hold'` | Hold modifier vs toggle on/off |
| `autoCopyFormat` | `'agent' \| 'paths' \| 'none'` | `'agent'` | Clipboard format on grab |
| `showPopup` | `boolean` | `true` | Show visual popup |
| `includeHtml` | `boolean` | `true` | Include HTML preview in output |
| `editor` | `'vscode' \| 'cursor' \| 'webstorm' \| 'zed' \| 'sublime' \| 'none'` | `'vscode'` | Editor for "Open in Editor" |
| `enableScreenshot` | `boolean` | `true` | Enable screenshot capture |
| `enableMultiSelect` | `boolean` | `true` | Enable multi-selection |
| `enableDragSelect` | `boolean` | `true` | Enable drag box selection |
| `enableArrowNav` | `boolean` | `true` | Enable arrow key navigation |
| `showToolbar` | `boolean` | `false` | Show floating toolbar |
| `showContextMenu` | `boolean` | `true` | Enable right-click context menu |
| `maxHistorySize` | `number` | `20` | Max grab history entries |
| `forceEnable` | `boolean` | `false` | Force enable if dev detection fails |
| `theme` | `ThemeConfig` | — | Custom theme colors |
| `lightTheme` | `boolean` | `false` | Use light theme preset |
| `plugins` | `SvelteGrabPlugin[]` | `[]` | Registered plugins |
| `enableAgentRelay` | `boolean` | `false` | Enable WebSocket relay |
| `agentRelayUrl` | `string` | `'ws://localhost:4722'` | Relay server URL |
| `agentId` | `string` | `'claude-code'` | Agent identifier |
| `enableMcp` | `boolean` | `false` | Enable MCP bridge to Claude Code |
| `mcpPort` | `number` | `4723` | MCP server port. If the server is not there, the page probes the next 9 ports via `/health` |
| `mcpToken` | `string` | — | Token for an MCP server started with `SVELTE_GRAB_TOKEN` / `--token` (sent as `x-svelte-grab-token` on POSTs, `?token=` on `/events`) |
| `enableAgentRuntime` | `boolean` | `true` | With `enableMcp`, let coding agents query the page (`ui_snapshot`, `ui_find`, `ui_inspect`, `ui_wait_for_hmr`, ...) through the MCP server |
| `freezeAnimations` | `boolean` | `true` | Freeze CSS animations during selection |
| `freezePseudoStates` | `boolean` | `true` | Preserve :hover/:focus states during selection |
| `enableHistoryPersistence` | `boolean` | `true` | Persist history to sessionStorage |
| `enablePromptMode` | `boolean` | `true` | Enable inline prompt overlay |
| `enableAnnotations` | `boolean` | `true` | Annotation mode: `N` while selecting (or "Add annotation" in the prompt overlay) stores the hovered element or the current selection with a comment |
| `hotkeys` | `'full' \| 'minimal'` | `'full'` | Shortcut set. `'minimal'`: only Alt+Click, Shift+Alt+Click, Alt+Drag, Escape and `N`. See [Minimal hotkeys](#minimal-hotkeys) |
| `copyOnKeyboard` | `boolean` | `true` | Enable Cmd+C / Ctrl+C to copy in selection mode |
| `projectRoot` | `string` | `''` | Absolute path to project root (for "Open in Editor"). Not needed with the `svelte-grab/vite` plugin, which provides it |
| `showActiveIndicator` | `boolean` | `true` | Show active indicator badge |

### Annotation mode

Collect several "change this" notes, then hand them to the agent as one task:

1. Hold Alt and hover an element, or select several (Shift+Alt+Click, Alt+Drag).
2. Press `N` (still holding Alt). An editor opens next to the cursor; you can release Alt and type the comment. Enter adds it as annotation `#1` (Shift+Enter for a new line, Esc cancels). The prompt overlay (Enter while selecting) also has an "Add annotation" button, and the multi-select bar has "Annotate".
3. Annotated elements get a numbered badge. A tray in the bottom-left corner lists the annotations: edit or delete each comment, add one instruction for all of them, or "Clear all".
4. "Send all" copies one agent text to the clipboard (per annotation: `#N`, comment, and each element's ref, component, `file:line` and `ui://` stable key) and, with `enableMcp`, posts it to the MCP server's `/context` endpoint, so `watch_for_grab` / `get_element_context` receive it.

The annotations stay pending for the agent until it reads them with `ui_annotations({ clear: true })` or you clear the tray. `N` was picked because Alt+A already opens the a11y audit in SvelteDevKit.

### Minimal hotkeys

`hotkeys="minimal"` (on SvelteGrab or SvelteDevKit) keeps only the shortcuts that point at UI: Alt+Click (point), Shift+Alt+Click (multi), Alt+Drag (region), Escape and `N` (annotate). Everything else is off: Enter, `O`, `S`, Tab, arrows, Cmd/Ctrl+C, Alt+? and the right-click menu in SvelteGrab; in SvelteDevKit also Alt+Shift+Click (state), Alt+Ctrl+Click (style), Alt+DoubleClick (tracer), Alt+RightClick / Alt+A (a11y), Alt+E (errors), Alt+P (profiler), Alt+Shift+C and Alt+?. Those tools stay mounted, so error capture keeps running and the MCP runtime can still use their logic. Each tool also takes `enableHotkeys={false}` on its own. The default (`'full'`) is unchanged.

```svelte
<SvelteDevKit enableMcp hotkeys="minimal" />
```

### Output Formats

**Agent format** (default) — optimized for pasting into AI prompts:

```
<button class="btn-primary"> in src/lib/components/Button.svelte:23
  in src/lib/components/Form.svelte:45
  in src/routes/contact/+page.svelte:12
```

**Paths format** — simple file:line:column:

```
src/lib/components/Button.svelte:23:5
src/lib/components/Form.svelte:45:3
src/routes/contact/+page.svelte:12:1
```

## SvelteStateGrab — State Inspector

Alt+Shift+Click any element to inspect its component state.

**Shows:** Props, HTML attributes, data attributes, bound values (form inputs, text content), child component count, and component location.

```svelte
<SvelteStateGrab />
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `modifier` | modifier key | `'alt'` | Primary modifier |
| `secondaryModifier` | `'shift' \| 'ctrl' \| 'meta'` | `'shift'` | Secondary modifier |
| `maxDepth` | `number` | `3` | Max object nesting depth |
| `maxStringLength` | `number` | `200` | Truncate long strings |

Handles circular references, functions, DOM elements, Maps, and Sets safely.

## SvelteStyleGrab — CSS Inspector

Alt+Ctrl+Click to analyze computed styles with source attribution.

**Detects style sources:** inline styles, Svelte-scoped (`svelte-XXXX`), Tailwind classes, external CSS, inherited, and user-agent defaults. Calculates CSS specificity and identifies overridden properties and conflicts.

```svelte
<SvelteStyleGrab />
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `modifier` | modifier key | `'alt'` | Primary modifier |
| `secondaryModifier` | `'shift' \| 'ctrl' \| 'meta'` | `'ctrl'` | Secondary modifier |
| `showCategories` | `('box-model' \| 'visual' \| 'typography' \| 'layout' \| 'all')[]` | `['all']` | Which categories to show |

**Categories:** Box Model (width, height, padding, margin, border), Visual (background, color, opacity, shadow), Typography (font, line-height, text-align), Layout (display, position, flex, grid, z-index).

## SveltePropsTracer — Hierarchy Tracer

Alt+DoubleClick to trace the full component hierarchy from any element to root.

Shows the complete tree with file:line locations, depth indicators, and visual connectors. Warns about deep nesting (>5 levels) and suggests using Context API or stores.

```svelte
<SveltePropsTracer />
```

## SvelteA11yReporter — Accessibility Auditor

Alt+RightClick an element to audit it, or Alt+A to audit the entire page.

**Checks:** WCAG color contrast (AA/AAA), missing alt text, unlabeled form inputs, ARIA attribute validity, heading hierarchy, focus order, and semantic HTML usage. Returns an accessibility score (0-100) with categorized issues (Critical / Warnings / Passes) and fix suggestions with code examples.

```svelte
<SvelteA11yReporter />
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `includeSubtree` | `boolean` | `true` | Audit child elements too |

## SvelteErrorContext — Error Capture

Alt+E to view captured errors and warnings.

Intercepts `console.error`, `console.warn`, uncaught exceptions, and unhandled promise rejections. Parses stack traces (Chrome, Firefox, Safari), deduplicates repeated errors, correlates with Svelte components, and detects common error patterns with fix suggestions.

```svelte
<SvelteErrorContext />
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `maxErrors` | `number` | `50` | Max captured errors |
| `bufferMinutes` | `number` | `5` | Error retention window |
| `filterNodeModules` | `boolean` | `true` | Hide node_modules frames |

## SvelteRenderProfiler — Performance Profiler

Alt+P to start a profiling session (default 10 seconds).

Uses MutationObserver to track DOM mutations, correlates them with Svelte components, and detects render bursts (20+ renders in 1 second). Heat-colored display: green (0-10), orange (10-20), yellow (20-50), red (50+).

```svelte
<SvelteRenderProfiler />
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `profileDuration` | `number` | `10` | Profiling duration in seconds |
| `burstThreshold` | `number` | `20` | Renders to trigger burst detection |
| `burstWindow` | `number` | `1000` | Burst detection window in ms |

## SvelteDevKit — All-in-One

Single component that includes all 7 tools. Selectively enable/disable tools:

```svelte
<script>
  import { SvelteDevKit } from 'svelte-grab';
</script>

<!-- All tools enabled by default -->
<SvelteDevKit />

<!-- Only specific tools -->
<SvelteDevKit enabledTools={['grab', 'state', 'a11y']} />

<!-- With Claude Code integration -->
<SvelteDevKit enableMcp />
```

Accepts all SvelteGrab props plus:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `enabledTools` | `DevKitTool[]` | all tools | Which tools to activate |
| `hotkeys` | `'full' \| 'minimal'` | `'full'` | `'minimal'` turns off every tool trigger except Alt+Click, Shift+Alt+Click, Alt+Drag, Escape and `N`; the tools stay mounted ([Minimal hotkeys](#minimal-hotkeys)) |

Available tools: `'grab'`, `'state'`, `'style'`, `'props'`, `'a11y'`, `'errors'`, `'profiler'`

## Claude Code Integration (MCP)

The recommended way to connect svelte-grab to Claude Code. Select a component, type your instruction, and Claude Code acts on it — no copy-paste needed.

### How it works

1. Claude Code connects to svelte-grab's MCP server via stdio
2. It calls `watch_for_grab`, which **blocks** until you send something from the browser
3. You Alt+Click an element, type your prompt, hit Cmd+Enter
4. The MCP tool resolves with the full component context + your instruction
5. Claude Code reads the files and makes the change
6. Call `watch_for_grab` again for the next instruction

### Setup

**1. Configure Claude Code** (`~/.claude.json`):

```json
{
  "mcpServers": {
    "svelte-grab": {
      "command": "npx",
      "args": ["svelte-grab-mcp", "--stdio"]
    }
  }
}
```

**2. Enable in your app:**

```svelte
<SvelteDevKit enableMcp />
```

**3. In Claude Code, say:**

> "use watch_for_grab to listen for my selections"

**4. In the browser:**

- Alt+Click any element — the prompt overlay appears
- Type what you want changed
- Cmd+Enter to send to Claude Code
- The green dot means Claude Code is listening; red means disconnected

### MCP Tools

| Tool | Description |
|------|-------------|
| `watch_for_grab` | **Blocks** until the user sends context from the browser. Returns component stack, HTML preview, and the user's instruction. Call in a loop for continuous interaction. |
| `get_element_context` | Returns the last grabbed context immediately (non-blocking). Context is cleared after reading. |
| `get_a11y_report` | Returns the last accessibility audit from SvelteA11yReporter. |
| `get_style_context` | Returns the last CSS analysis from SvelteStyleGrab. |
| `get_error_context` | Returns captured console errors from SvelteErrorContext. |
| `get_profiler_report` | Returns render profiling data from SvelteRenderProfiler. |
| `undo_last_action` | Returns an undo instruction with the original context. |
| `get_session_history` | Returns recent interactions (up to 20) with timestamps and prompts. |
| `list_available_tools` | Lists which tools have data available and when it was captured. |
| `ui_tabs` | Lists connected browser tabs (`tabId`, url, title, focused, lastSeen, active). `ui_*` tools target the active tab (last focused, else most recently seen) unless given `tabId`. |
| `ui_snapshot` | Compact tree of the live UI: only elements with Svelte metadata or an a11y role/name, one line each (`eN <role/tag> "<name>" <Component> <file:line>`). Args: `scope`, `detail`, `maxNodes`, `tabId`. |
| `ui_find` | Finds elements by `text`, `role`, `name`, `component`, `file` or `selector` (plus `limit`, `tabId`). Returns refs with stable key, component, source, role, name, box and visibility. |
| `ui_inspect` | The heavy, on-demand context for one element (`ref`: `eN` or `ui://` key). Sections COMPONENT, SOURCE, STACK, PROPS/ATTRIBUTES, STATE, LAYOUT (box, overflow, visibility), STYLES (matched rules with source, Tailwind/scoped detection), A11Y (role, name, contrast, issues) and USAGE (other instances with refs). Args: `ref`, `include` (subset of `stack`, `props`, `state`, `styles`, `layout`, `a11y`, `usage`; default all), `tabId`. Text is capped at ~8000 chars. Use `ui_snapshot`/`ui_find` first. |
| `ui_annotations` | The human's pending annotations ([Annotation mode](#annotation-mode)): `{ annotations: [{ id, comment, refs: [{ ref, stableKey, component, source }], createdAt }], instruction }` plus the same as text. Refs are re-resolved (rebound by stable key after a re-render, `stale` when gone) and work with `ui_inspect`. Args: `clear` (mark them consumed; the tray empties), `tabId`. |
| `ui_wait_for_hmr` | Call right after editing a file. Waits for the Vite HMR update (or full reload) touching `files` (suffix match; any update when omitted), lets the DOM settle, re-resolves every ref and returns `{ status, updated, errors, rebound: [{from,to}], lost, kept, consoleErrors, source }`. Args: `files`, `timeoutMs` (default 15000, max 55000), `since` (epoch ms, also accepts an update that already happened, from the last 20), `tabId`. |

The `ui_*` tools query the page live: the app must be open in dev with `<SvelteGrab/>` mounted (otherwise they return "No browser tab connected"). Refs are stamped on elements as `data-sg-ref`, so `[data-sg-ref="e12"]` works as a locator in Playwright MCP or chrome-devtools MCP for real clicks and screenshots.

### Agent runtime (page side)

With `enableMcp` (and `enableAgentRuntime`, on by default), the page also answers agent queries relayed by the MCP server: it listens for `runtime-command` events on `/events`, announces itself with `POST /runtime/hello` (on connect, focus/blur/visibility change and every 15s) and replies with `POST /runtime/result`. Dev builds only; it stays off when Svelte dev metadata is absent.

- `ui_snapshot` returns an indented outline of the page, one line per element with Svelte source info or a useful role/name: `e12 button "Save" Button src/lib/Button.svelte:11`.
- `ui_find` locates elements by `text`, `role`, `name`, `component`, `file` or `selector`.
- `ui_inspect` returns the full context of one ref: component, source, stack, props/attributes, `inspectable()` state, layout, matched styles, accessibility and other instances of the same component. A stale ref is re-resolved by its stable key and reported as rebound.
- `ui_annotations` returns the annotations collected in the page tray, with their refs registered so `ui_inspect` and `[data-sg-ref]` work on them.
- Every reported element gets a session ref (`e12`) stamped as `data-sg-ref`, so other tools (Playwright MCP, chrome-devtools-mcp) can act on it with the locator `[data-sg-ref="e12"]`. Each result also carries a stable key (`ui://<file>:<line>:<col>#<Component>[role=..,name=..][i]`) that re-resolves after re-renders.

Set `enableAgentRuntime={false}` to keep the MCP bridge without the runtime.

### Vite plugin (`svelte-grab/vite`)

Optional, dev server only (`apply: 'serve'`; production builds never see it). Add it after your framework plugin:

```ts
// vite.config.ts (SvelteKit)
import { sveltekit } from '@sveltejs/kit/vite';
import { svelteGrab } from 'svelte-grab/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit(), svelteGrab()]
});
```

```ts
// vite.config.ts (plain Vite + Svelte)
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteGrab } from 'svelte-grab/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte(), svelteGrab()]
});
```

What it adds:

- **HMR bridge.** A small client module forwards Vite's HMR events (`vite:beforeUpdate`, `vite:afterUpdate`, `vite:beforeFullReload`, `vite:error`) to the page as `svelte-grab:hmr` window events. It is injected into `index.html` and into every app module that imports `svelte-grab` (SvelteKit renders its own HTML). `ui_wait_for_hmr` uses `import.meta.hot` directly when Vite provides it (it does in every setup we tested, see below) and falls back to the bridge; without either it falls back to watching DOM mutations (`source: "heuristic"`, no file list).
- **Module-graph importers.** `GET /__svelte-grab/importers?file=Card.svelte` returns `{ found, matches, importers: [{ file, url }] }` from Vite's module graph (path, root-relative path or suffix). Same-origin requests only (cross-origin `Origin` / `Sec-Fetch-Site` get a 403).
- **Open in editor.** The client sets `window.__SVELTE_GRAB_VITE__ = { version, root, ... }`. SvelteGrab then opens files through Vite's built-in `/__open-in-editor` (launch-editor, which picks up the running editor or `LAUNCH_EDITOR`) with the real project root, and falls back to the `editor` deep link if that request fails. `projectRoot` is no longer needed.

Options: `svelteGrab({ hmrBridge: false, importers: false })` turns each part off.

`ui_wait_for_hmr` works without the plugin too: Vite injects `import.meta.hot` into svelte-grab's modules both when the package is pre-bundled by `optimizeDeps` (the default) and when it is excluded and served from `node_modules` (checked with Vite 6 + vite-plugin-svelte 5 and Vite 8 + vite-plugin-svelte 7).

### HTTP Endpoints

The MCP server also exposes HTTP endpoints (available in both stdio and HTTP modes):

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check with server identity and agent status (no Origin/token check) |
| `GET` | `/events` | SSE stream for real-time browser status updates |
| `POST` | `/context` | Receive context from browser |
| `POST` | `/runtime/hello` | Browser tab registration and heartbeat for the `ui_*` tools |
| `POST` | `/runtime/result` | Browser tab answer to a `runtime-command` SSE event |
| `POST` | `/mcp` | MCP protocol endpoint (stateless Streamable HTTP; served in HTTP mode and by the stdio sidecar) |

POST bodies are capped at 2 MB. A larger body gets a `413 {"error":"Request body too large"}` response and the connection is closed.

### Port fallback and server identity

The server listens on `4723` by default (`--port=<n>` to change it). If that port is busy it tries the next ones, up to 10 ports in total (`4723`-`4732` by default), and logs the port it picked on stderr:

```
[svelte-grab mcp] Port 4723 was in use, using 4724 instead. The page finds it by probing GET /health on 4723-4732; pass mcpPort=4724 ...
```

The page follows the fallback on its own. It checks `GET /health` on `mcpPort` first; when nothing answers there, or another service does, it probes the next 9 ports and uses the first one whose `service` is `svelte-grab-mcp`, logging the port it picked in the browser console. The result is cached for the page load. Passing the port directly skips the probe:

```svelte
<SvelteGrab enableMcp mcpPort={4724} />
```

`GET /health` identifies the server, so you (or a script) can check what is answering on a port:

```json
{
  "status": "ok",
  "service": "svelte-grab-mcp",
  "version": "1.4.2",
  "port": 4724,
  "preferredPort": 4723,
  "portFallback": true,
  "hasContext": false,
  "agentWatching": false,
  "watcherCount": 0,
  "sseClients": 0
}
```

The range is exported from `svelte-grab/mcp` as `DEFAULT_MCP_PORT`, `MCP_PORT_RANGE_SIZE`, `MCP_PORT_RANGE_END` and `MCP_SERVICE_ID`.

### Alternative: HTTP mode

If you prefer not to use stdio, start the MCP server as a standalone HTTP process:

```bash
npx svelte-grab mcp
npx svelte-grab mcp --port=4723
```

Then configure Claude Code to connect via HTTP:

```json
{
  "mcpServers": {
    "svelte-grab": {
      "type": "url",
      "url": "http://localhost:4723/mcp"
    }
  }
}
```

### Programmatic usage

```typescript
import { startMcpServer } from 'svelte-grab/mcp';

// HTTP mode
const server = await startMcpServer({ port: 4723 });

// Stdio mode (for direct agent integration)
await startMcpServer({ stdio: true });
```

## Agent Relay (WebSocket)

An alternative to MCP for agents that support WebSocket connections. The relay bridges browser selections to agent providers.

### 1. Start the relay server

```bash
npx svelte-grab relay
npx svelte-grab relay --port=4722 --provider=claude-code
```

### 2. Enable in your app

```svelte
<SvelteGrab enableAgentRelay agentRelayUrl="ws://localhost:4722" />
```

### 3. Programmatic relay

```typescript
import { createRelayServer, ClaudeCodeProvider } from 'svelte-grab/relay';

const server = await createRelayServer({
  port: 4722,
  providers: [new ClaudeCodeProvider()]
});
```

### Supported Providers

| Provider | CLI name | SDK |
|----------|----------|-----|
| Claude Code | `claude-code` | `@anthropic-ai/claude-agent-sdk` |
| Cursor | `cursor` | `cursor-agent` CLI |
| Copilot | `copilot` | `copilot` CLI |
| Codex | `codex` | `@openai/codex-sdk` |

### Session Management

The relay supports full session lifecycle — undo, redo, resume, and retry.

- **Undo** — Revert the last agent change
- **Resume** — Follow-up instruction in the same session context
- **Retry** — Re-send a failed request
- **History** — Browse all past interactions with timestamps

```typescript
import { AgentClient } from 'svelte-grab/core';

const client = new AgentClient();
client.connect('ws://localhost:4722');

client.undo();
client.redo();
client.resume('Now make it responsive');
client.retry();
client.getHistory();
```

## CLI

```bash
npx svelte-grab <command> [options]
```

| Command | Description |
|---------|-------------|
| `init` | Auto-inject SvelteDevKit into your root layout |
| `add <provider>` | Add an agent provider (claude-code, cursor, copilot, codex) |
| `remove <provider>` | Remove an agent provider |
| `configure` | Interactive configuration (activation key, editor, ports, theme) |
| `relay` | Start the WebSocket relay server |
| `mcp` | Start the MCP server |
| `help` | Show help |

```bash
npx svelte-grab init                     # Add to your SvelteKit project
npx svelte-grab init --dry-run           # Preview changes without writing
npx svelte-grab add cursor               # Add Cursor agent provider
npx svelte-grab remove copilot           # Remove Copilot provider
npx svelte-grab configure                # Interactive configuration
npx svelte-grab relay --provider=cursor  # Start relay with Cursor provider
npx svelte-grab mcp --stdio              # Start MCP server for Claude Code
```

## Plugin System

Extend SvelteGrab with custom hooks, context menu actions, and content transforms.

```typescript
import type { SvelteGrabPlugin } from 'svelte-grab';

const myPlugin: SvelteGrabPlugin = {
  name: 'my-plugin',
  version: '1.0.0',

  hooks: {
    onElementGrab(element, stack) {
      console.log('Grabbed:', element, stack);
    },
    beforeCopy(context) {
      return context.content + '\n// Added by my-plugin';
    }
  },

  actions: [
    {
      id: 'my-action',
      label: 'My Action',
      icon: '...',
      onAction: ({ element, stack }) => { /* ... */ }
    }
  ],

  setup(api) {
    // Access the SvelteGrab API
  },

  teardown() {
    // Cleanup
  }
};
```

```svelte
<SvelteGrab plugins={[myPlugin]} />
```

### Available Hooks

| Hook | When it fires |
|------|---------------|
| `onActivate` | Selection mode activated |
| `onDeactivate` | Selection mode deactivated |
| `onElementHover` | Element hovered in selection mode |
| `onElementGrab` | Element grabbed (clicked) |
| `onSelectionChange` | Multi-selection changes |
| `beforeCopy` | Before clipboard copy (return string to modify) |
| `afterCopy` | After clipboard copy |
| `beforeAgentSend` | Before sending to agent relay |
| `afterAgentResponse` | After agent responds |

## Global API

SvelteGrab exposes a programmatic API on `window.__SVELTE_GRAB__`:

```typescript
window.__SVELTE_GRAB__.activate();      // Enable selection mode
window.__SVELTE_GRAB__.deactivate();    // Disable selection mode
window.__SVELTE_GRAB__.toggle();        // Toggle selection mode
window.__SVELTE_GRAB__.isActive();      // Check if active
window.__SVELTE_GRAB__.grab(element);   // Get component stack
window.__SVELTE_GRAB__.copyElement(el); // Copy element to clipboard
window.__SVELTE_GRAB__.getHistory();    // Get grab history
window.__SVELTE_GRAB__.getSelectedElements(); // Get multi-selected elements
window.__SVELTE_GRAB__.clearSelection();      // Clear multi-selection
window.__SVELTE_GRAB__.registerPlugin(plugin); // Register a plugin
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| **Alt+Click** | Grab component stack |
| **Shift+Alt+Click** | Multi-select element |
| **Alt+Shift+Click** | Inspect component state |
| **Alt+Ctrl+Click** | Analyze CSS styles |
| **Alt+DoubleClick** | Trace component hierarchy |
| **Alt+RightClick** | Audit accessibility |
| **Alt+A** | Audit entire page accessibility |
| **Alt+E** | View captured errors |
| **Alt+P** | Profile renders |
| **O** | Open in editor (when popup visible) |
| **S** | Screenshot element (when popup visible) |
| **Arrow keys** | Navigate component tree (selection mode) |
| **Tab** | Open prompt overlay (selection mode) |
| **Cmd/Ctrl+C** | Copy hovered element (selection mode) |
| **N** | Annotate the hovered element or the selection (selection mode) |
| **Cmd/Ctrl+Enter** | Send prompt to agent |
| **Escape** | Close popup / exit selection mode |

With `hotkeys="minimal"` only Alt+Click, Shift+Alt+Click, Alt+Drag, `N` and Escape remain ([Minimal hotkeys](#minimal-hotkeys)).

## Theming

All tools share the same two-prop theme system:

- **`lightTheme`** — selects the base preset (dark by default, light when `true`)
- **`theme`** — overrides individual colors on top of the chosen preset

```svelte
<!-- Dark theme (default) -->
<SvelteGrab />

<!-- Light theme -->
<SvelteGrab lightTheme />

<!-- Light theme with custom accent -->
<SvelteGrab lightTheme theme={{ accent: '#ff6b35' }} />

<!-- Custom colors on dark base -->
<SvelteGrab
  theme={{
    background: '#0d1117',
    border: '#30363d',
    text: '#c9d1d9',
    accent: '#58a6ff'
  }}
/>
```

Available theme keys: `background`, `border`, `text`, `accent`.

## Security

svelte-grab is a **development-only** tool. The relay (WebSocket) and MCP (HTTP) servers bridge your browser to a local coding agent that can **execute shell commands and edit files on your machine**. Treat these servers like a local shell — they must never be reachable from a network.

The servers ship with these protections enabled by default:

- **Loopback only.** Both servers bind to `127.0.0.1`. They are not reachable from other hosts on your LAN. Do not put them behind a reverse proxy, tunnel, or `0.0.0.0` bind.
- **Origin allowlist (primary browser defense).** Every browser connection's `Origin` header is checked. By default only `localhost`, `127.0.0.1`, `[::1]`, and `*.localhost` origins (your dev app, on any port) are allowed. Other origins are rejected (WebSocket 403, HTTP `403`/`401`). This stops any random web page you visit from driving your agent. Requests with **no** `Origin` (non-browser local tools like `curl` or an MCP stdio client) are allowed — the token below is the defense against those.
- **No wildcard CORS.** The MCP server never sends `Access-Control-Allow-Origin: *`. It reflects the request Origin only when it is on the allowlist, with `Vary: Origin`.
- **Payload & resource limits.** WebSocket messages and HTTP bodies are capped at 2 MB, message shapes are validated before use, and session/SSE stores are bounded to prevent unbounded memory growth.

### Optional bearer token

For defense against **other local processes** (which can send requests with no Origin), enable an opt-in token. It is **off by default** so existing setups keep working.

```bash
# Auto-generate a token (printed on startup)
npx svelte-grab relay --token
npx svelte-grab mcp --token

# Or provide your own
npx svelte-grab relay --token=my-secret
SVELTE_GRAB_TOKEN=my-secret npx svelte-grab mcp
```

When enabled, clients must present the token via the `?token=<TOKEN>` query parameter or the `x-svelte-grab-token` header on both WebSocket connect and MCP endpoints. The token is printed on startup.

In the browser, pass the MCP token to the component; it is sent on `/context`, `/events` and the agent runtime endpoints:

```svelte
<SvelteDevKit enableMcp mcpToken={import.meta.env.VITE_SVELTE_GRAB_TOKEN} />
```

### Configuration

| Setting | How |
|---------|-----|
| Extend the Origin allowlist | `SVELTE_GRAB_ALLOWED_ORIGINS=https://a.example,https://b.example` (comma-separated), or the `allowedOrigins` option to `createRelayServer` / `startMcpServer` |
| Enable token auth | `--token[=VALUE]` CLI flag, `SVELTE_GRAB_TOKEN` env var, or the `token` option |

**Never expose the relay or MCP ports to a network.** If you need remote access, use an SSH tunnel to `127.0.0.1` and keep token auth on.

## How It Works

Svelte 5 attaches `__svelte_meta` to DOM elements in development mode containing:

- `loc.file` — Source filename
- `loc.line` — Line number
- `loc.column` — Column number
- `parent` — Link to parent component's metadata

SvelteGrab walks up this metadata tree to build the full component hierarchy. All tools auto-disable in production builds where `__svelte_meta` is absent.

## Requirements

- Svelte 5.x
- Development mode (`DEV=true`)

### Optional Dependencies

| Package | Required for |
|---------|-------------|
| `html-to-image` | Screenshot capture |
| `ws` | Agent relay server |
| `@anthropic-ai/claude-agent-sdk` | Claude Code relay provider |
| `@openai/codex-sdk` | Codex relay provider |
| `@modelcontextprotocol/sdk` | MCP protocol transport (stdio/StreamableHTTP) |

## License

MIT
