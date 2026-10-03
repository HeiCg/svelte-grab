# Contributing to svelte-grab

Thanks for your interest in improving svelte-grab! This guide covers the build
model, the available scripts, and what we expect from pull requests.

## Project layout & build model

svelte-grab ships **two distinct build targets** from a single repo, each with
its own TypeScript project:

1. **Svelte components** (`src/lib/`) — browser-side code, built by
   [`svelte-package`](https://kit.svelte.dev/docs/packaging) using
   `tsconfig.json`. This produces the `dist/` package consumed via the
   `svelte-grab` entry point.
2. **Server / Node code** (`src/relay/`, `src/cli/`, `src/mcp/`) — plain
   Node.js, built by `tsc -p tsconfig.server.json`.

These are compiled separately: `src/lib/` goes through the Svelte compiler,
everything else through plain `tsc`. Keep browser-only APIs out of the Node
code and vice versa.

## Prerequisites

- Node.js **>= 22.12**
- npm (the repo uses `package-lock.json`)

Install dependencies:

```bash
npm ci
```

## Scripts

| Command            | What it does                                                      |
| ------------------ | ---------------------------------------------------------------- |
| `npm run build`    | Build both targets (`svelte-package` + server `tsc`)             |
| `npm run check`    | Type-check the Svelte sources with `svelte-check`                |
| `npm test`         | Run the Vitest unit tests in watch mode                          |
| `npm run test:run` | Run the Vitest unit tests once (used in CI)                      |
| `npm run lint`     | Lint with ESLint (flat config, TS + Svelte)                      |
| `npm run format`   | Format the codebase with Prettier                                |

## Tests

Unit tests live under `tests/` and run on [Vitest](https://vitest.dev/). Pure
TypeScript modules are tested in the `node` environment; tests that need a DOM
opt into jsdom per-file with a docblock pragma:

```ts
// @vitest-environment jsdom
```

Add tests for any pure utility you change, and run `npm run test:run` before
opening a PR.

### End-to-end tests

`npm run test:e2e` runs Playwright against `examples/playground`, served by
`vite dev` on port **5189**. Playwright starts the dev server itself (and reuses
one already running on 5189 outside CI).

The port comes from `SG_E2E_PORT`, read by both `playwright.config.ts` and the
playground's `vite.config.ts`. To run a second suite in parallel (another
checkout or worktree), give it its own port:

```bash
SG_E2E_PORT=5219 npx playwright test
```

With `SG_E2E_PORT` set, Playwright always starts a fresh playground and never
reuses a server already listening on that port.

## Dev-only security note

svelte-grab is a **development tool**. All components read `__svelte_meta`,
which Svelte only attaches in dev builds, and they auto-disable in production.
The relay server, MCP server, and agent integrations are intended to run on a
developer's local machine only. **Do not** expose the relay/MCP servers to
untrusted networks, and never ship the dev tools enabled in a production bundle.

## Pull requests

- Keep changes focused; one logical change per PR.
- Add a [changeset](https://github.com/changesets/changesets) describing your
  change (`npx changeset`) so releases stay automated.
- Make sure **CI passes**: `npm run build`, `npm run check`, and
  `npm run test:run` must all succeed. Lint is currently advisory.
- Match the existing code style; run `npm run format` before committing.

Thanks again for contributing!
