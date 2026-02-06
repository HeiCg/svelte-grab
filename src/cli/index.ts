#!/usr/bin/env node

const args = process.argv.slice(2);
const command = args[0];

async function main() {
	switch (command) {
		case 'init': {
			const { init } = await import('./init.js');
			init();
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
svelte-grab - Dev tools for Svelte + LLM coding agents

Usage:
  svelte-grab init          Add SvelteGrab to your SvelteKit layout
  svelte-grab relay         Start the agent relay server
  svelte-grab mcp           Start the MCP server
  svelte-grab help          Show this help message

Options:
  relay --port=4722         Set relay server port (default: 4722)
  relay --provider=claude-code  Set agent provider (default: claude-code)
  mcp --port=4723           Set MCP server port (default: 4723)
  mcp --stdio               Use stdio transport (for direct Claude Code integration)
`);
			break;
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
