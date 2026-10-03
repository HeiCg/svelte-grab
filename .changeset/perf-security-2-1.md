---
'svelte-grab': minor
---

feat: performance and memory tools for agents.

- Opt-in CDP mode (`svelte-grab-mcp --cdp=http://127.0.0.1:9222` or `SVELTE_GRAB_CDP`, loopback only, off by default; requires Node 22): `ui_perf_metrics` (Chrome counters around an action) and `ui_leak_check` (open/close cycles with forced GC, retained detached elements grouped by component and file:line). Without CDP, `ui_leak_check` runs page-side tracking and reports `INCONCLUSIVE`.
- `ui_network`: what a screen loads (fetch, XHR, sendBeacon, WebSocket, EventSource and resource timing), with the initiating file:line and component, totals, first- vs third-party, duplicates, slowest and failed requests; `reload: true` measures the initial load.
- `ui_security_scan`: runtime checks for credentials in URLs and in requests to third parties, tokens in Web Storage, JS-readable auth cookies, sensitive fields in SvelteKit page data, secret-shaped `VITE_` values, security headers, external links and mixed content. Secrets are always redacted (`kind:abcd…(len N, sha xxxxxx)`).
