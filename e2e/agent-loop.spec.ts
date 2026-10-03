import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { test, expect, gotoPlayground, grab } from './fixtures';

/**
 * The real agent loop: built MCP server (dist/mcp/cli.js, HTTP mode) <- the
 * playground page (SvelteDevKit with enableMcp) <- a real
 * @modelcontextprotocol/sdk Client over Streamable HTTP, the way a coding
 * agent would call it. The playground origin (http://localhost:5189) passes
 * the server's default localhost allowlist.
 *
 * Serial: each describe shares one server process, and the token describe
 * relies on its first test seeing an empty tab registry.
 */
test.describe.configure({ mode: 'serial' });

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = fileURLToPath(new URL('../dist/mcp/cli.js', import.meta.url));
const TAB_ID_KEY = 'svelte-grab-tab-id';
const TOKEN = 'agent-loop-e2e-token';

interface McpServerProcess {
	proc: ChildProcess;
	port: number;
}

interface TabSummary {
	tabId: string;
	active: boolean;
	url: string;
}

interface Match {
	ref: string;
	component: string | null;
	visible: boolean;
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address() as { port: number };
			srv.close(() => resolve(port));
		});
	});
}

/** Start `node dist/mcp/cli.js --port=<free>`; resolves with the port it really bound. */
async function startMcpServer(env: Record<string, string> = {}): Promise<McpServerProcess> {
	// CI builds on `npm ci` (prepare); locally build the server half if missing.
	if (!existsSync(CLI)) execSync('npm run build:server', { cwd: ROOT, stdio: 'ignore' });

	const requested = await freePort();
	const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
	if (!env.SVELTE_GRAB_TOKEN) delete childEnv.SVELTE_GRAB_TOKEN;
	const proc = spawn(process.execPath, [CLI, `--port=${requested}`], {
		cwd: ROOT,
		env: childEnv,
		stdio: ['ignore', 'pipe', 'pipe']
	});

	const port = await new Promise<number>((resolve, reject) => {
		let out = '';
		const timer = setTimeout(() => reject(new Error(`MCP server did not start:\n${out}`)), 15_000);
		const onData = (chunk: Buffer) => {
			out += chunk.toString();
			const m = out.match(/HTTP server listening on http:\/\/localhost:(\d+)/);
			if (m) {
				clearTimeout(timer);
				resolve(Number(m[1]));
			}
		};
		proc.stdout!.on('data', onData);
		proc.stderr!.on('data', onData);
		proc.once('exit', (code) => {
			clearTimeout(timer);
			reject(new Error(`MCP server exited (${code}):\n${out}`));
		});
	});
	return { proc, port };
}

async function stopMcpServer(server: McpServerProcess | undefined): Promise<void> {
	if (!server || server.proc.exitCode !== null) return;
	const exited = new Promise((resolve) => server.proc.once('exit', resolve));
	server.proc.kill('SIGTERM');
	await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000))]);
	if (server.proc.exitCode === null) server.proc.kill('SIGKILL');
}

async function connectClient(port: number, token?: string): Promise<Client> {
	const client = new Client({ name: 'svelte-grab-agent-loop-e2e', version: '0.0.0' });
	const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
		requestInit: token ? { headers: { 'x-svelte-grab-token': token } } : undefined
	});
	await client.connect(transport);
	return client;
}

interface ToolResult {
	text: string;
	data: Record<string, unknown> | undefined;
	isError: boolean;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
	const res = (await client.callTool({ name, arguments: args })) as {
		content?: { type: string; text?: string }[];
		structuredContent?: Record<string, unknown>;
		isError?: boolean;
	};
	return {
		text: (res.content ?? []).map((c) => c.text ?? '').join('\n'),
		data: res.structuredContent,
		isError: res.isError === true
	};
}

async function tabs(client: Client): Promise<TabSummary[]> {
	const res = await call(client, 'ui_tabs');
	return ((res.data?.tabs as TabSummary[] | undefined) ?? []).map(({ tabId, active, url }) => ({
		tabId,
		active,
		url
	}));
}

/** The page's runtime tab id, once the runtime has started (after the port probe). */
async function pageTabId(page: Page): Promise<string> {
	let id: string | null = null;
	await expect
		.poll(async () => (id = await page.evaluate((k) => sessionStorage.getItem(k), TAB_ID_KEY)), {
			timeout: 10_000
		})
		.not.toBeNull();
	return id!;
}

async function waitForActiveTab(client: Client, tabId: string): Promise<void> {
	await expect
		.poll(() => tabs(client), { timeout: 10_000 })
		.toContainEqual(expect.objectContaining({ tabId, active: true }));
}

/** ui_snapshot -> ui_find -> Playwright locator on the returned ref. */
async function expectSnapshotAndFind(client: Client, page: Page, tabId: string): Promise<void> {
	const snapshot = await call(client, 'ui_snapshot', { scope: 'page', maxNodes: 500, tabId });
	expect(snapshot.isError, snapshot.text).toBe(false);
	expect(snapshot.text).toContain('FixtureCard');

	const found = await call(client, 'ui_find', { component: 'FixtureCard', tabId });
	expect(found.isError, found.text).toBe(false);
	const matches = (found.data?.matches ?? []) as Match[];
	expect(matches).toHaveLength(2);
	for (const m of matches) {
		expect(m.component).toBe('FixtureCard');
		expect(m.ref).toMatch(/^e\d+$/);
	}
	await expect(page.locator(`[data-sg-ref="${matches[0].ref}"]`)).toBeVisible();
	await expect(page.locator(`[data-sg-ref="${matches[1].ref}"]`)).toBeVisible();
}

test.describe('agent loop: real MCP client -> MCP server -> page', () => {
	let server: McpServerProcess | undefined;
	let client: Client | undefined;

	test.beforeAll(async () => {
		server = await startMcpServer();
		client = await connectClient(server.port);
	});

	test.afterAll(async () => {
		await client?.close().catch(() => {});
		await stopMcpServer(server);
	});

	test('ui_tabs, ui_snapshot and ui_find drive the live playground', async ({ page }) => {
		await gotoPlayground(page, `/?mcp=1&mcpPort=${server!.port}`);
		const tabId = await pageTabId(page);

		await waitForActiveTab(client!, tabId);
		const listed = await call(client!, 'ui_tabs');
		expect(listed.text).toContain(tabId);
		expect(listed.text).toMatch(/\[active/);

		await expectSnapshotAndFind(client!, page, tabId);
	});
});

test.describe('agent loop with SVELTE_GRAB_TOKEN', () => {
	let server: McpServerProcess | undefined;
	let client: Client | undefined;

	test.beforeAll(async () => {
		server = await startMcpServer({ SVELTE_GRAB_TOKEN: TOKEN });
		client = await connectClient(server.port, TOKEN);
	});

	test.afterAll(async () => {
		await client?.close().catch(() => {});
		await stopMcpServer(server);
	});

	test('a page without the token never registers', async ({ page }) => {
		const rejected = page.waitForResponse(
			(r) => r.url().startsWith(`http://localhost:${server!.port}/events`) && r.status() === 401,
			{ timeout: 10_000 }
		);
		await gotoPlayground(page, `/?mcp=1&mcpPort=${server!.port}`);
		const tabId = await pageTabId(page);
		await rejected;
		// Give a hello (if one were sent) time to land.
		await page.waitForTimeout(500);

		expect(await tabs(client!)).toEqual([]);
		const listed = await call(client!, 'ui_tabs');
		expect(listed.text).not.toContain(tabId);
		const find = await call(client!, 'ui_find', { component: 'FixtureCard' });
		expect(find.isError).toBe(true);
	});

	test('a page with mcpToken registers, answers and posts grabs', async ({ page }) => {
		await gotoPlayground(page, `/?mcp=1&mcpPort=${server!.port}&mcpToken=${TOKEN}`);
		const tabId = await pageTabId(page);

		await waitForActiveTab(client!, tabId);
		await expectSnapshotAndFind(client!, page, tabId);

		// POST /context carries the token too: an Alt+Click reaches the agent.
		await grab(page, '[data-testid="fx-card-a"]');
		await expect
			.poll(async () => (await call(client!, 'get_element_context')).text, { timeout: 10_000 })
			.toContain('FixtureCard');
	});
});
