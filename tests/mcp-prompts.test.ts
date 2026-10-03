import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { createServer, type AddressInfo } from 'node:net';
import {
	markdownSection,
	PERFORMANCE_CHECKLIST_HEADING,
	PROMPT_NAMES,
	registerSkillPrompts,
	SECURITY_CHECKLIST_HEADING,
	type McpPromptServer
} from '../src/mcp/prompts.js';
import type { ZodNamespace } from '../src/mcp/runtime/tools.js';
import { startMcpServer } from '../src/mcp/server.js';

type PromptText = { messages: { role: string; content: { type: string; text?: string } }[] };
const textOf = (result: PromptText) => {
	expect(result.messages).toHaveLength(1);
	expect(result.messages[0].role).toBe('user');
	expect(result.messages[0].content.type).toBe('text');
	return result.messages[0].content.text ?? '';
};

async function inMemoryClient(): Promise<Client> {
	const server = new McpServer({ name: 'svelte-grab', version: 'test' });
	registerSkillPrompts(server as unknown as McpPromptServer, z as unknown as ZodNamespace);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: 'test', version: '1.0.0' });
	await client.connect(clientTransport);
	return client;
}

describe('MCP prompts (in-memory, real SDK client)', () => {
	let client: Client;

	beforeAll(async () => {
		client = await inMemoryClient();
	});

	afterAll(async () => {
		await client.close();
	});

	it('lists the three prompts with their arguments', async () => {
		const { prompts } = await client.listPrompts();
		expect(prompts.map((p) => p.name)).toEqual([...PROMPT_NAMES]);
		const byName = Object.fromEntries(prompts.map((p) => [p.name, p]));
		expect(byName['security-audit'].arguments?.map((a) => [a.name, a.required ?? false])).toEqual([
			['screen', false],
			['url', false]
		]);
		expect(byName['performance-audit'].arguments?.map((a) => a.name)).toEqual(['screen']);
		expect(byName['svelte-grab-loop'].arguments ?? []).toEqual([]);
	});

	it('security-audit inlines the audit workflow and the security checklist', async () => {
		const text = textOf(
			await client.getPrompt({ name: 'security-audit', arguments: { screen: '/settings' } })
		);
		expect(text).toContain('security audit of the screen "/settings"');
		expect(text).toContain('## Phase 1: Recon');
		expect(text).toContain(`## ${SECURITY_CHECKLIST_HEADING}`);
		expect(text).toContain('| S1 |');
		expect(text).not.toContain(`## ${PERFORMANCE_CHECKLIST_HEADING}`);
		expect(text).not.toMatch(/^---\nname:/m);
	});

	it('security-audit without arguments targets the app', async () => {
		const text = textOf(await client.getPrompt({ name: 'security-audit', arguments: {} }));
		expect(text).toContain('security audit of the app');
	});

	it('performance-audit inlines the performance checklist', async () => {
		const text = textOf(
			await client.getPrompt({ name: 'performance-audit', arguments: { screen: 'home' } })
		);
		expect(text).toContain('performance audit of the screen "home"');
		expect(text).toContain(`## ${PERFORMANCE_CHECKLIST_HEADING}`);
		expect(text).toContain('| P1 |');
		expect(text).toContain('ui_leak_check');
		expect(text).not.toContain(`## ${SECURITY_CHECKLIST_HEADING}`);
	});

	it('svelte-grab-loop inlines the core skill', async () => {
		const text = textOf(await client.getPrompt({ name: 'svelte-grab-loop' }));
		expect(text).toContain('## The loop');
		expect(text).toContain('ui_wait_for_hmr');
		expect(text).toContain('[data-sg-ref="e12"]');
	});
});

describe('markdownSection', () => {
	it('returns a ## section up to the next # / ## heading', () => {
		const md = '# T\n\n## A (x)\na\n### sub\nb\n## B\nc\n';
		expect(markdownSection(md, 'A')).toBe('## A (x)\na\n### sub\nb');
		expect(markdownSection(md, 'B')).toBe('## B\nc');
		expect(markdownSection(md, 'C')).toBeNull();
	});
});

describe('MCP prompts on the real HTTP server', () => {
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

	it('serves prompts/list and prompts/get over /mcp', async () => {
		const client = new Client({ name: 'test', version: '1.0.0' });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
		);
		try {
			expect(client.getServerCapabilities()?.prompts).toBeDefined();
			const { prompts } = await client.listPrompts();
			expect(prompts.map((p) => p.name)).toEqual([...PROMPT_NAMES]);
			const text = textOf(
				await client.getPrompt({
					name: 'security-audit',
					arguments: { url: 'http://localhost:5173/' }
				})
			);
			expect(text).toContain('http://localhost:5173/');
			expect(text).toContain(`## ${SECURITY_CHECKLIST_HEADING}`);
			// Tools still served next to the prompts.
			const { tools } = await client.listTools();
			expect(tools.map((t) => t.name)).toContain('ui_security_scan');
		} finally {
			await client.close();
		}
	});
});
