import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { createServer, type AddressInfo } from 'node:net';
import { MCP_INSTRUCTIONS } from '../src/mcp/instructions.js';
import {
	createSvelteGrabMcpServer,
	startMcpServer,
	type SvelteGrabMcpServerConstructor
} from '../src/mcp/server.js';
import { PROMPT_NAMES, type McpPromptServer } from '../src/mcp/prompts.js';
import type { McpToolServer, ZodNamespace } from '../src/mcp/runtime/tools.js';

/** Tool names mentioned in a text (same pattern as the skills content test). */
const mentionedTools = (text: string) => [
	...new Set([...text.matchAll(/\b((?:ui|get|watch|undo|list)_[a-z_]+)\b/g)].map((m) => m[1]))
];

/** A real SDK client connected in memory to the server both transports build. */
async function inMemoryClient(): Promise<Client> {
	const server = createSvelteGrabMcpServer(
		McpServer as unknown as SvelteGrabMcpServerConstructor<
			McpToolServer & McpPromptServer & McpServer
		>,
		z as unknown as ZodNamespace
	);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: 'test', version: '1.0.0' });
	await client.connect(clientTransport);
	return client;
}

describe('MCP_INSTRUCTIONS content', () => {
	it('fits Claude Code (2048 chars) and leads with a self-contained first 512 chars (Codex)', () => {
		expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(2048);
		const lead = MCP_INSTRUCTIONS.split('\n\n')[0];
		expect(lead.length).toBeLessThanOrEqual(512);
		// The lead alone says what it is, the loop and the precondition.
		for (const word of [
			'svelte-grab',
			'ui_snapshot',
			'ui_find',
			'ui_inspect',
			'ui_component_impact',
			'ui_wait_for_hmr',
			'ui_verify',
			'ui_profile',
			'enableMcp',
			'ui_tabs'
		]) {
			expect(lead).toContain(word);
		}
	});

	it('covers refs, annotations, audits and secrets', () => {
		for (const text of [
			'[data-sg-ref="eN"]',
			'ui_annotations',
			'watch_for_grab',
			'ui_network',
			'ui_security_scan',
			'npx svelte-grab audit',
			'redacted'
		]) {
			expect(MCP_INSTRUCTIONS).toContain(text);
		}
	});

	it('names only prompts the server registers', () => {
		for (const prompt of PROMPT_NAMES) expect(MCP_INSTRUCTIONS).toContain(prompt);
	});
});

describe('MCP instructions (in-memory, real SDK client)', () => {
	let client: Client;

	beforeAll(async () => {
		client = await inMemoryClient();
	});

	afterAll(async () => {
		await client.close();
	});

	it('the initialize result carries the instructions', () => {
		expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS);
	});

	it('every tool name the instructions mention is registered', async () => {
		const { tools } = await client.listTools();
		const registered = new Set(tools.map((t) => t.name));
		const mentioned = mentionedTools(MCP_INSTRUCTIONS);
		expect(mentioned.length).toBeGreaterThan(10);
		for (const name of mentioned) {
			expect(registered.has(name), `instructions mention unknown tool ${name}`).toBe(true);
		}
	});
});

describe('MCP instructions on the real HTTP server', () => {
	let port: number;
	let close: () => void;

	beforeAll(async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const probe = createServer();
		await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
		const free = (probe.address() as AddressInfo).port;
		await new Promise<void>((r) => probe.close(() => r()));
		const started = await startMcpServer({ port: free });
		if (!started) throw new Error('server did not start');
		port = started.port;
		close = started.close;
	});

	afterAll(() => {
		close?.();
		vi.restoreAllMocks();
	});

	it('sends the instructions over /mcp', async () => {
		const client = new Client({ name: 'test', version: '1.0.0' });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
		);
		try {
			expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS);
		} finally {
			await client.close();
		}
	});
});
