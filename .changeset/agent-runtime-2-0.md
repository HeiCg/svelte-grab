---
'svelte-grab': major
---

feat: svelte-grab 2.0, the agent runtime. Give coding agents eyes into your Svelte app.

- New MCP tools that query the live page: `ui_tabs`, `ui_snapshot`, `ui_find`, `ui_inspect`, `ui_wait_for_hmr`, `ui_verify`, `ui_component_impact`, `ui_annotations` and `ui_profile`, for the loop `ui_snapshot -> ui_find -> ui_inspect -> edit -> ui_wait_for_hmr -> ui_verify`. Every reported element carries its component, source location and a `[data-sg-ref="eN"]` locator for Playwright MCP / chrome-devtools MCP.
- New optional Vite plugin `svelte-grab/vite`: HMR file list, module-graph importers, open-in-editor through Vite.
- Annotation mode and opt-in `hotkeys="minimal"`.
- New optional peer `zod` (needed by the MCP server alongside `@modelcontextprotocol/sdk`).
- `svelte-grab init` now also writes/merges `.mcp.json` (svelte-grab + the official Svelte MCP, optional Playwright MCP), adds the Vite plugin and injects `<SvelteDevKit enableMcp />` when the MCP server is configured. Opt out with `--no-mcp-json`, `--no-svelte-mcp`, `--no-vite-plugin`; preview with `--dry-run`.
- New `sv` community add-on bundled in the package (`svelte-grab/sv`): `npx sv add svelte-grab` does what `init` does, skills included.
- The WebSocket relay is in maintenance mode: still supported, new integrations should use MCP.
- Fixed the relay providers against the real SDK APIs: Claude Code now consumes the `query()` message stream (abort via `abortController`, resumes the session, edits allowed with `acceptEdits`); Codex uses the `Codex` class, awaits `runStreamed()` and reads `agent_message` items (`workspace-write` sandbox).
- `SvelteDevKit` gives every shortcut a single owner: Alt+Ctrl/Meta+Click and Alt+DoubleClick no longer also trigger the SvelteGrab inspector (new `SvelteGrab` props `reservedModifiers`, `reservedContextMenuModifiers`, `yieldDoubleClick` and an exported `dismiss()`).

Breaking:

- Requires Node.js 22.12+ (`engines`). Node 18 and 20 are end-of-life; CDP mode relies on Node 22's built-in `WebSocket`, and Vite 8 / SvelteKit 3 need Node 22 too.
- Peer dependency `svelte` is now `^5.35.1` (the `__svelte_meta.parent` chain behind component stacks starts there); `init` warns below it.
- `svelte-grab init` edits more files by default (`.mcp.json`, `vite.config.*`) and no longer calls `process.exit` from the library function (`init()` returns a result; the CLI sets the exit code).
- Inside `SvelteDevKit` with multi-select on, the State Inspector trigger moved from Alt+Shift+Click to Alt+Meta+Click (Shift+Alt+Click is multi-select). Override with `stateSecondaryModifier`.
- Inside `SvelteDevKit`, the A11y element audit moved from Alt+RightClick to Alt+Shift+RightClick (Alt+RightClick is the SvelteGrab context menu in selection mode); Alt+A page audit is unchanged and standalone `SvelteA11yReporter` keeps Alt+RightClick.
