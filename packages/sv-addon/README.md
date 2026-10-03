# @svelte-grab/sv

[`sv`](https://svelte.dev/docs/cli) community add-on for [svelte-grab](https://github.com/HeiCg/svelte-grab): give coding agents eyes into your Svelte app.

```bash
npx sv add @svelte-grab
```

(`@svelte-grab` resolves to `@svelte-grab/sv`, per the sv naming convention for `@<org>/sv` add-ons.)

It does the same as `npx svelte-grab init`, through sv:

| Step | File |
|------|------|
| Dev dependencies: `svelte-grab`, plus `@modelcontextprotocol/sdk` and `zod` (needed by `svelte-grab-mcp --stdio`) when the MCP server is configured. Packages already in `package.json` are left alone. | `package.json` |
| MCP servers for your coding agent: `svelte-grab` (stdio), optional `svelte` (`@sveltejs/mcp`) and `playwright` (`@playwright/mcp`). Existing entries are never replaced. | `.mcp.json` |
| `svelteGrab()` from `svelte-grab/vite` after `sveltekit()` / `svelte()` in `plugins`, when the config has a plain `plugins: [...]` array; otherwise a next step tells you what to add. | `vite.config.(ts\|js)` |
| `<SvelteDevKit />` gated by `dev` from `$app/environment` (SvelteKit) or at the end of `src/App.svelte` (Vite + Svelte). `enableMcp` is set when `.mcp.json` declares the `svelte-grab` server. | `src/routes/+layout.svelte` / `src/App.svelte` |
| Agent skills `svelte-grab` (UI loop) and `svelte-grab-audit` (security + performance audit). Files you have not touched since the last install are updated in place (tracked in `.claude/skills/.svelte-grab-skills.json`); a file you edited is never overwritten: the new version goes next to it as `<file>.new`. Files no longer shipped are listed in the next steps (the add-on cannot delete files). An existing `AGENTS.md` gets a one-time pointer. | `.claude/skills/*/`, `.claude/skills/.svelte-grab-skills.json`, `AGENTS.md` |

Running it twice changes nothing.

## Options

| Option | Default | Question |
|--------|---------|----------|
| `mcpJson` | `yes` | Write `.mcp.json` so your coding agent starts the svelte-grab MCP server? |
| `svelteMcp` | `yes` | Also add the official Svelte MCP? (asked only with `mcpJson`) |
| `playwrightMcp` | `no` | Also add Playwright MCP? (asked only with `mcpJson`) |
| `vitePlugin` | `yes` | Add the svelte-grab Vite plugin? |
| `skills` | `yes` | Install the svelte-grab agent skills into `.claude/skills/`? |

Skip the prompts:

```bash
npx sv add @svelte-grab="mcpJson:yes+svelteMcp:yes+playwrightMcp:no+vitePlugin:yes+skills:yes"
```

## Development

The add-on logic lives in `src/plan.ts` and reuses the string transforms of the main package (`../../src/cli/transforms.ts`, the same code as `svelte-grab init`). It installs the skills with the same planner as `init` (`../../src/cli/skills-plan.ts`); the skill files are embedded at build time into `src/skills.generated.ts` by `scripts/embed-skills.mjs` (part of `npm run build`), because `sv add` runs before `svelte-grab` is installed and its `skills/` folder cannot be read from `node_modules` yet. A root test fails when the generated file is stale: rerun `node packages/sv-addon/scripts/embed-skills.mjs`. `src/index.ts` only wires it into `defineAddon`. tsdown bundles everything except `sv` (a peer dependency the CLI provides) into `dist/index.mjs`.

Unit tests run from the repo root with a fake `sv` object, no install needed:

```bash
npx vitest run tests/sv-addon.test.ts tests/init-transforms.test.ts
```

Try it against a real project (this folder has its own dependencies; install them here, not in the repo root):

```bash
cd packages/sv-addon
npm install
npm run demo-create            # sv create demo (minimal, TypeScript, no install)
npm run demo-add               # build + sv add file:../ --cwd demo
# or against any project:
npx sv add file:/path/to/svelte-grab/packages/sv-addon --cwd /path/to/app --no-install
```

`sv add file:` imports `dist/index.mjs` in place, so `sv` must resolve from this folder (hence the local `npm install`).

## Publishing

Not published yet. `npm publish` from this folder (`prepublishOnly` builds). Needs the `@svelte-grab` npm scope. The `svelte-grab` dependency range (`^2.0.0`) in `src/plan.ts` must match the released major.
