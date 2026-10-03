#!/usr/bin/env node

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { validatePort } from '../utils/port.js';

const args = process.argv.slice(2);
const command = args[0];

const DEFAULT_RELAY_PORT = 4722;
const DEFAULT_MCP_PORT = 4723;

/**
 * Parse a `--port=N` argument into a validated port (integer 1..65535),
 * falling back to the given default with a warning. Returns undefined if no
 * --port arg was supplied so downstream defaults still apply.
 */
function parsePortArg(arg: string | undefined, fallback: number): number | undefined {
	if (!arg) return undefined;
	return validatePort(arg.split('=')[1], fallback);
}

/**
 * Parse the optional bearer-token flag.
 *  --token          -> true (auto-generate a token, printed on startup)
 *  --token=VALUE    -> use VALUE as the token
 * Returns undefined when not supplied (token auth stays disabled unless the
 * SVELTE_GRAB_TOKEN env var enables it).
 */
function parseTokenArg(allArgs: string[]): boolean | string | undefined {
	const withValue = allArgs.find((a) => a.startsWith('--token='));
	if (withValue) return withValue.split('=')[1] || true;
	if (allArgs.includes('--token')) return true;
	return undefined;
}

function getVersion(): string {
	try {
		// Navigate from dist/cli/index.js to package.json
		const __dirname = dirname(fileURLToPath(import.meta.url));
		const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
		return pkg.version || 'unknown';
	} catch {
		return 'unknown';
	}
}

async function main() {
	if (args.includes('--version') || args.includes('-v')) {
		console.log(`svelte-grab v${getVersion()}`);
		return;
	}

	switch (command) {
		case 'init': {
			const { init, parseInitArgs } = await import('./init.js');
			const result = init(undefined, parseInitArgs(args));
			if (!result.ok) process.exitCode = 1;
			break;
		}

		case 'relay': {
			const { startRelay } = await import('./relay.js');
			const portArg = args.find((a: string) => a.startsWith('--port='));
			const providerArg = args.find((a: string) => a.startsWith('--provider='));
			await startRelay({
				port: parsePortArg(portArg, DEFAULT_RELAY_PORT),
				provider: providerArg ? providerArg.split('=')[1] : undefined,
				token: parseTokenArg(args)
			});
			break;
		}

		case 'add': {
			const { add } = await import('./add.js');
			const provider = args[1];
			const dryRun = args.includes('--dry-run');
			const portArg = args.find((a: string) => a.startsWith('--port='));
			add(provider, { dryRun, port: parsePortArg(portArg, DEFAULT_RELAY_PORT) });
			break;
		}

		case 'remove': {
			const { remove } = await import('./remove.js');
			const provider = args[1];
			const dryRun = args.includes('--dry-run');
			remove(provider, { dryRun });
			break;
		}

		case 'configure':
		case 'config': {
			const { configure } = await import('./configure.js');
			const dryRun = args.includes('--dry-run');
			await configure({ dryRun });
			break;
		}

		case 'mcp': {
			const { startMcpServer } = await import('../mcp/server.js');
			const mcpPortArg = args.find((a: string) => a.startsWith('--port='));
			const mcpPort = parsePortArg(mcpPortArg, DEFAULT_MCP_PORT);
			const stdio = args.includes('--stdio');
			const { cdpArgFromArgv } = await import('../mcp/cdp/client.js');
			await startMcpServer({ port: mcpPort, stdio, token: parseTokenArg(args), cdp: cdpArgFromArgv(args) });
			break;
		}

		case 'audit': {
			const { runAuditCli } = await import('./audit/cli.js');
			process.exitCode = runAuditCli(args.slice(1));
			break;
		}

		case 'help':
		case '--help':
		case '-h':
		default:
			console.log(`
svelte-grab v${getVersion()} - Dev tools for Svelte 5 + LLM coding agents

Usage:
  svelte-grab <command> [options]

Commands:
  init      Set up svelte-grab for coding agents in a Svelte project:
            - writes/merges .mcp.json (svelte-grab MCP server + official Svelte
              MCP; existing entries are never replaced)
            - adds svelteGrab() from svelte-grab/vite to vite.config.(ts|js)
            - injects <SvelteDevKit /> into src/routes/+layout.svelte (SvelteKit)
              or src/App.svelte (Vite+Svelte), with enableMcp when .mcp.json
              declares the svelte-grab server
            Options:
              --dry-run               Show what would be changed without writing files
              --no-mcp-json           Do not touch .mcp.json (and no enableMcp)
              --no-svelte-mcp         Skip the @sveltejs/mcp entry (alias:
                                      --with-svelte-mcp=false; default on)
              --with-playwright-mcp   Also add the @playwright/mcp entry (default off)
              --no-vite-plugin        Do not edit vite.config

  add       Add an agent provider (claude-code, cursor, copilot, codex).
            Options:
              --dry-run     Preview changes without writing
              --port=N      Custom relay port for this provider

  remove    Remove an agent provider from configuration.
            Options:
              --dry-run     Preview changes without writing

  configure Interactive configuration (activation key, editor, ports, theme).
            Options:
              --dry-run     Preview changes without writing

  relay     Start the WebSocket relay server that bridges browser selections
            to coding agents (e.g. Claude Code). Your app connects via
            <SvelteGrab enableAgentRelay />.
            Binds to 127.0.0.1 only and validates the browser Origin.
            Options:
              --port=4722           Server port (default: 4722)
              --provider=claude-code  Agent provider (default: claude-code)
              --token[=VALUE]       Require a bearer token (auto-generated if no
                                    VALUE). Also via SVELTE_GRAB_TOKEN env var.

  mcp       Start the MCP server for direct agent integration. Browser sends
            context via HTTP POST, agents read it via MCP protocol.
            In stdio mode, also starts a sidecar HTTP server for browser context.
            Binds to 127.0.0.1 only and validates the browser Origin.
            Options:
              --port=4723   HTTP server port (default: 4723)
              --stdio       Use stdio transport instead of HTTP (for Claude Code
                            MCP config: "command": "npx svelte-grab-mcp --stdio")
              --token[=VALUE]  Require a bearer token (auto-generated if no
                            VALUE). Also via SVELTE_GRAB_TOKEN env var.
              --cdp=URL     Opt-in CDP mode for ui_perf_metrics / ui_leak_check,
                            e.g. --cdp=http://127.0.0.1:9222 (Chrome started with
                            --remote-debugging-port). Loopback only. Also via
                            SVELTE_GRAB_CDP env var.

  audit     Static security scan of a Svelte/SvelteKit project (zero config).
            Run "svelte-grab audit --help" for options (--json, --html, --ci).

  help      Show this help message

Global Options:
  --version, -v   Print version number

Agent loop (recommended):
  1. npx svelte-grab init   (writes .mcp.json, vite plugin, <SvelteDevKit enableMcp />)
  2. Start your dev server and open the app
  3. Your agent runs: ui_snapshot -> ui_find -> ui_inspect -> edit
                      -> ui_wait_for_hmr -> ui_verify
  Human handoff: say "use watch_for_grab to listen for my selections", then
  Alt+Click an element, type your prompt and hit Cmd+Enter.

  The relay (svelte-grab relay / add / remove) is in maintenance mode: still
  supported, new integrations should use MCP.

Examples:
  npx svelte-grab init                     # Add to your SvelteKit project
  npx svelte-grab init --dry-run           # Preview changes without writing
  npx svelte-grab init --with-playwright-mcp  # Also add Playwright MCP to .mcp.json
  npx svelte-grab add cursor               # Add Cursor agent provider
  npx svelte-grab remove copilot           # Remove Copilot provider
  npx svelte-grab configure                # Interactive configuration
  npx svelte-grab relay                    # Start relay on default port
  npx svelte-grab relay --provider=cursor  # Start relay with Cursor provider
  npx svelte-grab mcp --stdio              # Start MCP server for Claude Code
`);
			break;
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
