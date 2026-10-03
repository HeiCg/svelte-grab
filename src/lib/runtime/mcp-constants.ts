/**
 * Browser copy of the MCP server constants the page needs.
 *
 * Source of truth: `src/mcp/constants.ts`. src/lib cannot import from src/mcp
 * (svelte-package only ships src/lib, and that module belongs to the Node
 * build), so the values are duplicated here. `tests/mcp-constants.test.ts`
 * fails when the two copies drift apart.
 */

export const DEFAULT_MCP_PORT = 4723;
export const HEALTH_CHECK_TIMEOUT_MS = 1000;

/** `service` field of the server's `GET /health`. */
export const MCP_SERVICE_ID = 'svelte-grab-mcp';

/** Ports the server tries when the requested one is busy: requested .. requested + size - 1. */
export const MCP_PORT_RANGE_SIZE = 10;
