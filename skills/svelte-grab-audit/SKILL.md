---
name: svelte-grab-audit
description: Security and performance audit of a Svelte / SvelteKit app, per screen, with verified findings. Use when asked for a security audit, performance audit, "what does screen X load", "how many requests does this page make", "is anything leaking credentials / tokens / API keys", "why is this page slow", "is there a memory leak", or before a release. Combines the static scanner (npx svelte-grab audit) with the live-page MCP tools ui_network, ui_security_scan, ui_profile, ui_verify and, in CDP mode, ui_perf_metrics and ui_leak_check.
---

# svelte-grab audit: security + performance, screen by screen

Goal: for each screen, answer "how many requests fire, what do they cost, does anything leak
credentials, is anything hot or leaking memory", and back every finding with evidence.

Supporting files (same folder):

- [CHECKLIST.md](CHECKLIST.md): every check, the tool that runs it, and when it passes.
- [REPORT-TEMPLATE.md](REPORT-TEMPLATE.md): the report to fill in.
- [finding-schema.json](finding-schema.json): JSON shape of a finding.

Needs the svelte-grab MCP server and the app open in dev with `<SvelteDevKit enableMcp />`.
The core loop and ref locators are in the `svelte-grab` skill.

## Phase 1: Recon

1. List the routes (`src/routes/**/+page.svelte`, plus `+page(.server).ts`, `+layout*.ts`,
   `+server.ts`, `hooks.server.ts`). Pick the screens: the ones the user named, else home,
   auth/login, the main authenticated screen and any screen with forms or payments.
   Keep it to 3-6 screens unless asked for more.
2. Static scan: `npx svelte-grab audit --json audit.json` (add `--min-severity medium` to cut
   noise, `--deps` to include dependency advisories, `--html report.html` for humans,
   `--ci` to fail on findings). Its findings are candidates, not verdicts.
3. `ui_tabs`: confirm a tab is connected. With several, pass `tabId` everywhere.
4. CDP mode? It is on when the server runs with `--cdp=http://127.0.0.1:9222` (or
   `SVELTE_GRAB_CDP`). Without it `ui_perf_metrics` errors and `ui_leak_check` answers
   `INCONCLUSIVE`; say so in the report instead of guessing.

## Phase 2: Per screen (runtime)

Navigate to the screen (Playwright / chrome-devtools MCP, or ask the human), then:

1. `ui_network({ reload: true })`: the initial load. Totals, by type, first- vs third-party,
   ORIGINS, DUPLICATES, SLOWEST 5, WATERFALL, FAILED, one line per request with initiator
   `file:line` + component. Add `includeBodies: true` when you need SvelteKit
   `__data.json` / remote-function payloads for the data-exposure check.
2. `ui_security_scan()`: right after step 1, so the transit checks see the page load.
   Findings come with `severity`, `verdict`, redacted `evidence`, `source`, `fix`.
3. `ui_profile({ durationMs: 3000 })` with no action: idle check, must be `QUIET`.
   Then once with the main interaction, e.g.
   `ui_profile({ action: { ref, type: "click", repeat: 5 } })`, for FPS and long frames.
4. `ui_verify({ ref })` on the key elements of the screen (main heading, primary button,
   form): console errors, overflow, a11y, contrast.
5. CDP mode only: `ui_perf_metrics({ action: { ref, type: "click" } })` on the main
   interaction, and `ui_leak_check({ actions: [open, close], iterations: 5 })` on every
   modal, drawer, tab panel or toggle that mounts/unmounts components.
6. Interactions that load more (pagination, search, opening a dialog): `ui_network({ since })`
   with the epoch ms taken right before the interaction.

Fill the per-screen row of the report as you go (see REPORT-TEMPLATE.md).

## Phase 3: Validate each candidate

Every static finding and every `needs_validation` runtime finding is a hypothesis. Try to
disprove it before reporting it:

- Reproduce: re-run the tool, follow the request in `ui_network`, open the `source`
  `file:line`, read the `+page.server.ts` load, check whether the value is real or a
  placeholder, whether the third party is actually yours (same company, first-party API
  on another subdomain), whether the header is set in production (`hooks.server.ts`,
  adapter, CDN) even if missing in dev.
- Verdicts:
  - `confirmed`: you reproduced it and can quote the evidence (tool output line, request,
    `file:line`). Nothing is `confirmed` on pattern match alone.
  - `needs_validation`: plausible but one fact is missing. Name that exact fact
    ("is `/api/me` behind auth in production?", "is PUBLIC_MAPS_KEY restricted by referrer
    in the provider console?"), not "needs more review".
  - Disproved: drop it from the findings and list it under "Rejected candidates" with the
    one-line reason.
- Dev vs prod: missing HSTS/CSP or reachable source maps on `localhost` are `info` unless
  you confirmed the production config.

## Phase 4: Report

Use REPORT-TEMPLATE.md: per-screen table, then findings sorted by severity (high first),
each with severity, verdict, title, evidence, `file:line`, fix. Optionally emit the
findings as JSON matching finding-schema.json (same shape as `ui_security_scan` and
`svelte-grab audit`).

## Rules

- Never write a full secret anywhere (report, JSON, chat, commit). The tools already redact
  as `kind:abcd…(len N, sha xxxxxx)`; keep that form. Two occurrences with the same sha are
  the same secret. If you read a raw value in a source file, redact it the same way.
- Do not exercise attacks against systems you do not own; this audit observes the user's
  own app in dev.
- Budgets (defaults, per screen, initial load): at most 50 requests, at most 1.5 MB
  transferred, at most 10 third-party requests, no duplicates, no long task over 200 ms,
  FPS 55 or more during the main interaction, `QUIET` at idle. Use the user's budgets when
  given and state which ones you used.
- Fix suggestions name the file and the change (move the fetch to `+page.server.ts` load,
  select fields instead of returning the DB row, add `rel="noopener noreferrer"`, ...).
  Do not apply fixes unless asked; when asked, re-run the check that found it to prove
  the fix (`ui_wait_for_hmr` then the same tool).
