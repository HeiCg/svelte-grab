// Plain values only (no Node imports) so browser code can mirror them.
// src/lib cannot import from here (svelte-package only ships src/lib), so the
// page keeps its own copy of these numbers.

export const DEFAULT_MCP_PORT = 4723;
export const HEALTH_CHECK_TIMEOUT_MS = 1000;

/** `service` field of `GET /health`, used to tell this server apart from anything else on the port. */
export const MCP_SERVICE_ID = 'svelte-grab-mcp';

/**
 * Number of ports the server tries, starting at the requested one, when it is
 * busy. With the default port the server ends up somewhere in 4723-4732.
 * The page probes `GET /health` across the same range and uses the first port
 * whose `service` is MCP_SERVICE_ID (src/lib/runtime/server-probe.ts).
 *
 * The page's copy of these values is src/lib/runtime/mcp-constants.ts;
 * tests/mcp-constants.test.ts keeps the two in sync.
 */
export const MCP_PORT_RANGE_SIZE = 10;

/** Last port of the default fallback range (4732). */
export const MCP_PORT_RANGE_END = DEFAULT_MCP_PORT + MCP_PORT_RANGE_SIZE - 1;
