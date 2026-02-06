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
2. Component stack with file paths is copied to clipboard
3. Paste into your agent prompt
4. Agent jumps directly to the right file

```
<button class="btn-primary"> in src/lib/components/Header.svelte:42
  in src/routes/+layout.svelte:15
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

## SvelteGrab — Component Inspector

The core tool. Hold Alt, hover to see file:line tooltips, click to capture the component stack.

### Features

- **Selection mode** — Hold Alt to highlight elements with Svelte metadata
- **Multi-select** — Shift+Alt+Click to select multiple elements
- **Drag selection** — Click+drag in selection mode to box-select elements
- **Editor integration** — Press `O` to open file in VSCode, Cursor, WebStorm, Zed, or Sublime
- **Screenshot capture** — Press `S` to capture element screenshot (requires `html-to-image`)
- **Context menu** — Right-click in selection mode for quick actions
- **Floating toolbar** — Optional draggable toolbar for common actions
- **History** — Tracks last 20 grabs with timestamps
- **Arrow navigation** — Use arrow keys in selection mode to walk the component tree
- **Agent relay** — Send selections to Claude Code or other agents via WebSocket
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
| `enableMcp` | `boolean` | `false` | Auto-send grabs to MCP server |
| `mcpPort` | `number` | `4723` | MCP server port |

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
```

Accepts all SvelteGrab props plus:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `enabledTools` | `DevKitTool[]` | all tools | Which tools to activate |

Available tools: `'grab'`, `'state'`, `'style'`, `'props'`, `'a11y'`, `'errors'`, `'profiler'`

## Agent Relay

Send captured element context directly to Claude Code or other coding agents via WebSocket.

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

The relay bridges browser selections to agent providers. Press Tab in selection mode to open the inline prompt, or use the context menu "Send to Agent" action.

### Session Management

The relay supports full session lifecycle — undo, redo, resume, and retry — so you can iterate on agent changes without starting over.

**After a successful agent action:**
- **Undo** — Click "Undo" in the status toast to revert the last change
- **Resume** — Click "Resume" to open the prompt modal for a follow-up instruction in the same session context

**After a failed agent action:**
- **Retry** — Click "Retry" in the status toast to re-send the same request

**Session history:**
- The prompt modal shows a "History" toggle to browse all past interactions
- Each entry shows the prompt, result/error, and timestamp
- Click "Resume" on any entry to continue from that point
- The toolbar shows a "Sessions" button when history is available

The relay server persists session context per connection, so undo/redo/resume send follow-up prompts with the previous interaction context. Retry re-sends the exact original request.

```typescript
// Programmatic session management via AgentClient
import { AgentClient } from 'svelte-grab/core';

const client = new AgentClient();
client.connect('ws://localhost:4722');

// After a request completes:
client.undo();                          // Undo last change
client.redo();                          // Redo undone change
client.resume('Now make it responsive'); // Follow-up prompt
client.retry();                         // Re-send last request
client.getHistory();                    // Get all interactions
```

## MCP Server

A simpler alternative to the WebSocket relay. The MCP server lets Claude Code (and other MCP-compatible agents) receive grabbed element context directly via HTTP — no separate relay process needed.

**How it works:**

```
Browser: Alt+Click element -> POST http://localhost:4723/context (automatic)
Claude Code: calls get_element_context tool -> receives the grabbed context
```

### 1. Start the MCP server

```bash
npx svelte-grab mcp
npx svelte-grab mcp --port=4723
```

Or use the standalone binary:

```bash
npx svelte-grab-mcp
npx svelte-grab-mcp --port=4723
```

For direct Claude Code integration via stdio:

```bash
npx svelte-grab mcp --stdio
```

### 2. Enable in your app

```svelte
<SvelteGrab enableMcp />

<!-- Custom port -->
<SvelteGrab enableMcp mcpPort={4723} />

<!-- With SvelteDevKit -->
<SvelteDevKit enableMcp />
```

When `enableMcp` is enabled, every grab automatically sends the captured context to the MCP server via a fire-and-forget HTTP POST. The UI is never blocked — if the server isn't running, the request silently fails.

### 3. Claude Code configuration

Add to your Claude Code MCP config (`.claude/settings.json` or equivalent):

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

Or connect to the HTTP server:

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

### 4. Programmatic usage

```typescript
import { startMcpServer } from 'svelte-grab/mcp';

// HTTP mode
const server = await startMcpServer({ port: 4723 });

// Stdio mode (for direct agent integration)
await startMcpServer({ stdio: true });
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `get_element_context` | Returns the last grabbed element context (component stack, HTML preview, optional prompt). Context is cleared after reading. |
| `undo_last_action` | Returns an undo instruction with the original context from the last interaction. Use this to tell the agent to revert its last change. |
| `get_session_history` | Returns the list of recent interactions (up to 20) with timestamps, prompts, and content previews. |

The MCP server maintains a session history (up to 50 entries) of all contexts received via `POST /context`. This enables undo and history browsing without a WebSocket connection.

### HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check. Returns `{ status: "ok", hasContext: boolean }` |
| `POST` | `/context` | Receive context from browser. Body: `{ content: string[], prompt?: string }` |
| `POST` | `/mcp` | MCP protocol endpoint (StreamableHTTP transport) |

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
| **Tab** | Open agent prompt (selection mode) |
| **Cmd/Ctrl+C** | Copy hovered element (selection mode) |
| **Cmd/Ctrl+Enter** | Send agent prompt |
| **Escape** | Close popup / exit selection mode |

## Theming

```svelte
<!-- Dark theme (default) -->
<SvelteGrab />

<!-- Light theme -->
<SvelteGrab lightTheme />

<!-- Custom colors -->
<SvelteGrab
  theme={{
    background: '#0d1117',
    border: '#30363d',
    text: '#c9d1d9',
    accent: '#58a6ff'
  }}
/>
```

All tools share the same theme system via `theme` and `lightTheme` props.

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
| `@modelcontextprotocol/sdk` | MCP protocol transport (stdio/StreamableHTTP) |

## License

MIT
