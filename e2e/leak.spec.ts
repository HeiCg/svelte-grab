import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { test, expect, gotoPlayground } from './fixtures';
import {
	call,
	connectClient,
	freePort,
	pageTabId,
	startMcpServer,
	stopMcpServer,
	waitForActiveTab,
	type McpServerProcess
} from './mcp-harness';

/**
 * CDP mode (Phase 8b): `ui_leak_check` and `ui_perf_metrics` against the
 * playground's Leaks section (LeakToggle > LeakyFixture / CleanFixture).
 *
 * A dedicated Chromium is launched with --remote-debugging-port (not the
 * shared project browser) and the built MCP server gets `--cdp=` pointing at
 * it. Every test drives that one browser, so this file runs serially and never
 * opens a second Chromium.
 */

test.describe.configure({ mode: 'serial' });

let browser: Browser | undefined;
let cdpPort = 0;

test.beforeAll(async () => {
	cdpPort = await freePort();
	browser = await chromium.launch({ args: [`--remote-debugging-port=${cdpPort}`] });
});

test.afterAll(async () => {
	await browser?.close();
});

interface Session {
	context: BrowserContext;
	page: Page;
	tabId: string;
}

async function openApp(
	client: Client,
	mcpPort: number,
	baseURL: string | undefined
): Promise<Session> {
	const context = await browser!.newContext({ baseURL });
	const page = await context.newPage();
	await gotoPlayground(page, `/?mcp=1&mcpPort=${mcpPort}`);
	const tabId = await pageTabId(page);
	await waitForActiveTab(client, tabId);
	return { context, page, tabId };
}

async function refOf(client: Client, testid: string, tabId: string): Promise<string> {
	const found = await call(client, 'ui_find', { selector: `[data-testid="${testid}"]`, tabId });
	expect(found.isError, found.text).toBe(false);
	return (found.data!.matches as { ref: string }[])[0].ref;
}

async function openClose(client: Client, id: 'leaky' | 'clean', tabId: string) {
	const open = await refOf(client, `fx-${id}-open`, tabId);
	const close = await refOf(client, `fx-${id}-close`, tabId);
	return [
		{ ref: open, type: 'click' },
		{ ref: close, type: 'click' }
	];
}

test.describe('CDP mode (--cdp)', () => {
	let server: McpServerProcess | undefined;
	let client: Client | undefined;
	let session: Session | undefined;

	test.beforeAll(async ({ baseURL }) => {
		server = await startMcpServer({}, [`--cdp=http://127.0.0.1:${cdpPort}`]);
		client = await connectClient(server.port);
		session = await openApp(client, server.port, baseURL);
	});

	test.afterAll(async () => {
		await session?.context.close();
		await client?.close().catch(() => {});
		await stopMcpServer(server);
	});

	test('ui_leak_check on the leaky toggle: LEAK SUSPECTED naming LeakyFixture', async () => {
		const actions = await openClose(client!, 'leaky', session!.tabId);
		const out = await call(client!, 'ui_leak_check', {
			actions,
			iterations: 5,
			tabId: session!.tabId
		});
		console.log(`--- ui_leak_check (leaky) ---\n${out.text}`);
		expect(out.isError, out.text).toBe(false);
		const lines = out.text.split('\n');
		expect(lines[0]).toMatch(
			/^LEAK SUSPECTED: 5 iterations of \[click e\d+ -> click e\d+\], forced GC via CDP$/
		);
		expect(out.text).toMatch(
			/^LEAK\? LeakyFixture src\/components\/fixtures\/LeakyFixture\.svelte:\d+ retains 30 detached nodes \(~6\/iteration\)$/m
		);
		expect(out.text).toMatch(/^LEAK\? \+5 JS event listeners after GC \(~1\/iteration\)/m);
		expect(out.text).not.toMatch(/CleanFixture/);
		const data = out.data!;
		expect(data.verdict).toBe('LEAK SUSPECTED');
		expect(data.forcedGc).toBe(true);
		expect(data.performed).toBe(10);
		// One group: the panel root (5 detached subtrees, one per iteration) with its 6 elements each.
		const groups = data.groups as {
			component: string;
			source: string;
			count: number;
			roots: number;
		}[];
		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({ component: 'LeakyFixture', count: 30, roots: 5 });
		expect(groups[0].source).toMatch(/^src\/components\/fixtures\/LeakyFixture\.svelte:\d+$/);
		expect(
			(data.counters as { growth: Record<string, number> }).growth.JSEventListeners
		).toBeGreaterThanOrEqual(5);
		await expect(session!.page.getByTestId('fx-leaky-panel')).toHaveCount(0);
	});

	test('ui_leak_check on the clean toggle: NO LEAK DETECTED', async () => {
		const actions = await openClose(client!, 'clean', session!.tabId);
		const out = await call(client!, 'ui_leak_check', {
			actions,
			iterations: 5,
			tabId: session!.tabId
		});
		console.log(`--- ui_leak_check (clean) ---\n${out.text}`);
		expect(out.isError, out.text).toBe(false);
		expect(out.text.split('\n')[0]).toMatch(/^NO LEAK DETECTED: 5 iterations of/);
		expect(out.text).not.toMatch(/^LEAK\?/m);
		expect(out.data!.verdict).toBe('NO LEAK DETECTED');
		expect(out.data!.tracked as number).toBeGreaterThan(0);
		expect(out.data!.retained).toBe(0);
	});

	test('ui_perf_metrics with a click returns non-empty deltas', async () => {
		const open = await refOf(client!, 'fx-clean-open', session!.tabId);
		const out = await call(client!, 'ui_perf_metrics', {
			action: { ref: open, type: 'click' },
			tabId: session!.tabId
		});
		console.log(`--- ui_perf_metrics ---\n${out.text}`);
		expect(out.isError, out.text).toBe(false);
		expect(out.text.split('\n')[0]).toMatch(
			new RegExp(`^PERF click ${open} \\(isTrusted=false\\): .*Nodes \\+\\d+`)
		);
		const metrics = out.data!.metrics as { name: string; delta: number }[];
		expect(metrics.map((m) => m.name)).toEqual([
			'Nodes',
			'JSEventListeners',
			'Documents',
			'JSHeapUsedSize',
			'LayoutCount',
			'RecalcStyleCount',
			'ScriptDuration',
			'TaskDuration'
		]);
		expect(metrics.find((m) => m.name === 'Nodes')!.delta).toBeGreaterThan(0);
		await expect(session!.page.getByTestId('fx-clean-panel')).toBeVisible();
		await session!.page.getByTestId('fx-clean-close').click();
	});
});

test.describe('without CDP', () => {
	let server: McpServerProcess | undefined;
	let client: Client | undefined;
	let session: Session | undefined;

	test.beforeAll(async ({ baseURL }) => {
		server = await startMcpServer();
		client = await connectClient(server.port);
		session = await openApp(client, server.port, baseURL);
	});

	test.afterAll(async () => {
		await session?.context.close();
		await client?.close().catch(() => {});
		await stopMcpServer(server);
	});

	test('ui_leak_check runs the page tracking and is INCONCLUSIVE; ui_perf_metrics explains how to enable', async () => {
		const actions = await openClose(client!, 'leaky', session!.tabId);
		const out = await call(client!, 'ui_leak_check', {
			actions,
			iterations: 3,
			tabId: session!.tabId
		});
		console.log(`--- ui_leak_check (no CDP) ---\n${out.text}`);
		expect(out.isError, out.text).toBe(false);
		expect(out.text.split('\n')[0]).toMatch(
			/^INCONCLUSIVE \(no forced GC; enable --cdp\): 3 iterations of/
		);
		expect(out.data!.verdict).toBe('INCONCLUSIVE');
		expect(out.data!.forcedGc).toBe(false);
		expect(out.data!.tracked as number).toBeGreaterThan(0);
		expect(out.text).toContain('--cdp=http://127.0.0.1:9222');

		const perf = await call(client!, 'ui_perf_metrics', { tabId: session!.tabId });
		expect(perf.isError).toBe(true);
		expect(perf.text).toContain('--remote-debugging-port=9222');
		expect(perf.text).toContain('--cdp=http://127.0.0.1:9222');
	});
});
