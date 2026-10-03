# svelte-grab 2.0 — Agent Runtime spec

Status: approved direction (2026-10-03). Owner: HeiCg.

## Goal

Turn svelte-grab from "devtool where a human hands context to an agent" into
"runtime the agent queries itself". svelte-grab is the agent's **eyes into the
Svelte app** (Svelte semantics + source), not the agent and not a browser
driver.

Target loop the agent runs alone:

```
ui_snapshot -> ui_find -> ui_inspect -> (agent edits code) -> ui_wait_for_hmr
-> ui_verify -> fix -> ui_verify -> done
```

## Principles

1. **Differentiate on Svelte semantics.** Only an in-page script can read
   `__svelte_meta`. Every ref we emit carries component + source + route.
2. **Don't rebuild Playwright.** Real clicks, real screenshots, viewport resize,
   network: delegate to Playwright MCP / chrome-devtools-mcp. We stamp
   `data-sg-ref="eN"` on referenced elements (dev only) and return a locator
   (`[data-sg-ref="e12"]`) so the agent can act with those tools. In-page
   `ui_click`/`ui_scroll` exist only as best-effort fallbacks (`isTrusted=false`).
3. **Cheap by default, heavy on demand.** Snapshot is minimal; `ui_inspect(ref)`
   returns the heavy context.
4. **Same security model.** Everything goes through the existing MCP HTTP server
   (loopback bind, Origin allowlist, optional bearer token, payload caps —
   `src/utils/security.ts`). No new listening ports.
5. **Non-breaking in 1.x.** Existing hotkeys, components and MCP tools keep
   working. New stuff is additive; hotkey reduction is opt-in
   (`hotkeys="minimal"`), default flips only in a major.
6. **Relay goes maintenance mode.** No new providers/features in
   `src/relay/`; MCP is the integration surface.

## Architecture

```
Coding agent --MCP--> svelte-grab MCP server (src/mcp/server.ts, HTTP :port)
                         |  SSE  GET /events        event: runtime-command
                         |  POST /runtime/result    {id, ok, result|error}
                         v
                 In-page runtime (src/lib/runtime/*, mounted by SvelteGrab/DevKit)
                         |  reads __svelte_meta, DOM, CSSOM, a11y, console
                         |  listens import.meta.hot (vite:afterUpdate/vite:error)
                         v
                 Optional Vite plugin (svelte-grab/vite): HMR file list,
                 module graph importers, /__open-in-editor passthrough
```

### Command channel

- Server -> page: existing SSE `/events`, new event type `runtime-command`,
  data `{ id: string, tool: string, args: object }`.
- Page -> server: `POST /runtime/result` with `{ id, ok: true, result }` or
  `{ id, ok: false, error }`. Same access checks and body cap as `/context`.
- Server keeps a pending map `id -> {resolve, timer}`; default timeout 10s
  (`ui_wait_for_hmr` uses its own `timeoutMs`, max 60s). No page connected ->
  tool returns a clear error: "No browser tab connected. Open the app in dev
  with <SvelteGrab/> mounted."
- Multiple tabs: last-focused tab wins (page reports `focus`/`visibilitychange`
  via `POST /runtime/hello {tabId, url, focused}`); `ui_tabs` lists them and
  tools accept optional `tabId`.

### Wire contract (v1) — server and page must match exactly

- `POST /runtime/hello` body `{ tabId: string, url: string, title: string,
  focused: boolean }` -> `{ ok: true }`. Page sends it on SSE connect, on
  `focus`/`blur`/`visibilitychange`, and as heartbeat every 15s. Server forgets
  tabs not seen for 45s. Active tab = most recent `focused: true` hello, else
  most recently seen tab.
- SSE `/events`, `event: runtime-command`, data
  `{ id: string, targetTabId: string, tool: string, args: object }`.
  Broadcast to all SSE clients; a page handles it only if
  `targetTabId === its tabId`.
- `POST /runtime/result` body `{ id: string, tabId: string, ok: boolean,
  result?: { text: string, data?: object }, error?: string }` -> `{ ok: true }`.
  Unknown/expired `id` -> 404. Same `checkAccess` + body cap as `/context`.
- Server maps a page result to MCP: `content: [{type:'text', text}]`,
  `structuredContent: data` (when present). Page errors -> MCP tool error with
  the message. Timeout -> tool error "Browser tab did not respond in Ns".
- `tabId`: random id per page load, kept in `sessionStorage` (fallback memory).
- Tools a page must implement in Phase 2: `ui_snapshot`, `ui_find`. `ui_tabs`
  is server-only. Unknown tool on page -> `{ok:false, error:'Unknown tool'}`.

## Refs

- Session ref `eN`: incrementing per tab, stamped as `data-sg-ref` on the
  element when first emitted. Cheap, dies on re-render.
- Stable key `ui://<file>:<line>:<col>#<componentTag>[role=..,name=..][i]`:
  built from `__svelte_meta.loc` + nearest component `componentTag` + a11y
  role/name + index among siblings with same key. Survives HMR.
- Registry `ref -> {stableKey, WeakRef<Element>}`. On lookup, if the element is
  disconnected, re-resolve by stable key and return `{ref: newRef, rebound:
  true, previous: oldRef}`. Tools accept either `eN` or `ui://` keys.

## MCP tools (new, prefix `ui_`)

| Tool | Args | Returns |
|---|---|---|
| `ui_snapshot` | `scope: "viewport"\|"page"\|ref`, `detail: "minimal"\|"normal"`, `maxNodes` (default 200) | Indented tree: only elements with Svelte meta or a11y role/name; each line `eN <role/tag> "<name>" <Component> <file:line>`; `normal` adds box + classes |
| `ui_find` | any of `text`, `role`, `name`, `component`, `file`, `selector`; `limit` | List of `{ref, stableKey, component, source, role, name, box, visible}` |
| `ui_inspect` | `ref`, `include?: ("stack"\|"props"\|"state"\|"styles"\|"layout"\|"a11y"\|"events"\|"usage")[]` | Sectioned text built from existing formatters (component-stack, state, css-analyzer, a11y-checker) |
| `ui_wait_for_hmr` | `files?: string[]`, `timeoutMs?` (default 15000, max 55000), `since?` (epoch ms) | `{status: "updated"\|"full-reload"\|"error", updated: string[], errors: string[], rebound: [{from,to}], lost: string[], kept: n, consoleErrors: n, source: "vite-hmr"\|"plugin"\|"heuristic"}` |
| `ui_verify` | `ref`, `checks: ("visible"\|"overflow"\|"console"\|"a11y"\|"contrast")[]` | Per check `PASS\|WARN\|FAIL` + detail |
| `ui_component_impact` | `ref` | Instances of the component on page (count + refs), importers from Vite module graph when plugin present, else "unknown" |
| `ui_click` / `ui_scroll` | `ref` | Best-effort in-page action; result notes `isTrusted=false` and suggests Playwright for real input |
| `ui_tabs` | — | Connected tabs |
| `ui_annotations` | — | Pending human annotations (see Annotation mode) |

Existing tools (`watch_for_grab`, `get_element_context`, …) stay. New tools use
`registerTool` with `title`, `inputSchema`, `outputSchema` where the SDK
version in package.json supports it; migrate old tools to `registerTool` too.

## Foundation fixes (Phase 1, prerequisite)

- Peer `svelte: ^5.35.1` (the `__svelte_meta.parent` chain starts there); the
  CLI version check matches.
- Single meta walker in `src/lib/utils/component-stack.ts`; every other place
  (`SvelteGrab.svelte`, `core/dom-navigation.ts`, `SveltePropsTracer.svelte`,
  `utils/profiler-tracker.ts`) uses it.
- Component naming: for `type: 'component'` parent entries the component name
  is `componentTag`; `file/line` is the *usage site*. Block entries
  (`if/each/await/key/render`) are tagged as blocks, not counted as component
  depth. Types in `types.ts` match Svelte's real shape (`parent: … | null`,
  `type` union, `componentTag?`).
- `inspectable()` -> `inspectable.svelte.ts`: store `$state.snapshot` values,
  key by component + instance (multiple instances don't overwrite). Keep the
  old import path working.
- Playground on Vite 8 + `@sveltejs/vite-plugin-svelte` 7 + latest Svelte 5,
  with fixtures for: nested components, `{#if}/{:else if}/{#each}`, snippets,
  `<svelte:boundary>` with `experimental.async` pending state, transitions,
  forms.

## Phases

1. Foundation (above).
2. Runtime channel + refs registry + `ui_snapshot` + `ui_find` + `ui_tabs`.
3. `ui_inspect` (unify the 7 formatters).
4. Vite plugin `svelte-grab/vite`: HMR events with file list, module-graph
   importers endpoint, `/__open-in-editor` preferred in editor-link with current
   heuristic as fallback; `ui_wait_for_hmr` with rebinding.
5. `ui_verify` + `ui_component_impact`; console error capture always on while
   runtime is connected.
6. Annotation mode (multi-select + per-selection comment -> `ui_annotations`)
   and opt-in `hotkeys="minimal"`.
7. Docs/positioning: README pitch "Give coding agents eyes into your Svelte
   app", `.mcp.json` example with svelte-grab + `@sveltejs/mcp` + Playwright
   MCP, ref->locator recipe; `svelte-grab init` writes `.mcp.json`; `sv`
   community add-on (`npx sv add svelte-grab`); relay marked maintenance.

## Phase 4 notes (implemented)

**Does `import.meta.hot` reach svelte-grab's own modules?** Yes, in every
setup checked (2026-10-03). Vite's `vite:import-analysis` runs on every module
the dev server serves, including pre-bundled deps in `node_modules/.vite/deps`,
and prepends `import.meta.hot = __vite__createHotContext(<url>)` to any module
whose code contains the literal `import.meta.hot`. Neither optimizer (esbuild
in Vite 6, rolldown in Vite 8) rewrites `import.meta.hot` (their `define` only
touches `process.env.NODE_ENV`; Vite's `import.meta.hot -> undefined` define
is build-only). Checked with a scratch app installing a packed copy of the
package (not a link):

| Setup | svelte-grab served as | hot context injected | `ui_wait_for_hmr` source |
|---|---|---|---|
| Vite 8.3 + vite-plugin-svelte 7.3, default | `/node_modules/.vite/deps/svelte-grab.js` (pre-bundled) | yes | `vite-hmr`, file list correct |
| Vite 8.3, `optimizeDeps.exclude: ['svelte-grab']` | `/node_modules/svelte-grab/dist/runtime/hmr.js` | yes | `vite-hmr` |
| Vite 8.3 + `svelteGrab()` plugin | pre-bundled | yes | `vite-hmr`; bridge events also fire, counted once |
| Vite 6.4 + vite-plugin-svelte 5.1 + plugin | pre-bundled (esbuild chunks) | yes | `vite-hmr`; bridge events also fire |
| Playground (alias to `src/lib`) | `/@fs/.../src/lib/runtime/hmr.ts` | yes | `vite-hmr` |

Consequences in the code:

- `src/lib/runtime/hmr.ts` must keep the literal `import.meta.hot` (a cast like
  `const m = import.meta as X; m.hot` would hide it from the lexer); it uses a
  `@ts-expect-error` line for that. Comments/strings mentioning it are ignored
  by the lexer.
- Sources in order: `vite-hmr` (import.meta.hot), `plugin` (the
  `svelte-grab:hmr` window events from `svelte-grab/vite`, only consulted when
  import.meta.hot is missing, so events are never double counted), `heuristic`
  (MutationObserver burst, `updated: []`, the result text says so).
- The plugin injects its client both via `transformIndexHtml` (plain Vite) and
  by prepending `import "virtual:svelte-grab/client"` to app modules that
  import `svelte-grab` (SvelteKit renders its own HTML, so the HTML hook does
  not run there).
- Vite awaits HMR listeners. On `vite:beforeFullReload` with a pending
  `ui_wait_for_hmr`, the tracker holds the reload 250 ms (bridge: `waitUntil`,
  capped at 1 s) so the `full-reload` result reaches the server before the
  page unloads. The update log (last 20) is kept in sessionStorage, so
  `since` still sees a full reload after the page comes back.
- A `vite:error` for a watched file (or with no file) resolves the wait with
  `status: "error"` instead of letting it time out.
- After an update the page waits one frame (capped at 100 ms, hidden tabs do
  not paint) plus a microtask flush, then `RefRegistry.rebindAll()` re-resolves
  every disconnected ref in one page pass: rebound refs become aliases of the
  new ref (`resolve(old)` keeps working), refs with no replacement are dropped
  and reported once in `lost`.
- e2e: `e2e/hmr.spec.ts` edits playground files on disk, so it runs in its own
  Playwright project after the others (`dependencies: ['chromium']`).

## Out of scope (for now)

- Own compiler manifest / `data-sg` IDs at build time (revisit only if
  rebinding by `file:line:col` fails in practice).
- Automatic `$state` instrumentation via compiler transform.
- Built-in pixel diff / multi-viewport runner (delegate to Playwright).

## Acceptance (whole project)

- e2e: an agent-style script calls `ui_snapshot` -> `ui_find({component:"Card"})`
  -> `ui_inspect` -> edits `Card.svelte` -> `ui_wait_for_hmr` returns the file
  and a rebound ref -> `ui_verify` PASS, all against the playground.
- No new listening port; all new endpoints pass the existing security checks
  and have unit tests for rejection paths.
- Unit + e2e green in CI; runners use max 2 workers.
