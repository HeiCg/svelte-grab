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
			const { init } = await import('./init.js');
			const dryRun = args.includes('--dry-run');
			init(undefined, { dryRun });
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
			await startMcpServer({ port: mcpPort, stdio, token: parseTokenArg(args) });
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
  init      Detect your Svelte project and add SvelteDevKit to the root layout.
            Works with SvelteKit (auto-injects into +layout.svelte) and plain
            Vite+Svelte projects (injects into src/App.svelte).
            Options:
              --dry-run     Show what would be changed without writing files

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

  help      Show this help message

Global Options:
  --version, -v   Print version number

Claude Code Integration (recommended):
  1. Add MCP server to Claude Code settings (~/.claude.json):
     { "mcpServers": { "svelte-grab": { "command": "npx", "args": ["svelte-grab-mcp", "--stdio"] } } }
  2. Add <SvelteDevKit enableMcp /> to your root layout
  3. In Claude Code, say: "use watch_for_grab to listen for my selections"
  4. Alt+Click any element in the browser, type your prompt, hit Cmd+Enter
  5. Claude Code receives the component context + your instruction and acts on it

Examples:
  npx svelte-grab init                     # Add to your SvelteKit project
  npx svelte-grab init --dry-run           # Preview changes without writing
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
