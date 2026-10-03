import { readFileSync, writeFileSync } from 'node:fs';
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
 * HMR awareness (Phase 4) against the real playground dev server, which runs
 * the repo's svelte-grab/vite plugin. These tests EDIT playground files on
 * disk, so playwright.config.ts runs this spec in its own project after every
 * other spec (an HMR update would otherwise land in their pages). Every edit is
 * restored in `finally`, and a leftover edit from a crashed run is undone
 * before the first test.
 */
test.describe.configure({ mode: 'serial' });

const fsUrl = (rel: string) => '/@fs' + fileURLToPath(new URL(rel, import.meta.url));
const COMMANDS_URL = fsUrl('../src/lib/runtime/commands.ts');
const REFS_URL = fsUrl('../src/lib/runtime/refs.ts');

const CARD_FILE = fileURLToPath(
	new URL('../examples/playground/src/components/fixtures/FixtureCard.svelte', import.meta.url)
);
const MAIN_FILE = fileURLToPath(new URL('../examples/playground/src/main.ts', import.meta.url));
const PLAYGROUND_ROOT = fileURLToPath(new URL('../examples/playground', import.meta.url));

const EDIT_MARK = ' (hmr-e2e)';
const MAIN_MARK = '\n// hmr-e2e full reload\n';
const CARD_TEXT = '>Card {name}</p>';

/** Undo an edit a crashed run may have left behind. */
function cleanCard(source: string): string {
	return source.split(EDIT_MARK).join('').replace('{#if true}\n', '');
}

const cardOriginal = cleanCard(readFileSync(CARD_FILE, 'utf8'));
const mainOriginal = readFileSync(MAIN_FILE, 'utf8').split(MAIN_MARK).join('');

function restoreAll(): void {
	if (readFileSync(CARD_FILE, 'utf8') !== cardOriginal) writeFileSync(CARD_FILE, cardOriginal);
	if (readFileSync(MAIN_FILE, 'utf8') !== mainOriginal) writeFileSync(MAIN_FILE, mainOriginal);
}

/** Same line, same column: every stable key in the file survives the edit. */
function editCardText(): void {
	expect(cardOriginal).toContain(CARD_TEXT);
	writeFileSync(CARD_FILE, cardOriginal.replace(CARD_TEXT, `>Card {name}${EDIT_MARK}</p>`));
}

test.beforeAll(() => restoreAll());
test.afterAll(() => restoreAll());

interface Outcome {
	ok: boolean;
	error?: string;
	result?: { text: string; data?: Record<string, unknown> };
}

interface Match {
	ref: string;
	stableKey: string;
	component: string | null;
}

interface WaitData {
	status: string;
	updated: string[];
	errors: string[];
	rebound: { from: string; to: string }[];
	lost: string[];
	kept: number;
	consoleErrors: number;
	source: string;
	at: number;
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

async function find(page: Page, args: Record<string, unknown>): Promise<Match[]> {
	const out = await callTool(page, 'ui_find', args);
	expect(out.ok, out.error).toBe(true);
	return (out.result!.data as { matches: Match[] }).matches;
}

/**
 * Start ui_wait_for_hmr in the page without awaiting it. Returns once the
 * command is registered (the handler registers its waiter synchronously).
 */
async function startWait(page: Page, args: Record<string, unknown>): Promise<void> {
	await page.evaluate(
		async ([url, a]) => {
			const mod = await import(/* @vite-ignore */ url as string);
			(window as unknown as { __hmrWait: Promise<unknown> }).__hmrWait = mod.dispatchRuntimeCommand(
				'ui_wait_for_hmr',
				a
			);
		},
		[COMMANDS_URL, args] as const
	);
}

async function finishWait(page: Page): Promise<Outcome> {
	return page.evaluate(() => (window as unknown as { __hmrWait: Promise<Outcome> }).__hmrWait);
}

test.describe('svelte-grab/vite plugin in the playground', () => {
	test('marks the page and serves module-graph importers', async ({ activated: page }) => {
		const marker = await page.evaluate(
			() => (window as unknown as Record<string, unknown>).__SVELTE_GRAB_VITE__
		);
		expect(marker).toMatchObject({
			root: PLAYGROUND_ROOT.replace(/\/$/, ''),
			hmrBridge: true,
			importersEndpoint: '/__svelte-grab/importers'
		});
		expect((marker as { version: string }).version).toMatch(/^\d+\.\d+\.\d+/);

		const res = await page.request.get('/__svelte-grab/importers?file=FixtureCard.svelte');
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({
			found: true,
			matches: ['src/components/fixtures/FixtureCard.svelte']
		});
		expect(body.importers.map((i: { file: string }) => i.file)).toContain('src/App.svelte');

		const cross = await page.request.get('/__svelte-grab/importers?file=FixtureCard.svelte', {
			headers: { Origin: 'http://evil.example' }
		});
		expect(cross.status()).toBe(403);
	});
});

test.describe('ui_wait_for_hmr in the page', () => {
	test('an edit to FixtureCard.svelte resolves with the file and rebinds its refs', async ({
		activated: page
	}) => {
		const cards = await find(page, { component: 'FixtureCard' });
		expect(cards).toHaveLength(2);
		const [heading] = await find(page, { role: 'heading', name: 'Nested chain' });
		const [button] = await find(page, { role: 'button', name: 'a: 0' });

		const bridged: string[] = [];
		await page.exposeFunction('__bridged', (type: string) => bridged.push(type));
		await page.evaluate(() =>
			window.addEventListener('svelte-grab:hmr', (e) =>
				(window as unknown as { __bridged: (t: string) => void }).__bridged(
					(e as CustomEvent).detail.type
				)
			)
		);

		const editedAt = Date.now();
		try {
			await startWait(page, { files: ['FixtureCard.svelte'], timeoutMs: 20_000 });
			editCardText();
			const out = await finishWait(page);
			expect(out.ok, out.error).toBe(true);
			const data = out.result!.data as unknown as WaitData;

			expect(data.status).toBe('updated');
			expect(data.source).toBe('vite-hmr');
			expect(data.updated).toContain('/src/components/fixtures/FixtureCard.svelte');
			expect(data.errors).toEqual([]);
			expect(data.consoleErrors).toBe(0);
			expect(out.result!.text).toContain('HMR update applied (source: vite-hmr)');

			// Both card roots and the button inside were re-created and rebound;
			// the Section heading (another file) was kept.
			const from = data.rebound.map((r) => r.from);
			expect(from).toEqual(expect.arrayContaining([cards[0].ref, cards[1].ref, button.ref]));
			expect(from).not.toContain(heading.ref);
			expect(data.kept).toBeGreaterThanOrEqual(1);
			expect(data.lost).toEqual([]);

			const toA = data.rebound.find((r) => r.from === cards[0].ref)!.to;
			await expect(page.locator(`[data-sg-ref="${toA}"]`)).toHaveAttribute(
				'data-testid',
				'fx-card-a'
			);
			await expect(page.locator(`[data-sg-ref="${toA}"] p`)).toHaveText(`Card a${EDIT_MARK}`);

			// The stale ref still resolves, to the new element.
			const resolved = await page.evaluate(
				async ([url, ref]) => {
					const mod = await import(/* @vite-ignore */ url);
					const r = mod.refRegistry.resolve(ref);
					return r ? { ref: r.ref, rebound: r.rebound === true, previous: r.previous } : null;
				},
				[REFS_URL, cards[0].ref] as const
			);
			expect(resolved).toEqual({ ref: toA, rebound: true, previous: cards[0].ref });

			// The plugin's bridge saw the same update (ignored by the tracker: no double count).
			expect(bridged).toEqual(expect.arrayContaining(['vite:beforeUpdate', 'vite:afterUpdate']));

			// `since` answers from the ring buffer without waiting.
			const again = await callTool(page, 'ui_wait_for_hmr', {
				files: ['src/components/fixtures/FixtureCard.svelte'],
				since: editedAt,
				timeoutMs: 1_000
			});
			expect(again.ok, again.error).toBe(true);
			expect((again.result!.data as unknown as WaitData).updated).toContain(
				'/src/components/fixtures/FixtureCard.svelte'
			);
		} finally {
			restoreAll();
		}
		await expect(page.getByTestId('fx-card-text-a')).toHaveText('Card a');
	});

	test('a compile error resolves with status "error" instead of timing out', async ({
		activated: page
	}) => {
		try {
			await startWait(page, { files: ['FixtureCard.svelte'], timeoutMs: 20_000 });
			// Unclosed {#if}: vite-plugin-svelte fails to compile the file.
			writeFileSync(CARD_FILE, `{#if true}\n${cardOriginal}`);
			const out = await finishWait(page);
			expect(out.ok, out.error).toBe(true);
			const data = out.result!.data as unknown as WaitData;
			expect(data.status).toBe('error');
			expect(data.errors.join('\n')).toMatch(/FixtureCard\.svelte/);
			expect(out.result!.text).toMatch(/^Vite reported an error instead of an update/);
		} finally {
			restoreAll();
		}
		// Fixing the file after an error overlay reloads or updates the page.
		await expect(page.getByTestId('fx-card-text-a')).toHaveText('Card a', { timeout: 15_000 });
	});

	test('times out with a clear message when the file never updates', async ({
		activated: page
	}) => {
		const out = await callTool(page, 'ui_wait_for_hmr', {
			files: ['NotEdited.svelte'],
			timeoutMs: 300
		});
		expect(out.ok).toBe(false);
		expect(out.error).toMatch(
			/^No HMR update touching NotEdited\.svelte within 0\.3s \(source: vite-hmr\)/
		);
	});
});

test.describe('ui_wait_for_hmr through a real MCP client', () => {
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

	test('find -> edit FixtureCard.svelte -> ui_wait_for_hmr returns the file and rebound refs', async ({
		page
	}) => {
		await gotoPlayground(page, `/?mcp=1&mcpPort=${server!.port}`);
		const tabId = await pageTabId(page);
		await waitForActiveTab(client!, tabId);

		const found = await call(client!, 'ui_find', { component: 'FixtureCard', tabId });
		expect(found.isError, found.text).toBe(false);
		const cards = (found.data?.matches ?? []) as Match[];
		expect(cards).toHaveLength(2);

		try {
			// `since` covers an update that lands before the command reaches the page.
			const since = Date.now();
			const waiting = call(client!, 'ui_wait_for_hmr', {
				files: ['FixtureCard.svelte'],
				since,
				timeoutMs: 20_000,
				tabId
			});
			await page.waitForTimeout(200);
			editCardText();
			const out = await waiting;
			expect(out.isError, out.text).toBe(false);
			const data = out.data as unknown as WaitData;
			expect(data.status).toBe('updated');
			expect(data.updated).toContain('/src/components/fixtures/FixtureCard.svelte');
			expect(data.rebound.map((r) => r.from)).toEqual(
				expect.arrayContaining([cards[0].ref, cards[1].ref])
			);
			expect(out.text).toMatch(/Refs: \d+ kept, \d+ rebound/);

			const toB = data.rebound.find((r) => r.from === cards[1].ref)!.to;
			await expect(page.locator(`[data-sg-ref="${toB}"] p`)).toHaveText(`Card b${EDIT_MARK}`);
		} finally {
			restoreAll();
		}
		await expect(page.getByTestId('fx-card-text-b')).toHaveText('Card b');
	});

	test('a full reload is reported before the page goes away', async ({ page }) => {
		await gotoPlayground(page, `/?mcp=1&mcpPort=${server!.port}`);
		const tabId = await pageTabId(page);
		await waitForActiveTab(client!, tabId);

		try {
			const waiting = call(client!, 'ui_wait_for_hmr', {
				files: ['main.ts'],
				timeoutMs: 20_000,
				tabId
			});
			await page.waitForTimeout(200);
			// main.ts has no HMR boundary: Vite fully reloads the page.
			writeFileSync(MAIN_FILE, mainOriginal + MAIN_MARK);
			const out = await waiting;
			expect(out.isError, out.text).toBe(false);
			expect(out.data).toMatchObject({ status: 'full-reload' });
			expect(out.text).toMatch(/^Full page reload/);
		} finally {
			restoreAll();
		}
		await expect(page.getByTestId('app-root')).toBeVisible({ timeout: 15_000 });
	});
});
