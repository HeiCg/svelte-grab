# react-grab vs svelte-grab — Full Analysis

> Analysis performed on 2026-02-05 based on the source code of [react-grab](https://github.com/aidenybai/react-grab) (v1.0+).

---

## 1. Overview

| | react-grab | svelte-grab |
|---|---|---|
| **Purpose** | Select UI context for coding agents | Inspect component stack via `__svelte_meta` |
| **Structure** | Monorepo with ~15 packages | Single file (~1650 lines) |
| **Core rendering** | SolidJS (overlay in Shadow DOM) | Svelte 5 (DOM elements with `position: fixed`) |
| **Component detection** | React fibers via `bippy` library | `__svelte_meta` native to Svelte dev mode |
| **State management** | SolidJS `createStore` + state machine | `$state()`, `$derived()`, `SvelteSet` |
| **Tests** | ~25 E2E specs with Playwright | None |
| **Installation** | `npx grab init` (auto-detects framework) | Manual `<SvelteGrab />` in layout |

---

## 2. react-grab Architecture

### 2.1 Monorepo (pnpm + Turborepo)

```
packages/
├── react-grab/          # Core: overlay, store, plugins, agent manager
├── relay/               # WebSocket relay server (browser ↔ agent)
├── cli/                 # `npx grab init` installer
├── provider-claude-code/# Claude Code agent handler (uses SDK)
├── provider-cursor/     # Cursor agent handler
├── provider-codex/      # Codex agent handler
├── provider-gemini/     # Gemini agent handler
├── provider-amp/        # Amp agent handler
├── provider-droid/      # Droid agent handler
├── provider-opencode/   # Opencode agent handler
├── web-extension/       # Chrome extension
├── design-system/       # Shared UI components (SolidJS)
├── utils/               # Client/server utilities
├── gym/                 # Demo app (Next.js)
├── website/             # Marketing site
├── benchmarks/          # Performance benchmarks
├── e2e-playground/      # Vite playground for testing
├── next-playground/     # Next.js playground
└── vite-playground/     # Vite playground
```

### 2.2 Core State Machine

The store uses an explicit state machine with phases:

```
idle → holding → active → copying → justCopied → idle
                   │
                   ├── hovering (detecting element)
                   ├── frozen (element selected/locked)
                   ├── dragging (box selection in progress)
                   └── justDragged (drag selection complete)
```

Implementation via SolidJS `createStore`:

```typescript
type GrabState =
  | { state: "idle" }
  | { state: "holding"; startedAt: number }
  | { state: "active"; phase: GrabPhase; isPromptMode: boolean; isPendingDismiss: boolean }
  | { state: "copying"; startedAt: number; wasActive: boolean }
  | { state: "justCopied"; copiedAt: number; wasActive: boolean };
```

### 2.3 Plugin System

Plugins can register hooks, context menu actions, and theme overrides:

```typescript
interface Plugin {
  name: string;
  theme?: DeepPartial<Theme>;
  options?: SettableOptions;
  actions?: ContextMenuAction[];
  hooks?: PluginHooks;
  setup?: (api: ReactGrabAPI) => PluginConfig | void;
}
```

**Available hooks** (30+ hooks):
- Lifecycle: `onActivate`, `onDeactivate`, `onStateChange`
- Element: `onElementHover`, `onElementSelect`
- Drag: `onDragStart`, `onDragEnd`
- Copy: `onBeforeCopy`, `transformCopyContent`, `onAfterCopy`, `onCopySuccess`, `onCopyError`
- UI: `onSelectionBox`, `onDragBox`, `onGrabbedBox`, `onElementLabel`, `onCrosshair`
- Context menu: `onContextMenu`
- Agent: `transformAgentContext`
- Transform: `transformHtmlContent`, `transformScreenshot`, `transformOpenFileUrl`, `transformSnippet`

**Built-in plugins**: `screenshotPlugin`, `copyHtmlPlugin`, `openPlugin`, `commentPlugin`

**Registration**:
```typescript
window.__REACT_GRAB__.registerPlugin({
  name: 'my-plugin',
  hooks: { onElementSelect: (el) => console.log(el) },
  actions: [{ id: 'my-action', label: 'Do thing', onAction: (ctx) => {} }]
});
```

### 2.4 Agent Integration (the biggest differentiator)

#### Full flow:

```
┌─────────┐  WebSocket   ┌──────────┐  Spawn/SDK   ┌─────────────┐
│ Browser  │ ◄──────────► │  Relay   │ ◄──────────► │ Claude Code │
│ (overlay)│              │  Server  │              │   Handler   │
└─────────┘              └──────────┘              └─────────────┘
     │                        │                          │
     │ 1. User selects        │                          │
     │    element + types     │                          │
     │    prompt              │                          │
     │                        │                          │
     │ 2. agent-request ──────►                          │
     │    {content, prompt}   │                          │
     │                        │ 3. invoke-handler ──────►│
     │                        │    {method:"run",        │
     │                        │     prompt}              │
     │                        │                          │
     │                        │ 4. agent-status ◄────────│
     │ 5. agent-status ◄──────│    "Thinking..."        │
     │    (streaming)         │                          │
     │                        │ 6. agent-status ◄────────│
     │ 7. agent-status ◄──────│    "Editing file..."    │
     │                        │                          │
     │                        │ 8. agent-done ◄──────────│
     │ 9. agent-done ◄────────│                          │
     │                        │                          │
     │ 10. UI shows           │                          │
     │     "Completed" +      │                          │
     │     undo button        │                          │
```

#### Relay Protocol (WebSocket on port 4722):

```typescript
// Browser → Relay
interface BrowserToRelayMessage {
  type: "agent-request" | "agent-abort" | "agent-undo" | "agent-redo" | "health";
  agentId: string;
  sessionId?: string;
  context?: { content: string[]; prompt: string; options?: unknown };
}

// Relay → Browser
interface RelayToBrowserMessage {
  type: "agent-status" | "agent-done" | "agent-error" | "health" | "handlers";
  agentId?: string;
  sessionId?: string;
  content?: string;
  handlers?: string[];  // list of available agents
}
```

#### Claude Code Handler:

```typescript
// Uses @anthropic-ai/claude-agent-sdk
import { query } from "@anthropic-ai/claude-agent-sdk";

const queryResult = query({
  prompt,
  options: {
    pathToClaudeCodeExecutable: resolveClaudePath(),
    includePartialMessages: true,
    permissionMode: "bypassPermissions",
    cwd: process.env.REACT_GRAB_CWD ?? process.cwd(),
    ...(claudeSessionId ? { resume: claudeSessionId } : {}),
  },
});

// Message streaming
for await (const message of queryResult) {
  if (message.type === "assistant") {
    yield { type: "status", content: textContent };
  }
  if (message.type === "result") {
    yield { type: "status", content: "Completed" };
  }
}
```

**Agent system features:**
- Session persistence (resume after reload)
- Follow-up prompts in the same session
- Undo/redo of agent changes
- Abort with cleanup
- Error handling + retry
- Real-time status streaming in the overlay

### 2.5 Snippet Generation (context.ts)

react-grab generates rich context for agents:

```typescript
export const getElementContext = async (element, options) => {
  const stack = await getStack(element);  // via bippy getOwnerStack
  const html = getHTMLPreview(element);

  // Output format:
  // <button class="ml-auto" href="#">
  //   Forgot your password?
  // </button>
  //   in LoginForm (at components/login-form.tsx:46:19)
  //   in AuthPage (at app/login/page.tsx:12:5)
};
```

### 2.6 Freeze Updates

Intercepts React hooks to pause re-renders during selection:

```typescript
// Monkey-patch useState, useReducer, useTransition, useSyncExternalStore
typedDispatcher.useState = (...args) => {
  const [state, dispatch] = originalHooks.useState(...args);
  if (!isUpdatesPaused) return [state, dispatch];

  const wrappedDispatch = (...dispatchArgs) => {
    if (isUpdatesPaused) {
      pendingStateUpdates.push(() => dispatch(...dispatchArgs));
    } else {
      dispatch(...dispatchArgs);
    }
  };
  return [state, wrappedDispatch];
};
```

When deactivated, all buffered updates are applied at once.

### 2.7 CLI Tool

```bash
npx grab init
```

- Detects framework: Next.js (App/Pages router), Vite, Webpack
- Generates framework-specific installation template
- Shows diff before applying
- Supports `add`, `configure`, `remove` commands

### 2.8 Other Features

- **Context Menu**: Right-click with extensible actions via plugins
- **Toolbar**: Draggable floating bar on any screen edge
- **Arrow Navigation**: Up/Down/Left/Right to navigate between parent/child/siblings
- **Auto-scroll**: Automatic scroll when hovering near edges
- **Touch Mode**: Touch screen support
- **Activation Modes**: Toggle (click to activate/deactivate) or Hold (hold key)
- **Web Extension**: Chrome extension for use on any React site
- **Global API**: `window.__REACT_GRAB__` with `activate()`, `deactivate()`, `copyElement()`, etc.
- **Crosshair**: Guide crosshair lines that follow the cursor

---

## 3. svelte-grab Architecture (current)

### 3.1 Structure

```
src/lib/
├── SvelteGrab.svelte  # Everything: events, metadata walking, popup, overlay, CSS (~1650 lines)
├── types.ts           # TypeScript interfaces
└── index.ts           # Re-exports
```

### 3.2 Internal Mechanisms

- **Dev mode detection**: Scans DOM for `__svelte_meta` property
- **Component stack**: Traverses `__svelte_meta.parent` chain, deduplicating by `file:line`
- **Selection mode**: Modifier key (Alt) activates hover-highlight with tooltip file:line
- **Multi-select**: Shift+modifier+click with `SvelteSet<HTMLElement>`
- **Screenshot**: Lazy-loads `html-to-image` (optional peer dependency)
- **Editor integration**: Protocol URLs for vscode, cursor, webstorm, zed, etc.
- **History**: Array of previous grabs with timestamp

### 3.3 Output Format

```
<button class="btn-primary" type="submit">
  Submit
</button>
Used in: src/routes/+page.svelte:42
Defined in: src/lib/components/Button.svelte:15
```

---

## 4. Feature-by-Feature Comparison

| Feature | react-grab | svelte-grab |
|---|:---:|:---:|
| Element inspection | ✅ | ✅ |
| Copy to clipboard | ✅ | ✅ |
| HTML preview | ✅ | ✅ |
| Component stack | ✅ (via fiber) | ✅ (via `__svelte_meta`) |
| Open in editor | ✅ | ✅ |
| Screenshot | ✅ (plugin) | ✅ |
| Multi-select | ✅ (drag) | ✅ (shift+click) |
| History | ❌ | ✅ |
| Light/dark theme | ✅ (hue-based) | ✅ (preset-based) |
| **Agent relay (WebSocket)** | ✅ | ❌ |
| **Prompt mode** | ✅ | ❌ |
| **Plugin system** | ✅ | ❌ |
| **CLI installer** | ✅ | ❌ |
| **Drag selection** | ✅ | ❌ |
| **Context menu** | ✅ | ❌ |
| **Toolbar** | ✅ | ❌ |
| **Freeze UI updates** | ✅ | ❌ |
| **Arrow key navigation** | ✅ | ❌ |
| **Undo/redo** | ✅ | ❌ |
| **Session persistence** | ✅ | ❌ |
| **Auto-scroll** | ✅ | ❌ |
| **Web extension** | ✅ | ❌ |
| **Touch mode** | ✅ | ❌ |
| **Crosshair** | ✅ | ❌ |
| **Global API** | ✅ | ❌ |
| **E2E tests** | ✅ (~25 specs) | ❌ |

---

## 5. svelte-grab Advantages

1. **`__svelte_meta` is more reliable**: Native Svelte metadata, whereas react-grab depends on bippy (a hack into React DevTools/fibers)
2. **Simpler installation for Svelte**: `<SvelteGrab />` in layout vs `<Script>` tags
3. **History feature**: react-grab does not have explicit grab history
4. **Self-contained component**: Zero external dependencies (except optional html-to-image)
5. **Svelte 5 reactivity**: `$state()`, `$derived()`, `SvelteSet` — more idiomatic

---

## 6. Improvement Roadmap (Prioritized)

### P0 — Game-changers

#### 6.1 Agent Integration with WebSocket Relay
The biggest differentiator of react-grab. Create:
- `@svelte-grab/relay` — WebSocket relay server
- `@svelte-grab/provider-claude-code` — Handler using `@anthropic-ai/claude-agent-sdk`
- `@svelte-grab/provider-cursor` — Handler for Cursor

The flow: user selects element → types prompt → agent receives context + prompt → executes changes → status streaming in the overlay.

#### 6.2 Plugin System
Extract functionality into extensible plugins:
```typescript
interface SvelteGrabPlugin {
  name: string;
  hooks?: {
    onElementSelect?: (element: HTMLElement) => void;
    onBeforeCopy?: (elements: HTMLElement[]) => void;
    transformCopyContent?: (content: string) => string;
    transformAgentContext?: (context: AgentContext) => AgentContext;
  };
  actions?: ContextMenuAction[];
}
```

### P1 — Competitiveness

#### 6.3 CLI Tool
```bash
npx svelte-grab init
```
Auto-detect SvelteKit and inject `<SvelteGrab />` into `+layout.svelte`.

#### 6.4 Drag Selection
Click + drag to select multiple elements with box selection.

#### 6.5 Context Menu
Right-click on selected element → menu with: Copy for Agent, Copy HTML, Open in Editor, Screenshot, Send to Agent.

#### 6.6 Modularization
Break up the 1650-line file:
```
src/lib/
├── core/
│   ├── store.svelte.ts    # State management
│   ├── events.ts          # Event handlers
│   ├── context.ts         # Component stack walking
│   └── copy.ts            # Clipboard operations
├── components/
│   ├── Overlay.svelte     # Highlight/selection overlay
│   ├── Popup.svelte       # Info popup/dialog
│   ├── Toolbar.svelte     # Floating toolbar
│   ├── ContextMenu.svelte # Right-click menu
│   └── Tooltip.svelte     # Hover tooltip
├── plugins/
│   ├── registry.ts        # Plugin registration
│   ├── copy.ts            # Copy plugin
│   ├── screenshot.ts      # Screenshot plugin
│   └── open.ts            # Open in editor plugin
├── types.ts
└── index.ts
```

### P2 — Polish

#### 6.7 Arrow Key Navigation
Up = parent, Down = first child, Left = previous sibling, Right = next sibling.

#### 6.8 Floating Toolbar
Draggable bar with activation toggle, element info, quick actions.

#### 6.9 Activation Modes
- **Toggle**: Click to activate, click to deactivate (like react-grab default)
- **Hold**: Hold key to activate (our current mode)

#### 6.10 Global API
```typescript
window.__SVELTE_GRAB__ = {
  activate: () => void,
  deactivate: () => void,
  toggle: () => void,
  isActive: () => boolean,
  copyElement: (el: HTMLElement) => Promise<boolean>,
  registerPlugin: (plugin: SvelteGrabPlugin) => void,
};
```

#### 6.11 E2E Tests
Playwright tests covering: activation, selection, copy, multi-select, editor integration, screenshot.

### P3 — Extras

- **Auto-scroll** at viewport edges
- **Web Extension** for any Svelte site in dev mode
- **Crosshair** guide lines
- **Touch support**
- **Freeze Svelte updates** (intercept `$state` proxy during selection)

---

## 7. Key Architectural Insight

react-grab separates **core** (framework-agnostic) from **framework-specific** (React fiber detection). The entire overlay is rendered with SolidJS in Shadow DOM, independent of React.

For svelte-grab, the pragmatic approach is:
1. Keep the core as a Svelte component (our target is only Svelte)
2. Modularize internally into separate modules
3. Add the relay system as an independent package (`@svelte-grab/relay`)
4. Keep detection via `__svelte_meta` (simpler and more reliable than fiber hacking)
