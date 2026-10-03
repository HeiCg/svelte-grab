# svelte-grab

**Give coding agents eyes into your Svelte app.**

svelte-grab runs inside your Svelte 5 app in dev and answers your coding agent over MCP: what is on the page, which component rendered it, the file and line to edit, its props, state, styles and accessibility, and whether the page still looks right after the edit. Only code running in the page can read the `__svelte_meta` that Svelte attaches in dev builds, so every element the agent sees comes with its component and source location. The agent stops grepping for "the button in the header" and goes straight to `src/lib/Header.svelte:42`.

It is not a browser driver. Real clicks, screenshots, viewports and network stay with [Playwright MCP / chrome-devtools MCP](#works-with-playwright-mcp--chrome-devtools-mcp); every element svelte-grab reports carries a `[data-sg-ref="eN"]` locator those tools can use. For Svelte docs and code fixes, [pair it with the official Svelte MCP](#pairs-with-the-official-svelte-mcp-sveltejsmcp).

For humans there is still the original toolbox: Alt+Click any element to copy its component stack, inspect state, styles, accessibility, errors and renders ([Human tools](#human-tools-hotkeys)). Dev only: every tool turns itself off in production builds.

## 60-second quickstart

**1. Install** (the MCP SDK and zod are what `svelte-grab-mcp --stdio` runs on):

```bash
npm install -D svelte-grab @modelcontextprotocol/sdk zod
```

**2. Set up the project:**

```bash
npx svelte-grab init            # --dry-run to preview
```

`init` writes or merges `.mcp.json` (the `svelte-grab` server, plus the official Svelte MCP), adds `svelteGrab()` from `svelte-grab/vite` to your Vite config and puts `<SvelteDevKit enableMcp />` in `src/routes/+layout.svelte` (or `src/App.svelte`), gated by `dev`. It never replaces existing `.mcp.json` entries, shows a diff of what it changes and is safe to run twice. With [`sv`](https://svelte.dev/docs/cli), `npx sv add @svelte-grab` does the same ([packages/sv-addon](packages/sv-addon)).

The resulting `.mcp.json`:

```json
{
  "mcpServers": {
    "svelte-grab": { "type": "stdio", "command": "npx", "args": ["svelte-grab-mcp", "--stdio"] },
    "svelte": { "type": "stdio", "command": "npx", "args": ["-y", "@sveltejs/mcp"] }
  }
}
```

Add `--with-playwright-mcp` for a `playwright` entry (`npx -y @playwright/mcp@latest`). Not on Claude Code? Copy the `svelte-grab` entry into your client's MCP config (Cursor: `.cursor/mcp.json`, VS Code: `.vscode/mcp.json` under `servers`).

**3. Run it.** Start the dev server (`npm run dev`), open the app in a browser, and start your agent in the project. Claude Code reads `.mcp.json` on start (approve the project servers when asked) and launches the MCP server itself; the page finds it on `127.0.0.1:4723` (next free port up to 4732).

**4. Let the agent loop:**

```
ui_snapshot -> ui_find -> ui_inspect -> (edit the file) -> ui_wait_for_hmr -> ui_verify
```

A short session, asking for "make the Save button in the settings card more prominent":

```
> ui_find { "text": "Save" }
1 match. Locator: [data-sg-ref="<ref>"]
e14 button "Save" Button src/lib/components/Button.svelte:11 box=612,388 96x36

> ui_component_impact { "ref": "e14" }
<Button> defined in src/lib/components/Button.svelte
e14 button "Save" (this instance is used at src/routes/settings/SettingsCard.svelte:27)
INSTANCES on this page: 6
IMPORTERS (Vite module graph): 3
Recommendation: Changing src/lib/components/Button.svelte affects 6 instances on this page and
3 importing files; prefer a prop/variant or a local class at the usage site
src/routes/settings/SettingsCard.svelte:27 for a one-off change.

> ui_inspect { "ref": "e14", "include": ["props", "styles"] }
e14 button "Save" Button src/lib/components/Button.svelte:11
Locator: [data-sg-ref="e14"]
COMPONENT
  <Button> defined in src/lib/components/Button.svelte
  this instance is used at src/routes/settings/SettingsCard.svelte:27:4
SOURCE
  src/lib/components/Button.svelte:11:2
PROPS/ATTRIBUTES
  attributes: class: "btn btn-secondary svelte-1x2y3z", type: "button"
STYLES
  authored declarations (computed value -> winning source):
    background-color: rgb(229, 231, 235) -> .btn-secondary (Button.svelte, svelte-scoped)

  (agent edits SettingsCard.svelte:27 to <Button variant="primary">)

> ui_wait_for_hmr { "files": ["SettingsCard.svelte"] }
HMR update applied (source: vite-hmr): src/routes/settings/SettingsCard.svelte
Refs: 41 kept, 1 rebound (e14 -> e52), 0 lost
Console errors since the update: 0

> ui_verify { "ref": "e14" }
PASS e52 button "Save" Button src/lib/components/Button.svelte:11
# e14 was stale; rebound to e52
PASS visible box 612,388 96x36, in viewport, not covered
PASS overflow content fits (96x36 in 96x36); no page-level horizontal overflow
PASS console no errors or warnings since the last HMR update
PASS a11y no element-level issues (label, button name, img alt, tabindex, interactive role)
PASS contrast 7.1:1 (needs 4.5:1)
```

(Output trimmed for the README; the real text has a few more lines per section.)

The human can still hand work over directly: `watch_for_grab` blocks until someone Alt+Clicks an element and sends a prompt from the page, and `ui_annotations` returns the comments they left with [annotation mode](#annotation-mode). See [Human handoff](#human-handoff-altclick--prompt).

## MCP tools

All tools are served by the same local MCP server (`svelte-grab-mcp`). The `ui_*` tools query the live page and need the app open in dev with `<SvelteDevKit enableMcp />` (or `<SvelteGrab enableMcp />`) mounted.

| Tool | Purpose |
|------|---------|
| `ui_tabs` | List the browser tabs connected to the server; `ui_*` tools target the last focused one unless given `tabId`. |
| `ui_snapshot` | Compact tree of the live UI: one line per element with Svelte metadata or an a11y role/name (`eN <role> "<name>" <Component> <file:line>`). Start here. |
| `ui_find` | Find elements by `text`, `role`, `name`, `component`, `file` or CSS `selector`; returns refs with component, source, box and visibility. |
| `ui_inspect` | Full context for one ref: component, source, stack, props, `inspectable()` state, layout, matched styles, a11y and other instances. |
| `ui_wait_for_hmr` | Call right after an edit: waits for the Vite HMR update (or full reload) of those files, re-resolves refs and reports Vite errors. |
| `ui_verify` | PASS/WARN/FAIL checks on one element after an edit: visible, overflow, console errors, a11y, contrast. |
| `ui_component_impact` | Before editing a shared component: its instances on the page, importers from the Vite module graph and whether to edit it or the usage site. |
| `ui_annotations` | The comments the human left on elements with annotation mode, with refs ready for `ui_inspect`. |
| `watch_for_grab` | Block until the human Alt+Clicks an element and sends a prompt from the page; returns stack, HTML preview and the instruction. |
| `get_element_context` | Last grabbed context, non-blocking (cleared after reading). |
| `get_a11y_report` | Last accessibility audit from SvelteA11yReporter. |
| `get_style_context` | Last CSS analysis from SvelteStyleGrab. |
| `get_error_context` | Console errors and warnings captured by SvelteErrorContext. |
| `get_profiler_report` | Last render profile from SvelteRenderProfiler. |
| `undo_last_action` | Undo instruction with the original context of the last request. |
| `get_session_history` | Recent interactions (up to 20) with timestamps and prompts. |
| `list_available_tools` | Which of the `get_*` tools have data and when it was captured. |

Arguments, outputs and HTTP endpoints: [Reference: Claude Code Integration (MCP)](#claude-code-integration-mcp).

## Works with Playwright MCP / chrome-devtools MCP

svelte-grab knows Svelte; browser drivers know the browser. Use both. Every element svelte-grab reports is stamped with `data-sg-ref`, so a ref becomes a locator for the other tool:

```
ui_find { "component": "Card" }          ->  e12 article "Pro plan" Card src/lib/Card.svelte:4
locator for Playwright / chrome-devtools ->  [data-sg-ref="e12"]
```

```js
// Anywhere Playwright code runs (a test, a script, or Playwright MCP's code tool):
await page.locator('[data-sg-ref="e12"]').click();          // real, trusted click
await page.locator('[data-sg-ref="e12"]').screenshot({ path: 'card.png' });

// chrome-devtools MCP evaluate_script / Playwright MCP browser_evaluate:
() => document.querySelector('[data-sg-ref="e12"]').getBoundingClientRect()
```

Tools that click by their own snapshot ids (chrome-devtools MCP `click { uid }`, Playwright MCP `browser_click { ref }`) need the id from their snapshot; svelte-grab gives the role and accessible name (`article "Pro plan"`) to match it.

Refs live as long as the element. After a re-render or HMR, pass the old ref to a `ui_*` tool (or call `ui_wait_for_hmr`): it is re-resolved by its stable key (`ui://<file>:<line>:<col>#<Component>...`) and the new `eN` is reported.

| Need | Use |
|------|-----|
| Real (trusted) clicks, typing, drag, file upload | Playwright MCP / chrome-devtools MCP |
| Screenshots, visual diffs, several viewports or devices | Playwright MCP / chrome-devtools MCP |
| Network requests, performance traces, Lighthouse | chrome-devtools MCP |
| Which component and file rendered this, and where it is used | svelte-grab (`ui_find`, `ui_inspect`) |
| Props, `$state` (via `inspectable()`), matched CSS rules with their source | svelte-grab (`ui_inspect`) |
| Did my edit land, and is the element still fine | svelte-grab (`ui_wait_for_hmr`, `ui_verify`) |
| Is it safe to edit this shared component | svelte-grab (`ui_component_impact`) |

`npx svelte-grab init --with-playwright-mcp` adds Playwright MCP to `.mcp.json` next to svelte-grab.

## Pairs with the official Svelte MCP (`@sveltejs/mcp`)

The [official Svelte MCP](https://svelte.dev/docs/mcp) works on code: it serves the Svelte and SvelteKit docs and runs `svelte-autofixer` on components the agent writes. svelte-grab works on the running page: what rendered, where it came from, and how it looks after the change. They do not overlap, which is why `init` adds both to `.mcp.json` (`--no-svelte-mcp` to skip it). A typical split: svelte-grab finds `SettingsCard.svelte:27` and verifies the result; the Svelte MCP answers "how do snippets work" and checks the edited component before it is saved.

## Human handoff: Alt+Click + prompt

When you would rather point than describe: Alt+Click an element, type the instruction in the overlay and press Cmd+Enter. With `<SvelteDevKit enableMcp />` mounted and the agent waiting on `watch_for_grab`, it receives the component stack, an HTML preview and your instruction:

```
<button class="btn-primary"> in src/lib/components/Header.svelte:42
  in src/routes/+layout.svelte:15

User instruction: Make this button bigger and change the color to blue
```

In Claude Code, say "use watch_for_grab to listen for my selections". The overlay shows a green dot while the agent is listening and a red one when it is not. For several changes at once, use [annotation mode](#annotation-mode) and let the agent read them with `ui_annotations`.

The WebSocket [Agent Relay](#agent-relay-websocket) (`svelte-grab relay`) is in maintenance mode: still supported, but new integrations should use MCP.

# Human tools (hotkeys)

The browser tools behind the hotkeys. They work with or without an agent: copy context to the clipboard, or send it over MCP.

## Tools Overview

svelte-grab ships 7 specialized tools + a unified wrapper:

| Tool | Trigger | What it does |
|------|---------|--------------|
| **SvelteGrab** | Alt+Click | Component location stack with file:line |
| **SvelteStateGrab** | Alt+Shift+Click (Alt+Meta+Click in SvelteDevKit) | Props, attributes, bound values inspection |
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

`hotkeys="minimal"` (on SvelteGrab or SvelteDevKit) keeps only the shortcuts that point at UI: Alt+Click (point), Shift+Alt+Click (multi), Alt+Drag (region), Escape and `N` (annotate). Everything else is off: Enter, `O`, `S`, Tab, arrows, Cmd/Ctrl+C, Alt+? and the right-click menu in SvelteGrab; in SvelteDevKit also Alt+Meta+Click (state), Alt+Ctrl+Click (style), Alt+DoubleClick (tracer), Alt+RightClick / Alt+A (a11y), Alt+E (errors), Alt+P (profiler), Alt+Shift+C and Alt+?. Those tools stay mounted, so error capture keeps running and the MCP runtime can still use their logic. Each tool also takes `enableHotkeys={false}` on its own. The default (`'full'`) is unchanged.

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

Inside SvelteDevKit the trigger is **Alt+Meta+Click** (Meta = Cmd on macOS, Win on Windows), because Shift+Alt+Click is SvelteGrab's multi-select. DevKit falls back to Alt+Shift+Click when multi-select is off (`enableMultiSelect={false}`) or SvelteGrab is not enabled. Set `stateSecondaryModifier` on SvelteDevKit to pick the modifier yourself.

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
| `stateSecondaryModifier` | `'shift' \| 'ctrl' \| 'meta'` | `'meta'` with multi-select, else `'shift'` | StateGrab trigger modifier (Alt+Meta+Click by default, so it does not collide with Shift+Alt+Click multi-select) |
| `styleSecondaryModifier` | `'shift' \| 'ctrl' \| 'meta'` | `'ctrl'` | StyleGrab trigger modifier (Alt+Ctrl+Click) |

Available tools: `'grab'`, `'state'`, `'style'`, `'props'`, `'a11y'`, `'errors'`, `'profiler'`

# Reference

Details for the MCP server, relay, CLI, plugins, global API, theming and security.

## Claude Code Integration (MCP)

The recommended way to connect svelte-grab to Claude Code (and any other MCP client). `npx svelte-grab init` writes the config below into `.mcp.json` for you. The agent queries the page itself with the `ui_*` tools; the human can also hand over a selection with `watch_for_grab`, as described here.

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
| `ui_verify` | Call after `ui_wait_for_hmr`. PASS/WARN/FAIL checks on one element: `visible` (rendered, in viewport, not covered; names the coverer), `overflow` (clipped or spilling content, page-level horizontal overflow), `console` (errors FAIL, warnings WARN since `since`, else the last HMR update), `a11y` (element-level checks), `contrast` (below 3:1 FAIL, below WCAG AA WARN). Text starts with the verdict line; `structuredContent` is `{ verdict, checks: [{ check, status, summary, details }] }`. Args: `ref`, `checks` (default all), `since`, `tabId`. |
| `ui_component_impact` | Call before editing a component that may be shared, with a ref to any element it renders. Returns the definition file, instances on the page grouped by usage site, variants (instances grouped by root classes), importers from the Vite module graph (needs `svelte-grab/vite`, else "unknown") and a recommendation: edit the component for a single usage, else prefer a prop/variant or a local class at the usage site. Args: `ref`, `tabId`. |

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

> **Maintenance mode.** The relay is still supported (bug and security fixes) but gets no new providers or features. New integrations should use the [MCP server](#claude-code-integration-mcp), where the agent queries the page itself.

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
| `init` | Set up the project: merge `.mcp.json`, add the Vite plugin, inject SvelteDevKit into the root layout (flags below) |
| `add <provider>` | Add an agent provider (claude-code, cursor, copilot, codex) |
| `remove <provider>` | Remove an agent provider |
| `configure` | Interactive configuration (activation key, editor, ports, theme) |
| `relay` | Start the WebSocket relay server (maintenance mode) |
| `mcp` | Start the MCP server |
| `help` | Show help |

### `init`

| Step | What it does | Opt out |
|------|--------------|---------|
| `.mcp.json` | Merges the `svelte-grab` server (`npx svelte-grab-mcp --stdio`) and the official Svelte MCP (`npx -y @sveltejs/mcp`) into `mcpServers`. Existing entries are never replaced; an invalid file is left alone with an error. Prints a diff. | `--no-mcp-json`, `--no-svelte-mcp` (or `--with-svelte-mcp=false`) |
| Playwright MCP | Adds a `playwright` entry (`npx -y @playwright/mcp@latest`). | off unless `--with-playwright-mcp` |
| `vite.config.(ts\|js)` | Adds `import { svelteGrab } from 'svelte-grab/vite'` and `svelteGrab()` right after `sveltekit(...)` / `svelte(...)` when the config has a plain `plugins: [...]` array. Any other shape is left untouched and the two lines to add are printed. | `--no-vite-plugin` |
| Root component | SvelteKit: `src/routes/+layout.svelte` (created if missing), wrapped in `{#if dev}` from `$app/environment`. Vite + Svelte: end of `src/App.svelte`. Skipped when the file already imports `svelte-grab`. | |
| `enableMcp` | Set on the injected `<SvelteDevKit />` only when `.mcp.json` declares the `svelte-grab` server after the run (added now or already there). With `--no-mcp-json` or an unreadable `.mcp.json` the page does not try to reach an MCP server. | |

`init` also lists the dev dependencies still missing from `package.json` (`svelte-grab`, plus `@modelcontextprotocol/sdk` and `zod` when MCP is configured) with the install command for your package manager. `--dry-run` prints every diff and writes nothing. Running it again changes nothing.

```bash
npx svelte-grab init                     # Set up .mcp.json, Vite plugin and layout
npx svelte-grab init --dry-run           # Preview changes without writing
npx svelte-grab init --with-playwright-mcp --no-vite-plugin
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
| **Alt+Meta+Click** | Inspect component state (SvelteDevKit; Meta = Cmd/Win) |
| **Alt+Shift+Click** | Inspect component state (standalone SvelteStateGrab) |
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

- Svelte 5.35.1+ (the `__svelte_meta.parent` chain behind component stacks starts there)
- Development mode (`DEV=true`)

### Optional Dependencies

| Package | Required for |
|---------|-------------|
| `html-to-image` | Screenshot capture |
| `ws` | Agent relay server |
| `@anthropic-ai/claude-agent-sdk` | Claude Code relay provider |
| `@openai/codex-sdk` | Codex relay provider |
| `@modelcontextprotocol/sdk` | MCP protocol transport (stdio/StreamableHTTP) |
| `zod` | MCP tool schemas (install next to `@modelcontextprotocol/sdk`) |
| `vite` | The optional `svelte-grab/vite` plugin |

## License

MIT
