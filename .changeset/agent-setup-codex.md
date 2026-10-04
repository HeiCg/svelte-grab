---
'svelte-grab': minor
---

feat: zero-setup agent onboarding for Claude Code and OpenAI Codex.

- The MCP server now sends server instructions in its `initialize` result: a short operating guide (the `ui_*` loop, `[data-sg-ref]` locators, annotations and `watch_for_grab`, audit tools, "open the app in dev first", secrets stay redacted) that Claude Code and Codex load as soon as the server connects. Under 2048 characters, with a self-contained first 512.
- `svelte-grab init` sets up Codex next to Claude Code by default: `.codex/config.toml` gets `[mcp_servers.svelte-grab]` (and `svelte` / `playwright` as for `.mcp.json`; existing tables are never edited), the skills also go to `.agents/skills/` (own manifest), and `AGENTS.md` gets a svelte-grab section (created if missing). An existing `CLAUDE.md` that does not import `AGENTS.md` gets a one-line pointer. New flags: `--agents claude,codex`, `--no-codex`, `--no-agents-md`; `--skills-dir <dir>` now means "this one directory instead"; `--no-mcp-json` skips the MCP config for every agent.
- `svelte-grab skills install|list` take the same `--agents` / `--no-codex` (and `--no-agents-md` for install).
- `sv add svelte-grab`: new `codex` option (default yes) doing the same through sv.
