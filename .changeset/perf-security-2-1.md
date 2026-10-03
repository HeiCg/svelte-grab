---
'svelte-grab': minor
---

feat: performance and memory tools for agents.

- Opt-in CDP mode (`svelte-grab-mcp --cdp=http://127.0.0.1:9222` or `SVELTE_GRAB_CDP`, loopback only, off by default; requires Node 22): `ui_perf_metrics` (Chrome counters around an action) and `ui_leak_check` (open/close cycles with forced GC, retained detached elements grouped by component and file:line). Without CDP, `ui_leak_check` runs page-side tracking and reports `INCONCLUSIVE`.
