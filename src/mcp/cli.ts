#!/usr/bin/env node

import { startMcpServer } from './server.js';
import { DEFAULT_MCP_PORT } from './constants.js';
import { validatePort } from '../utils/port.js';
import { cdpArgFromArgv } from './cdp/client.js';

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

// Opt-in CDP mode: --cdp=<http://127.0.0.1:9222> (or SVELTE_GRAB_CDP). Loopback
// only; an invalid or remote URL makes startMcpServer reject (exit 1).
const cdp = cdpArgFromArgv(args);

startMcpServer({ port, stdio, token, cdp }).catch((err) => {
	console.error('[svelte-grab mcp] Failed to start:', err.message || err);
	process.exit(1);
});
