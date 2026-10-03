---
name: svelte-grab
description: Inspect, edit and verify a live Svelte 5 / SvelteKit app through the svelte-grab MCP tools (ui_snapshot, ui_find, ui_inspect, ui_wait_for_hmr, ui_verify, ui_profile). Use when changing UI in a Svelte app running in dev, when asked "which component renders X", "where is this button defined", "did my edit land", "fix the layout/style of this element", when the human left annotations in the page, or before editing a shared component. For security or performance audits use the svelte-grab-audit skill.
---

# svelte-grab: eyes into the running Svelte app

svelte-grab runs inside the app in dev (`<SvelteDevKit enableMcp />`) and answers over MCP
(server `svelte-grab`, started by `npx svelte-grab-mcp --stdio`). Every element it reports
carries its component, `file:line` and a ref (`eN`). It does not click or screenshot for real:
that stays with Playwright MCP / chrome-devtools MCP.

Preconditions: dev server running, app open in a browser tab. If a tool says
"No browser tab connected", ask the human to open the app (or check `ui_tabs`).

## The loop

```
ui_snapshot -> ui_find -> ui_inspect -> [ui_component_impact] -> edit
-> ui_wait_for_hmr -> ui_verify -> [ui_profile]
```

1. `ui_snapshot({ scope?: "viewport"|"page"|ref, detail?: "minimal"|"normal", maxNodes? })`:
   compact tree, one line per element: `eN <role/tag> "<name>" <Component> <file:line>`.
   Start here when you do not know the page yet. `detail: "normal"` adds box + classes.
2. `ui_find({ text?, role?, name?, component?, file?, selector?, limit? })`: refs for
   what you need, with `stableKey`, component, source, box, visible.
3. `ui_inspect({ ref, include?: ["stack","props","state","styles","layout","a11y","usage"] })`:
   heavy context for ONE ref (~8000 chars max). Ask only for the sections you need.
   COMPONENT and SOURCE (the `file:line:col` to edit) are always there.
4. `ui_component_impact({ ref })` BEFORE editing a component that may be shared: instances
   on the page, importers (needs the `svelte-grab/vite` plugin) and a recommendation
   (edit the component vs. a prop/variant or local class at the usage site).
5. Edit the file. Note the time you saved it.
6. `ui_wait_for_hmr({ files: ["Card.svelte"], timeoutMs?, since? })`: waits for the HMR
   update, re-resolves refs. `status: "error"` = compile error: fix it before going on.
   Pass `since` (epoch ms of the save) if the update may already have happened.
7. `ui_verify({ ref, checks?: ["visible","overflow","console","a11y","contrast"], since? })`:
   PASS/WARN/FAIL per check. Fix FAILs, then wait + verify again.
8. `ui_profile({ durationMs?: 3000, action?: { ref, type: "click"|"input"|"scroll", value?, repeat? }, component?, ref? })`
   when the change touched reactive code: verdict `QUIET` or `HOT <Component> N mutations ...`.

Stale refs are fine: pass the old `eN` (or its `ui://` stable key) to any `ui_*` tool and it
is re-resolved; the new ref is reported as rebound.

## Refs as locators for real input

Every ref is stamped on the element as `data-sg-ref`, so `[data-sg-ref="e12"]` is a CSS
locator for other tools:

- Playwright code / Playwright MCP code tool: `page.locator('[data-sg-ref="e12"]').click()`
- chrome-devtools MCP `evaluate_script`: `() => document.querySelector('[data-sg-ref="e12"]').getBoundingClientRect()`
- Tools that click by their own snapshot ids (chrome-devtools `click { uid }`, Playwright
  MCP `browser_click { ref }`): match the role + accessible name svelte-grab gave
  (`button "Save"`) in their snapshot.

Use real input (those tools) for trusted clicks, typing, screenshots, viewports.
`ui_profile` / `ui_leak_check` actions are in-page and `isTrusted=false`.

## Human annotations and handoff

- `ui_annotations({ clear?: boolean })`: changes the human requested by selecting elements
  in the page and typing comments. Each annotation = one change; `refs` go straight to
  `ui_inspect`. Pass `clear: true` once you have taken them.
- `watch_for_grab`: blocks until the human Alt+Clicks an element and sends a prompt.
  Use only when the human asks you to listen.

## Which tool when

| Question | Tool |
|---|---|
| What is on the page / where am I | `ui_snapshot` |
| Find "the Save button", all `Card`s, elements from a file | `ui_find` |
| Why does it look/behave like this (props, state, styles, layout, a11y) | `ui_inspect` |
| Is it safe to edit this component | `ui_component_impact` |
| Did my edit land, which refs changed | `ui_wait_for_hmr` |
| Is the element still fine (visible, no overflow, no console errors, a11y, contrast) | `ui_verify` |
| Is a component updating the DOM too often | `ui_profile` |
| What does this screen load, credentials leaking, slow page, memory leak | svelte-grab-audit skill (`ui_network`, `ui_security_scan`, `ui_perf_metrics`, `ui_leak_check`) |
| Several tabs open | `ui_tabs`, then pass `tabId` |

## Notes

- Tokens: `ui_snapshot` is cheap, `ui_inspect` is not. Narrow with `ui_find` and `include`.
- Ports: the page finds the server on `127.0.0.1:4723` (next free port up to 4732).
  Loopback only. If the server was started with `--token` / `SVELTE_GRAB_TOKEN`, the page
  needs `mcpToken`.
- Dev only: nothing works in a production build (no `__svelte_meta`).
- Svelte docs and `svelte-autofixer` live in the official Svelte MCP (`@sveltejs/mcp`), not here.
