import type { Page } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { test, expect, gotoPlayground, grab } from './fixtures';
import {
	call,
	connectClient,
	pageTabId,
	startMcpServer,
	stopMcpServer,
	waitForActiveTab,
	type McpServerProcess
} from './mcp-harness';

/**
 * The real agent loop: built MCP server (dist/mcp/cli.js, HTTP mode) <- the
 * playground page (SvelteDevKit with enableMcp) <- a real
 * @modelcontextprotocol/sdk Client over Streamable HTTP, the way a coding
 * agent would call it. The playground origin (http://localhost:<SG_E2E_PORT>,
 * default 5189) passes the server's default localhost allowlist (any port).
 *
 * Serial: each describe shares one server process, and the token describe
 * relies on its first test seeing an empty tab registry.
 */
test.describe.configure({ mode: 'serial' });

const TOKEN = 'agent-loop-e2e-token';

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

async function tabs(client: Client): Promise<TabSummary[]> {
	const res = await call(client, 'ui_tabs');
	return ((res.data?.tabs as TabSummary[] | undefined) ?? []).map(({ tabId, active, url }) => ({
		tabId,
		active,
		url
	}));
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
