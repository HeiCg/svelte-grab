import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { test, expect, gotoPlayground } from './fixtures';
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
 * `ui_profile` (Phase 8a) against the playground's HotFixture: its Start
 * button makes the counter update every 16ms (hot) and the QuietTicker
 * sibling once per second (quiet). First through the page handler (loaded
 * from Vite's dev server, like e2e/verify.spec.ts), then once through the
 * built MCP server and a real MCP client.
 */

const fsUrl = (rel: string) => '/@fs' + fileURLToPath(new URL(rel, import.meta.url));
const COMMANDS_URL = fsUrl('../src/lib/runtime/commands.ts');

interface Outcome {
	ok: boolean;
	error?: string;
	result?: { text: string; data?: Record<string, unknown> };
}

interface ProfileComponent {
	name: string;
	mutations: number;
	bursts: number;
	hot: boolean;
	topElements: { ref: string; source: string | null }[];
}

async function callTool(page: Page, tool: string, args: Record<string, unknown>): Promise<Outcome> {
	return page.evaluate(
		async ([url, t, a]) => {
			const mod = await import(/* @vite-ignore */ url as string);
			return mod.dispatchRuntimeCommand(t, a);
		},
		[COMMANDS_URL, tool, args] as const
	);
}

const HOT_LINE = /^HOT HotFixture \d+ mutations in 1\.5s \(burst x\d+\)$/;

/** HotFixture is hot, QuietTicker is listed below it and not hot. */
async function expectHotFixture(page: Page, text: string, data: Record<string, unknown>): Promise<void> {
	const lines = text.split('\n');
	expect(lines[0]).toMatch(HOT_LINE);
	expect(text).not.toMatch(/^HOT QuietTicker/m);
	expect(data.verdict).toBe('HOT');
	expect(data.hot).toEqual(['HotFixture']);

	const components = data.components as ProfileComponent[];
	const hot = components.find((c) => c.name === 'HotFixture')!;
	const quiet = components.find((c) => c.name === 'QuietTicker');
	expect(hot.hot).toBe(true);
	expect(hot.bursts).toBeGreaterThan(0);
	expect(hot.mutations).toBeGreaterThan(40);
	expect(quiet, 'QuietTicker ticked once in the window').toBeDefined();
	expect(quiet!.hot).toBe(false);
	expect(quiet!.bursts).toBe(0);
	expect(quiet!.mutations).toBeLessThan(hot.mutations);
	expect(components.indexOf(quiet!)).toBeGreaterThan(components.indexOf(hot));

	// The most mutated element is the counter, usable as a Playwright locator.
	const top = hot.topElements[0];
	expect(top.source).toMatch(/^src\/components\/fixtures\/HotFixture\.svelte:\d+$/);
	await expect(page.locator(`[data-sg-ref="${top.ref}"]`)).toHaveAttribute('data-testid', 'fx-hot-count');
	expect(text).toMatch(/\n {2}HotFixture \d+ mutations, [\d.]+\/s, \d+ bursts?, \d+ batch(es)? \[characterData \d+.*\] src\/components\/fixtures\/HotFixture\.svelte\n/);
	expect(text).toMatch(/\nFPS avg \d+/);
}

test.describe('agent runtime: ui_profile', () => {
	test('a click on the HotFixture start button makes it HOT; its quiet sibling stays below', async ({
		activated: page
	}) => {
		const found = await callTool(page, 'ui_find', { selector: '[data-testid="fx-hot-toggle"]' });
		expect(found.ok, found.error).toBe(true);
		const ref = (found.result!.data as { matches: { ref: string }[] }).matches[0].ref;

		const out = await callTool(page, 'ui_profile', { durationMs: 1500, action: { ref, type: 'click' } });
		expect(out.ok, out.error).toBe(true);
		const text = out.result!.text;
		console.log(`--- ui_profile ---\n${text}`);
		await expectHotFixture(page, text, out.result!.data!);
		expect(text.split('\n')[1]).toBe(`ui_profile 1.5s, scope: page, action: click ${ref} x1 (isTrusted=false)`);
		expect(out.result!.data!.action).toMatchObject({ ref, type: 'click', performed: 1, isTrusted: false });

		// Still running: scoped to the quiet sibling, nothing is hot.
		await expect(page.getByTestId('fx-hot-toggle')).toContainText('Stop');
		const scoped = await callTool(page, 'ui_profile', { durationMs: 1200, component: 'QuietTicker' });
		expect(scoped.ok, scoped.error).toBe(true);
		console.log(`--- ui_profile (component QuietTicker) ---\n${scoped.result!.text}`);
		expect(scoped.result!.text.split('\n')[0]).toMatch(/^QUIET /);
		expect((scoped.result!.data!.components as ProfileComponent[]).map((c) => c.name)).toEqual(['QuietTicker']);

		await page.getByTestId('fx-hot-toggle').click();
		await expect(page.getByTestId('fx-hot-toggle')).toContainText('Start');
	});
});

test.describe('ui_profile through the real MCP client', () => {
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

	test('ui_find -> ui_profile with a click action reports HotFixture HOT', async ({ page }) => {
		await gotoPlayground(page, `/?mcp=1&mcpPort=${server!.port}`);
		const tabId = await pageTabId(page);
		await waitForActiveTab(client!, tabId);

		const found = await call(client!, 'ui_find', { selector: '[data-testid="fx-hot-toggle"]', tabId });
		expect(found.isError, found.text).toBe(false);
		const ref = (found.data!.matches as { ref: string }[])[0].ref;

		const out = await call(client!, 'ui_profile', { durationMs: 1500, action: { ref, type: 'click' }, tabId });
		expect(out.isError, out.text).toBe(false);
		console.log(`--- ui_profile (MCP) ---\n${out.text}`);
		await expectHotFixture(page, out.text, out.data!);

		await page.getByTestId('fx-hot-toggle').click();
	});
});
