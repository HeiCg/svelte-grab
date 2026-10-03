# svelte-grab audit checklist

Run per screen. "How" names the tool (and, for `ui_security_scan` / `ui_verify`, the
`checks` value in brackets) or the static scanner (`npx svelte-grab audit`). A runtime
finding marked `needs_validation`, and every static finding, must go through Phase 3 of
SKILL.md before it is reported as `confirmed`.

## Security checklist (per screen)

| ID | Check | How (tool [check] / rule) | Pass when |
|---|---|---|---|
| S1 | Requests to third parties carry no auth headers, cookies or tokens | `ui_network` `{ reload: true }`, then `ui_security_scan` [transit] | No transit finding about Authorization / Cookie / API-key headers or credentials in bodies to a third-party origin |
| S2 | No secrets in URLs (query string or fragment) | `ui_security_scan` [transit]; `ui_network` lines show redacted `kind:abcd…` values | No secret-shaped value or sensitive parameter name in any request URL |
| S3 | No auth tokens in Web Storage | `ui_security_scan` [storage] | No JWT / API key in localStorage or sessionStorage, no auth-looking IndexedDB |
| S4 | Session cookie is not readable by JS | `ui_security_scan` [cookies] | No session/auth-looking cookie in `document.cookie` (it is `HttpOnly`) |
| S5 | No secrets on `window` globals | `ui_security_scan` [globals] | No secret-shaped value reachable from `window` |
| S6 | Page data has no sensitive fields | `ui_network` `{ reload: true, includeBodies: true }`, then `ui_security_scan` [sveltekit]; `npx svelte-grab audit` (load returning whole DB rows) | No `password`, `hash`, `secret`, `token`, `apiKey`, `ssn`... in serialized page data or `__data.json`; loads select fields explicitly |
| S7 | No secret-shaped `PUBLIC_` / `VITE_` values | `ui_security_scan` [env]; `npx svelte-grab audit` (`.env*` files, `$env/static/public`) | Every client-exposed env value is meant to be public (or restricted by referrer at the provider) |
| S8 | No secrets in client-reachable code | `npx svelte-grab audit` (secrets outside `/server/`, `*.server.*`, `$lib/server`) | Secrets only in server-only modules |
| S9 | CSP and core security headers present (production) | `ui_security_scan` [headers]; `npx svelte-grab audit` (`hooks.server` headers, Kit `csp` config) | CSP without `unsafe-inline` / `unsafe-eval` for scripts, `X-Content-Type-Options`, `Referrer-Policy`, frame-ancestors or `X-Frame-Options`, HSTS in prod; dev-only gaps are `info` |
| S10 | No `{@html}` on user input | `ui_security_scan` [dom]; `npx svelte-grab audit` (`{@html}` with non-literal input) | No inline handlers / `javascript:` URLs in rendered HTML; every `{@html}` input is trusted or sanitized |
| S11 | External links use `rel=noopener` | `ui_security_scan` [dom]; `npx svelte-grab audit` | Every external `target=_blank` link has `rel="noopener"` (or `noreferrer`) |
| S12 | `postMessage` listeners check the origin | `npx svelte-grab audit` (static) | Every `message` listener checks `event.origin` against an allowlist |
| S13 | No mixed content | `ui_security_scan` [mixed] | No `http://` or `ws://` request from an `https://` page |
| S14 | Error responses do not leak stack traces | `ui_network` `{ filter: { status: "failed" }, includeBodies: true }`, then read the bodies | Failed same-origin responses carry a message, not a stack trace or SQL |
| S15 | Forms, actions and remote commands check auth | `npx svelte-grab audit` (actions / remote `command`s without auth check, `needs_validation`), then read each one | Every mutating action / command checks the session before acting |
| S16 | CSRF protection not disabled | `npx svelte-grab audit` (`trustedOrigins: ['*']`) | Kit CSRF check on; no wildcard trusted origins |
| S17 | Dependencies without known advisories | `npx svelte-grab audit --deps` | No high/critical advisory on `svelte`, `@sveltejs/kit` or other runtime deps |

## Performance checklist (per screen)

Default budgets (initial load): at most 50 requests, at most 1.5 MB transferred, at most 10
third-party requests. Use the user's budgets when given.

| ID | Check | How (tool [check] / rule) | Pass when |
|---|---|---|---|
| P1 | Request count within budget | `ui_network` `{ reload: true }` (totals) | Count at most 50 |
| P2 | Bytes transferred within budget | `ui_network` `{ reload: true }` (totals, by type) | At most 1.5 MB |
| P3 | Third-party requests within budget | `ui_network` `{ reload: true }` (first- vs third-party, ORIGINS) | At most 10 third-party requests |
| P4 | No duplicate requests | `ui_network` (DUPLICATES) | Section empty (same method + URL fired once) |
| P5 | No avoidable request waterfalls | `ui_network` (WATERFALL, initiators) | No chain deeper than 3 that could run in parallel or move to `load` |
| P6 | Data loaded in `load`, not in `onMount` | `ui_network` initiator `file:line` + component, then read the source | Page data requests come from `+page(.server).ts` / `+layout(.server).ts`, not from component `onMount` / `$effect` |
| P7 | Images sized and lazy below the fold | `ui_network` `{ filter: { type: ["image"] } }`; `ui_inspect` [props, layout] on the `img` | Explicit `width`/`height` (or aspect-ratio), `loading="lazy"` below the fold, transfer size fits the rendered box |
| P8 | Fonts preloaded and subset | `ui_network` `{ filter: { type: ["font"] } }` | Few font files, small (subset), discovered early (preload in `<svelte:head>` / `app.html`) |
| P9 | No HOT components at idle | `ui_profile` `{ durationMs: 3000 }` with no action | Verdict `QUIET` |
| P10 | No layout shift on load | chrome-devtools MCP performance trace (CLS); `ui_perf_metrics` LayoutCount as a hint | CLS below 0.1; no late-loading content pushing the layout |
| P11 | Smooth main interaction | `ui_profile` `{ action: { ref, type: "click", repeat: 5 } }` | FPS min at least 55, no HOT component caused by the interaction |
| P12 | No long tasks over 200 ms | `ui_profile` (long frames); `ui_perf_metrics` (TaskDuration, ScriptDuration) | No long frame over 200 ms during load or the main interaction |
| P13 | No leaks on open/close cycles | `ui_leak_check` `{ actions: [open, close], iterations: 5 }` (CDP mode) | `NO LEAK DETECTED`; without CDP the result is `INCONCLUSIVE` and the item stays open |
| P14 | No console errors on the screen | `ui_verify` [console] on a key element | `PASS console` |
