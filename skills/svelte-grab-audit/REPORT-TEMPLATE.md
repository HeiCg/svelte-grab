# <App name> security and performance audit

Date: <YYYY-MM-DD> · Commit: <sha> · Environment: dev server <url> · CDP mode: <on|off>
Budgets used: <50 requests, 1.5 MB, 10 third-party per screen (defaults) | user's budgets>

## Summary

<2-4 sentences: the most important confirmed problems, and what was not checked.>

| Severity | Confirmed | Needs validation |
|---|---|---|
| High | 0 | 0 |
| Medium | 0 | 0 |
| Low | 0 | 0 |
| Info | 0 | 0 |

## Screens

One row per screen, initial load (`ui_network({ reload: true })`) unless noted. Mark values
over budget with `!`.

| Screen (route) | Requests | Bytes | 3rd-party (origins) | Duplicates | Failed | Leaks / credential findings | Hot components (idle / interaction) | Long frames | Memory (`ui_leak_check`) |
|---|---|---|---|---|---|---|---|---|---|
| `/` | 32 | 840 KB | 6 (3) | 0 | 0 | none | none / none | 0 | n/a (no toggles) |
| `/settings` | 61 ! | 1.9 MB ! | 12 ! (5) | 2 | 1 | F1 (high) | none / `PlanList` | 1 (240 ms) | LEAK? `Modal.svelte:12` |

## Findings

Sorted by severity, high first. Evidence is always redacted (`kind:abcd…(len N, sha xxxxxx)`);
never paste a full secret.

### F1. <Title> (high, confirmed)

- **Screen:** `/settings`
- **Check:** S1 (CHECKLIST.md) · **Found by:** `ui_security_scan` [transit] / `npx svelte-grab audit` rule <id>
- **Evidence:** `<tool output line, request line, or code excerpt, redacted>`
- **Source:** `src/routes/settings/+page.svelte:42`
- **Reproduce:** <the exact tool call or steps that show it>
- **Fix:** <file and change>

### F2. <Title> (medium, needs_validation)

- **Screen:** ...
- **Check:** ...
- **Evidence:** ...
- **Source:** `file:line`
- **Missing fact:** <the one thing that would confirm or reject it>
- **Fix (if confirmed):** ...

## Rejected candidates

| Candidate | From | Why rejected |
|---|---|---|
| <title> | `npx svelte-grab audit` / `ui_security_scan` | <one line: placeholder value, first-party origin, header set by the CDN in prod, ...> |

## Not checked

<Items left open and why: CDP mode off (P12, P13 partial), screens behind auth not reached, production headers not available, ...>

## Methodology

- Static: `npx svelte-grab audit --json audit.json` (<flags>), <N> findings, <M> kept after validation.
- Runtime, per screen: `ui_network({ reload: true })`, `ui_security_scan()`,
  `ui_profile({ durationMs: 3000 })` idle and with the main interaction, `ui_verify` on key
  elements; CDP mode: `ui_perf_metrics`, `ui_leak_check` on modals and toggles.
- Validation: every candidate reproduced or disproved; `confirmed` only with reproduction
  evidence, `needs_validation` names the missing fact.
- Tools: svelte-grab <version> MCP server, browser <name/version>, <other MCP servers used>.
