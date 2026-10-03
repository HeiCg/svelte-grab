#!/usr/bin/env node

import { startMcpServer } from './server.js';
import { DEFAULT_MCP_PORT } from './constants.js';
import { validatePort } from '../utils/port.js';

const args = process.argv.slice(2);

const portArg = args.find((a) => a.startsWith('--port='));
// Validate the port (integer 1..65535); fall back to default with a warning.
const port = portArg ? validatePort(portArg.split('=')[1], DEFAULT_MCP_PORT) : DEFAULT_MCP_PORT;
const stdio = args.includes('--stdio');

// Optional bearer token: --token (auto-generate) or --token=VALUE.
// SVELTE_GRAB_TOKEN env var also enables it. Origin checks are always on.
const tokenArg = args.find((a) => a.startsWith('--token='));
const token: boolean | string | undefined = tokenArg
	? tokenArg.split('=')[1] || true
	: args.includes('--token')
		? true
		: undefined;

startMcpServer({ port, stdio, token }).catch((err) => {
	console.error('[svelte-grab mcp] Failed to start:', err.message || err);
	process.exit(1);
});
