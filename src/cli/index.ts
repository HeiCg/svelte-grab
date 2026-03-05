#!/usr/bin/env node

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const args = process.argv.slice(2);
const command = args[0];

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
				port: portArg ? parseInt(portArg.split('=')[1], 10) : undefined,
				provider: providerArg ? providerArg.split('=')[1] : undefined
			});
			break;
		}

		case 'mcp': {
			const { startMcpServer } = await import('../mcp/server.js');
			const mcpPortArg = args.find((a: string) => a.startsWith('--port='));
			const mcpPort = mcpPortArg ? parseInt(mcpPortArg.split('=')[1], 10) : undefined;
			const stdio = args.includes('--stdio');
			await startMcpServer({ port: mcpPort, stdio });
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

  relay     Start the WebSocket relay server that bridges browser selections
            to coding agents (e.g. Claude Code). Your app connects via
            <SvelteGrab enableAgentRelay />.
            Options:
              --port=4722           Server port (default: 4722)
              --provider=claude-code  Agent provider (default: claude-code)

  mcp       Start the MCP server for direct agent integration. Browser sends
            context via HTTP POST, agents read it via MCP protocol.
            Options:
              --port=4723   HTTP server port (default: 4723)
              --stdio       Use stdio transport instead of HTTP (for Claude Code
                            MCP config: "command": "npx svelte-grab-mcp --stdio")

  help      Show this help message

Global Options:
  --version, -v   Print version number

Examples:
  npx svelte-grab init                     # Add to your SvelteKit project
  npx svelte-grab init --dry-run           # Preview changes without writing
  npx svelte-grab relay                    # Start relay on default port
  npx svelte-grab relay --port=5000        # Start relay on custom port
  npx svelte-grab mcp --stdio              # Start MCP server for Claude Code
`);
			break;
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
