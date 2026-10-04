/**
 * Server instructions of the svelte-grab MCP server: the `instructions` field
 * of the initialize result. Claude Code and Codex both load it into the
 * agent's context when the server connects, so any MCP client that honours it
 * learns the workflow with zero setup.
 *
 * Single source: both transports (stdio and HTTP) pass this constant to the
 * McpServer constructor (createSvelteGrabMcpServer in src/mcp/server.ts).
 * Limits (tests/mcp-instructions.test.ts checks them):
 * - at most 2048 characters: Claude Code truncates server instructions there;
 * - the first 512 characters stand alone: Codex recommends it;
 * - every tool name mentioned is registered on the server.
 */
export const MCP_INSTRUCTIONS = `svelte-grab: eyes into the running Svelte 5 app. It runs in the page in dev, so each element comes with its component, file:line to edit and a ref (eN). Loop for UI work: ui_snapshot -> ui_find -> ui_inspect -> ui_component_impact (before editing a shared component) -> edit -> ui_wait_for_hmr -> ui_verify -> ui_profile. Needs the dev server running and the app open with <SvelteDevKit enableMcp />: if ui_tabs is empty, ask the user to open the app; do not guess.

Tools:
- ui_snapshot: compact page tree, cheap; start here.
- ui_find: refs by text, role, name, component, file or selector.
- ui_inspect { ref, include }: props, state, styles, layout, a11y of one ref; heavy, ask only for what you need.
- ui_component_impact { ref }: instances and importers; edit the component or the usage site.
- ui_wait_for_hmr { files } right after saving; status "error" = compile error, fix it first.
- ui_verify { ref }: PASS/WARN/FAIL for visible, overflow, console, a11y, contrast.
- ui_profile: QUIET or HOT <Component> after reactive changes.
Stale refs are re-resolved: pass the old eN. Several tabs: tabId from ui_tabs.

Real input: [data-sg-ref="eN"] is a CSS locator for Playwright MCP / chrome-devtools MCP (trusted clicks, typing, screenshots).

Human handoff: ui_annotations returns the changes the user asked for on elements (clear: true once taken). watch_for_grab blocks until the user Alt+Clicks and sends a prompt; only when asked to listen.

Audits: ui_network { reload: true }, ui_security_scan, ui_profile, and with --cdp ui_perf_metrics / ui_leak_check; npx svelte-grab audit for the static scan. Prompts svelte-grab-loop, security-audit, performance-audit hold the full workflows.

Secrets in results are redacted on purpose: never ask the user for them. Svelte docs and svelte-autofixer are in the official Svelte MCP.`;
