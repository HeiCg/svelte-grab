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
import {
	FAKE_API_KEY,
	FAKE_JWT,
	FAKE_STORAGE_KEY,
	FAKE_THIRD_PARTY_URL
} from '../examples/playground/src/components/fixtures/fake-secrets';

/**
 * `ui_network` + `ui_security_scan` (Phase 9a/9b) through the real MCP
 * server and a real MCP client, against the playground's LeakyRequests
 * fixture (fake credentials only). The fake secrets must never appear in any
 * tool output: redaction is mandatory.
 */
test.describe.configure({ mode: 'serial' });

interface Finding {
	id: string;
	check: string;
	severity: string;
	verdict: string;
	title: string;
	evidence: string;
	source?: string;
}

const SECRETS = [FAKE_API_KEY, FAKE_JWT];

function expectRedacted(label: string, ...outputs: unknown[]): void {
	for (const out of outputs) {
		const text = typeof out === 'string' ? out : JSON.stringify(out);
		for (const secret of SECRETS)
			expect(text.includes(secret), `${label} leaked a fake secret`).toBe(false);
		// Not even the bulk of the JWT (its first 4 chars are allowed by design).
		expect(text.includes(FAKE_JWT.slice(0, 40)), `${label} leaked a JWT prefix`).toBe(false);
	}
}

async function mockEndpoints(page: Page): Promise<void> {
	await page.route('**/__fake/api/**', (route) =>
		route.fulfill({ json: { ok: true, items: [1, 2, 3] } })
	);
	await page.route(`${new URL(FAKE_THIRD_PARTY_URL).origin}/**`, (route) =>
		route.fulfill({
			status: route.request().method() === 'OPTIONS' ? 204 : 200,
			headers: {
				'access-control-allow-origin': '*',
				'access-control-allow-methods': 'POST, OPTIONS',
				'access-control-allow-headers': 'authorization, content-type'
			},
			body: ''
		})
	);
}

test.describe('ui_network / ui_security_scan: real MCP client -> server -> page', () => {
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

	test('leaky requests: listed with initiator, flagged by the scan, always redacted', async ({
		page
	}) => {
		await mockEndpoints(page);
		await gotoPlayground(page, `/?mcp=1&mcpPort=${server!.port}`);
		const tabId = await pageTabId(page);
		await waitForActiveTab(client!, tabId);

		const status = page.getByTestId('fx-leaky-status');
		await page.getByTestId('fx-leaky-url').click();
		await expect(status).toHaveText('key-in-url: done');
		await page.getByTestId('fx-leaky-third-party').click();
		await expect(status).toHaveText(/third-party: (done|failed)/);
		await page.getByTestId('fx-leaky-storage').click();
		await expect(status).toHaveText('stored: done');
		expect(await page.evaluate((k) => localStorage.getItem(k), FAKE_STORAGE_KEY)).toBe(FAKE_JWT);
		await page.getByTestId('fx-leaky-duplicates').click();
		await expect(status).toHaveText('duplicates: done');

		const net = await call(client!, 'ui_network', { tabId, filter: { type: ['fetch'] } });
		expect(net.isError, net.text).toBe(false);
		console.log(`--- ui_network ---\n${net.text}`);
		const lines = net.text.split('\n');
		// Per-request lines (REQUESTS section): '  #id METHOD STATUS type ...'.
		const requestLine = (needle: string) =>
			lines.find((l) => /^ {2}#\d+ [A-Z]+ \d+ /.test(l) && l.includes(needle));
		const urlLine = requestLine('/__fake/api/mock?');
		expect(urlLine).toMatch(
			/^ {2}#\d+ GET 200 fetch .* http:\/\/localhost:\d+\/__fake\/api\/mock\?api_key=stripe-secret-key:sk_t…\(len \d+, sha [0-9a-f]{6}\)&page=1 <- src\/components\/fixtures\/LeakyRequests\.svelte:\d+ \(LeakyRequests\)$/
		);
		const thirdLine = requestLine(FAKE_THIRD_PARTY_URL);
		expect(thirdLine).toMatch(
			/POST .*\(third-party\) <- src\/components\/fixtures\/LeakyRequests\.svelte:\d+ \(LeakyRequests\)/
		);
		expect(net.text).toMatch(
			/DUPLICATES 1\n {2}x2 GET http:\/\/localhost:\d+\/__fake\/api\/items <- src\/components\/fixtures\/LeakyRequests\.svelte:\d+ \(LeakyRequests\)/
		);
		expect(net.text).toMatch(/third-party https:\/\/third-party\.example 1 req/);
		const requests = (net.data?.requests ?? []) as {
			url: string;
			initiator: { component: string | null } | null;
		}[];
		expect(
			requests.filter((r) => r.initiator?.component === 'LeakyRequests').length
		).toBeGreaterThanOrEqual(4);
		// svelte-grab's own MCP traffic is never listed.
		expect(net.text).not.toMatch(/\/runtime\/(hello|result)|\/events\b/);
		expectRedacted('ui_network', net.text, net.data);

		const scan = await call(client!, 'ui_security_scan', { tabId });
		expect(scan.isError, scan.text).toBe(false);
		console.log(`--- ui_security_scan ---\n${scan.text}`);
		const findings = (scan.data?.findings ?? []) as Finding[];
		const byRule = (rule: string) =>
			findings.find((f) => f.id.startsWith(`${rule}:`) && f.check !== 'headers');

		const inUrl = byRule('token-in-url');
		expect(inUrl).toMatchObject({
			severity: 'high',
			verdict: 'confirmed',
			title: 'Stripe secret key in URL query parameter "api_key"'
		});
		expect(inUrl!.source).toMatch(
			/^src\/components\/fixtures\/LeakyRequests\.svelte:\d+ \(LeakyRequests\)$/
		);
		expect(inUrl!.evidence).toMatch(/api_key=stripe-secret-key:sk_t…\(len \d+, sha [0-9a-f]{6}\)/);

		const header = byRule('auth-header-third-party');
		expect(header).toMatchObject({
			severity: 'high',
			verdict: 'confirmed',
			title: 'Credential header "authorization" sent to third-party third-party.example'
		});
		expect(header!.evidence).toMatch(
			/authorization: Bearer jwt:eyJh…\(len \d+, sha [0-9a-f]{6}\)$/
		);

		const stored = byRule('jwt-in-storage');
		expect(stored).toMatchObject({
			severity: 'medium',
			verdict: 'confirmed',
			title: `JWT in localStorage "${FAKE_STORAGE_KEY}"`
		});
		expect(stored!.evidence).toMatch(
			new RegExp(
				`^localStorage\\["${FAKE_STORAGE_KEY}"\\] = jwt:eyJh…\\(len \\d+, sha [0-9a-f]{6}\\)$`
			)
		);

		// Same secret -> same sha in both places (the agent can match occurrences).
		const sha = (s: string) => /jwt:eyJh…\(len \d+, sha ([0-9a-f]{6})\)/.exec(s)?.[1];
		expect(sha(header!.evidence)).toBe(sha(stored!.evidence));

		expect(scan.text).toMatch(/^SECURITY [1-9]\d* high, [1-9]\d* medium, \d+ low, \d+ info/);
		expect(scan.text).toMatch(/\nHIGH\n/);
		expectRedacted('ui_security_scan', scan.text, scan.data);
	});

	test('ui_network({ reload: true }) reports the initial page load', async ({ page }) => {
		await mockEndpoints(page);
		await gotoPlayground(page, `/?mcp=1&mcpPort=${server!.port}`);
		const tabId = await pageTabId(page);
		await waitForActiveTab(client!, tabId);
		// A request before the reload must not show up in the report.
		await page.getByTestId('fx-leaky-duplicates').click();
		await expect(page.getByTestId('fx-leaky-status')).toHaveText('duplicates: done');
		const before = await page.evaluate(() => performance.timeOrigin);

		const net = await call(client!, 'ui_network', { tabId, reload: true, waitMs: 1_000 });
		expect(net.isError, net.text).toBe(false);
		console.log(`--- ui_network reload ---\n${net.text.split('\n').slice(0, 25).join('\n')}`);
		expect(await page.evaluate(() => performance.timeOrigin)).toBeGreaterThan(before);
		expect(net.text).toMatch(
			new RegExp(`^# reloaded tab ${tabId}: reconnected after \\d+ms, then waited 1000ms\\n`)
		);
		expect(net.data?.reloaded).toBe(true);

		const requests = (net.data?.requests ?? []) as { type: string; url: string }[];
		const totals = net.data?.totals as { count: number };
		expect(totals.count).toBeGreaterThan(5);
		// The document, Vite's client and the app entry: the initial load.
		expect(requests.find((r) => r.type === 'document')?.url).toMatch(/\/\?mcp=1&mcpPort=\d+$/);
		expect(requests.some((r) => r.type === 'script' && /\/@vite\/client$/.test(r.url))).toBe(true);
		expect(requests.some((r) => /\/src\/main\.ts$/.test(r.url))).toBe(true);
		expect(
			requests.some((r) => /\/src\/components\/fixtures\/LeakyRequests\.svelte/.test(r.url))
		).toBe(true);
		// The pre-reload request is gone.
		expect(requests.some((r) => r.url.includes('/__fake/api/items'))).toBe(false);
	});
});
