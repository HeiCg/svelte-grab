# react-grab vs svelte-grab — Análise Completa

> Análise feita em 2026-02-05 com base no código-fonte do [react-grab](https://github.com/aidenybai/react-grab) (v1.0+).

---

## 1. Visão Geral

| | react-grab | svelte-grab |
|---|---|---|
| **Propósito** | Selecionar contexto de UI para coding agents | Inspecionar component stack via `__svelte_meta` |
| **Estrutura** | Monorepo com ~15 pacotes | Arquivo único (~1650 linhas) |
| **Core rendering** | SolidJS (overlay em Shadow DOM) | Svelte 5 (DOM elements com `position: fixed`) |
| **Detecção de componentes** | React fibers via `bippy` library | `__svelte_meta` nativo do Svelte dev mode |
| **State management** | SolidJS `createStore` + state machine | `$state()`, `$derived()`, `SvelteSet` |
| **Testes** | ~25 specs E2E com Playwright | Nenhum |
| **Instalação** | `npx grab init` (auto-detecta framework) | `<SvelteGrab />` manual no layout |

---

## 2. Arquitetura do react-grab

### 2.1 Monorepo (pnpm + Turborepo)

```
packages/
├── react-grab/          # Core: overlay, store, plugins, agent manager
├── relay/               # WebSocket relay server (browser ↔ agent)
├── cli/                 # `npx grab init` installer
├── provider-claude-code/# Claude Code agent handler (usa SDK)
├── provider-cursor/     # Cursor agent handler
├── provider-codex/      # Codex agent handler
├── provider-gemini/     # Gemini agent handler
├── provider-amp/        # Amp agent handler
├── provider-droid/      # Droid agent handler
├── provider-opencode/   # Opencode agent handler
├── web-extension/       # Chrome extension
├── design-system/       # Componentes UI compartilhados (SolidJS)
├── utils/               # Utilitários client/server
├── gym/                 # App demo (Next.js)
├── website/             # Site marketing
├── benchmarks/          # Benchmarks de performance
├── e2e-playground/      # Playground Vite para testes
├── next-playground/     # Playground Next.js
└── vite-playground/     # Playground Vite
```

### 2.2 State Machine do Core

O store usa uma state machine explícita com fases:

```
idle → holding → active → copying → justCopied → idle
                   │
                   ├── hovering (detectando elemento)
                   ├── frozen (elemento selecionado/locked)
                   ├── dragging (box selection em andamento)
                   └── justDragged (seleção por drag completa)
```

Implementação via SolidJS `createStore`:

```typescript
type GrabState =
  | { state: "idle" }
  | { state: "holding"; startedAt: number }
  | { state: "active"; phase: GrabPhase; isPromptMode: boolean; isPendingDismiss: boolean }
  | { state: "copying"; startedAt: number; wasActive: boolean }
  | { state: "justCopied"; copiedAt: number; wasActive: boolean };
```

### 2.3 Plugin System

Plugins podem registrar hooks, actions de context menu e theme overrides:

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

**Hooks disponíveis** (30+ hooks):
- Lifecycle: `onActivate`, `onDeactivate`, `onStateChange`
- Element: `onElementHover`, `onElementSelect`
- Drag: `onDragStart`, `onDragEnd`
- Copy: `onBeforeCopy`, `transformCopyContent`, `onAfterCopy`, `onCopySuccess`, `onCopyError`
- UI: `onSelectionBox`, `onDragBox`, `onGrabbedBox`, `onElementLabel`, `onCrosshair`
- Context menu: `onContextMenu`
- Agent: `transformAgentContext`
- Transform: `transformHtmlContent`, `transformScreenshot`, `transformOpenFileUrl`, `transformSnippet`

**Plugins built-in**: `screenshotPlugin`, `copyHtmlPlugin`, `openPlugin`, `commentPlugin`

**Registro**:
```typescript
window.__REACT_GRAB__.registerPlugin({
  name: 'my-plugin',
  hooks: { onElementSelect: (el) => console.log(el) },
  actions: [{ id: 'my-action', label: 'Do thing', onAction: (ctx) => {} }]
});
```

### 2.4 Agent Integration (o maior diferencial)

#### Fluxo completo:

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

#### Relay Protocol (WebSocket na porta 4722):

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
  handlers?: string[];  // lista de agents disponíveis
}
```

#### Claude Code Handler:

```typescript
// Usa @anthropic-ai/claude-agent-sdk
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

// Streaming de mensagens
for await (const message of queryResult) {
  if (message.type === "assistant") {
    yield { type: "status", content: textContent };
  }
  if (message.type === "result") {
    yield { type: "status", content: "Completed" };
  }
}
```

**Features do agent system:**
- Session persistence (resume após reload)
- Follow-up prompts na mesma sessão
- Undo/redo de mudanças do agent
- Abort com cleanup
- Error handling + retry
- Status streaming em tempo real no overlay

### 2.5 Snippet Generation (context.ts)

O react-grab gera contexto rico para agents:

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

Intercepta React hooks para pausar re-renders durante seleção:

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

Ao desativar, todos os updates buffered são aplicados de uma vez.

### 2.7 CLI Tool

```bash
npx grab init
```

- Detecta framework: Next.js (App/Pages router), Vite, Webpack
- Gera template de instalação específico
- Mostra diff antes de aplicar
- Suporta `add`, `configure`, `remove` commands

### 2.8 Outras Features

- **Context Menu**: Right-click com actions extensíveis via plugins
- **Toolbar**: Barra flutuante draggable em qualquer edge da tela
- **Arrow Navigation**: ↑↓←→ para navegar entre parent/child/siblings
- **Auto-scroll**: Scroll automático quando hover perto das bordas
- **Touch Mode**: Suporte a tela touch
- **Activation Modes**: Toggle (click to activate/deactivate) ou Hold (hold key)
- **Web Extension**: Chrome extension para usar em qualquer site React
- **Global API**: `window.__REACT_GRAB__` com `activate()`, `deactivate()`, `copyElement()`, etc.
- **Crosshair**: Linhas guia cruzadas que seguem o cursor

---

## 3. Arquitetura do svelte-grab (atual)

### 3.1 Estrutura

```
src/lib/
├── SvelteGrab.svelte  # Tudo: eventos, metadata walking, popup, overlay, CSS (~1650 lines)
├── types.ts           # Interfaces TypeScript
└── index.ts           # Re-exports
```

### 3.2 Mecanismos Internos

- **Dev mode detection**: Scanneia DOM por `__svelte_meta` property
- **Component stack**: Percorre `__svelte_meta.parent` chain, deduplicando por `file:line`
- **Selection mode**: Modifier key (Alt) ativa hover-highlight com tooltip file:line
- **Multi-select**: Shift+modifier+click com `SvelteSet<HTMLElement>`
- **Screenshot**: Lazy-load de `html-to-image` (peer dependency opcional)
- **Editor integration**: URLs de protocolo para vscode, cursor, webstorm, zed, etc.
- **History**: Array de grabs anteriores com timestamp

### 3.3 Output Format

```
<button class="btn-primary" type="submit">
  Submit
</button>
Used in: src/routes/+page.svelte:42
Defined in: src/lib/components/Button.svelte:15
```

---

## 4. Comparação Feature-by-Feature

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

## 5. Vantagens do svelte-grab

1. **`__svelte_meta` é mais confiável**: Metadado nativo do Svelte, enquanto react-grab depende do bippy (hack em React DevTools/fibers)
2. **Instalação mais simples para Svelte**: `<SvelteGrab />` no layout vs `<Script>` tags
3. **History feature**: react-grab não tem histórico explícito de grabs
4. **Componente auto-contido**: Zero dependencies externas (exceto html-to-image opcional)
5. **Svelte 5 reactivity**: `$state()`, `$derived()`, `SvelteSet` — mais idiomático

---

## 6. Roadmap de Melhorias (Priorizado)

### P0 — Game-changers

#### 6.1 Agent Integration com WebSocket Relay
O maior diferencial do react-grab. Criar:
- `@svelte-grab/relay` — WebSocket relay server
- `@svelte-grab/provider-claude-code` — Handler usando `@anthropic-ai/claude-agent-sdk`
- `@svelte-grab/provider-cursor` — Handler para Cursor

O fluxo: usuário seleciona elemento → digita prompt → agent recebe contexto + prompt → executa mudanças → status streaming no overlay.

#### 6.2 Plugin System
Extrair funcionalidades em plugins extensíveis:
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

### P1 — Competitividade

#### 6.3 CLI Tool
```bash
npx svelte-grab init
```
Auto-detectar SvelteKit e injetar `<SvelteGrab />` no `+layout.svelte`.

#### 6.4 Drag Selection
Click + drag para selecionar múltiplos elementos com box selection.

#### 6.5 Context Menu
Right-click em elemento selecionado → menu com: Copy for Agent, Copy HTML, Open in Editor, Screenshot, Send to Agent.

#### 6.6 Modularização
Quebrar o arquivo de 1650 linhas:
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
↑ = parent, ↓ = first child, ← = previous sibling, → = next sibling.

#### 6.8 Toolbar Flutuante
Barra draggable com toggle de ativação, info do elemento, ações rápidas.

#### 6.9 Activation Modes
- **Toggle**: Click para ativar, click para desativar (como react-grab padrão)
- **Hold**: Segura a tecla para ativar (nosso modo atual)

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
Playwright tests cobrindo: ativação, seleção, copy, multi-select, editor integration, screenshot.

### P3 — Extras

- **Auto-scroll** nas bordas da viewport
- **Web Extension** para qualquer site Svelte em dev
- **Crosshair** linhas guia
- **Touch support**
- **Freeze Svelte updates** (interceptar `$state` proxy durante seleção)

---

## 7. Insight Arquitetural Chave

O react-grab separa **core** (framework-agnostic) de **framework-specific** (React fiber detection). O overlay inteiro é renderizado com SolidJS em Shadow DOM, independente do React.

Para svelte-grab, a abordagem pragmática é:
1. Manter o core como componente Svelte (nosso alvo é só Svelte)
2. Modularizar internamente em módulos separados
3. Adicionar relay system como pacote independente (`@svelte-grab/relay`)
4. Manter a detecção via `__svelte_meta` (mais simples e confiável que hacking de fibers)
