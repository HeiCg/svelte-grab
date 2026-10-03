---
'svelte-grab': major
---

feat: svelte-grab 2.0, the agent runtime. Give coding agents eyes into your Svelte app.

- New MCP tools that query the live page: `ui_tabs`, `ui_snapshot`, `ui_find`, `ui_inspect`, `ui_wait_for_hmr`, `ui_verify`, `ui_component_impact` and `ui_annotations`, for the loop `ui_snapshot -> ui_find -> ui_inspect -> edit -> ui_wait_for_hmr -> ui_verify`. Every reported element carries its component, source location and a `[data-sg-ref="eN"]` locator for Playwright MCP / chrome-devtools MCP.
- New optional Vite plugin `svelte-grab/vite`: HMR file list, module-graph importers, open-in-editor through Vite.
- Annotation mode and opt-in `hotkeys="minimal"`.
- `svelte-grab init` now also writes/merges `.mcp.json` (svelte-grab + the official Svelte MCP, optional Playwright MCP), adds the Vite plugin and injects `<SvelteDevKit enableMcp />` when the MCP server is configured. Opt out with `--no-mcp-json`, `--no-svelte-mcp`, `--no-vite-plugin`; preview with `--dry-run`.
- New `sv` community add-on `@svelte-grab/sv` (`npx sv add @svelte-grab`), published separately.
- The WebSocket relay is in maintenance mode: still supported, new integrations should use MCP.

Breaking:

- Peer dependency `svelte` is now `^5.35.1` (the `__svelte_meta.parent` chain behind component stacks starts there); `init` warns below it.
- `svelte-grab init` edits more files by default (`.mcp.json`, `vite.config.*`) and no longer calls `process.exit` from the library function (`init()` returns a result; the CLI sets the exit code).
