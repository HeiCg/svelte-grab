import { describe, it, expect } from 'vitest';
import * as server from '../src/mcp/constants.js';
import * as browser from '../src/lib/runtime/mcp-constants.js';

describe('browser copy of the MCP constants', () => {
	it('matches src/mcp/constants.ts', () => {
		expect(browser.DEFAULT_MCP_PORT).toBe(server.DEFAULT_MCP_PORT);
		expect(browser.HEALTH_CHECK_TIMEOUT_MS).toBe(server.HEALTH_CHECK_TIMEOUT_MS);
		expect(browser.MCP_SERVICE_ID).toBe(server.MCP_SERVICE_ID);
		expect(browser.MCP_PORT_RANGE_SIZE).toBe(server.MCP_PORT_RANGE_SIZE);
	});

	it('covers every value the browser copy exports', () => {
		for (const [name, value] of Object.entries(browser)) {
			expect(server, name).toHaveProperty(name, value);
		}
	});
});
