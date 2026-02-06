#!/usr/bin/env node

import { startMcpServer } from './server.js';
import { DEFAULT_MCP_PORT } from './constants.js';

const args = process.argv.slice(2);

const portArg = args.find((a) => a.startsWith('--port='));
const port = portArg ? parseInt(portArg.split('=')[1], 10) : DEFAULT_MCP_PORT;
const stdio = args.includes('--stdio');

startMcpServer({ port, stdio }).catch((err) => {
	console.error('[svelte-grab mcp] Failed to start:', err.message || err);
	process.exit(1);
});
