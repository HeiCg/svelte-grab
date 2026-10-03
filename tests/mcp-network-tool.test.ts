import { describe, it, expect } from 'vitest';
import {
	CommandChannel,
	NO_TAB_MESSAGE,
	type RuntimeCommandMessage
} from '../src/mcp/runtime/command-channel.js';
import { TabRegistry } from '../src/mcp/runtime/tab-registry.js';
import {
	DEFAULT_NETWORK_WAIT_MS,
	MAX_NETWORK_WAIT_MS,
	UI_NETWORK_TYPES,
	networkServerTimeoutMs,
	registerNetworkTool,
	runUiNetwork
} from '../src/mcp/runtime/network-tool.js';
import {
	SECURITY_SCAN_TIMEOUT_MS,
	UI_SECURITY_CHECKS,
	forwardSecurityScan,
	registerSecurityScanTool
} from '../src/mcp/runtime/security-tool.js';
import {
	registerRuntimeTools,
	type McpToolConfig,
	type McpToolHandler
} from '../src/mcp/runtime/tools.js';
import * as pageNetwork from '../src/lib/runtime/network.js';
import * as pageScan from '../src/lib/runtime/security-scan.js';

function hello(tabId: string, focused = true) {
	return { tabId, url: `http://localhost:5173/${tabId}`, title: `Tab ${tabId}`, focused };
}

const chain: any = new Proxy(() => chain, { get: () => () => chain, apply: () => chain });
const fakeZ: any = new Proxy({}, { get: () => () => chain });

type PageHandler = (
	msg: RuntimeCommandMessage
) =>
	| { ok: true; result: { text: string; data?: Record<string, unknown> } }
	| { ok: false; error: string }
	| null;

/** A channel whose "page" answers with `handler` (null = never answers). */
function fakePage(registry: TabRegistry, handler: PageHandler) {
	const sent: RuntimeCommandMessage[] = [];
	const timeouts: (number | undefined)[] = [];
	const channel: CommandChannel = new CommandChannel({
		registry,
		broadcast: (msg) => {
			sent.push(msg);
			queueMicrotask(() => {
				const outcome = handler(msg);
				if (!outcome) return;
				channel.settle(
					outcome.ok
						? { id: msg.id, tabId: msg.targetTabId, ok: true, result: outcome.result }
						: { id: msg.id, tabId: msg.targetTabId, ok: false, error: outcome.error }
				);
			});
			return 1;
		}
	});
	const send = channel.send.bind(channel);
	channel.send = (tool, args, opts) => {
		timeouts.push(opts?.timeoutMs);
		return send(tool, args, opts);
	};
	return { channel, sent, timeouts };
}

/** Virtual clock: sleep advances it instantly. */
function clock() {
	let t = 1_000_000;
	const sleeps: number[] = [];
	return {
		now: () => t,
		sleep: async (ms: number) => {
			sleeps.push(ms);
			t += ms;
			await new Promise((r) => setTimeout(r, 0));
		},
		sleeps
	};
}

describe('ui_network (server)', () => {
	it('shares types and wait limits with the page', () => {
		expect(UI_NETWORK_TYPES).toEqual(pageNetwork.NETWORK_TYPES);
		expect(DEFAULT_NETWORK_WAIT_MS).toBe(pageNetwork.DEFAULT_NETWORK_WAIT_MS);
		expect(MAX_NETWORK_WAIT_MS).toBe(pageNetwork.MAX_NETWORK_WAIT_MS);
		expect(UI_SECURITY_CHECKS).toEqual(pageScan.SECURITY_CHECKS);
	});

	it('without reload: forwards (tabId stripped) with waitMs + 10s timeout', async () => {
		const registry = new TabRegistry();
		registry.hello(hello('a'));
		const { channel, sent, timeouts } = fakePage(registry, () => ({
			ok: true,
			result: { text: 'NETWORK 3 requests', data: { totals: { count: 3 } } }
		}));
		const out = await runUiNetwork(
			{ channel, registry },
			{ waitMs: 1_500, filter: { origin: 'third-party' }, tabId: 'a' }
		);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			tool: 'ui_network',
			targetTabId: 'a',
			args: { waitMs: 1_500, filter: { origin: 'third-party' } }
		});
		expect(sent[0].args).not.toHaveProperty('tabId');
		expect(timeouts).toEqual([11_500]);
		expect(out).toEqual({
			content: [{ type: 'text', text: 'NETWORK 3 requests' }],
			structuredContent: { totals: { count: 3 } }
		});
		expect(networkServerTimeoutMs(999_999)).toBe(40_000);
	});

	it('reload: ui_network_reload -> wait for the re-hello -> waitMs -> ui_network since navigation', async () => {
		const registry = new TabRegistry();
		registry.hello(hello('a'));
		registry.hello(hello('b', false));
		const c = clock();
		const { channel, sent } = fakePage(registry, (msg) => {
			if (msg.tool === 'ui_network_reload') {
				// The page answers, reloads, and the new page says hello again (same tab id).
				setTimeout(() => registry.hello(hello('a')), 0);
				return {
					ok: true,
					result: { text: 'reloading', data: { reloading: true, timeOrigin: 5_000 } }
				};
			}
			return { ok: true, result: { text: 'NETWORK 42 requests', data: { totals: { count: 42 } } } };
		});
		const out = await runUiNetwork(
			{ channel, registry, sleep: c.sleep, now: c.now },
			{ reload: true, includeBodies: true, filter: { type: ['fetch'] } }
		);
		expect(out.isError).toBeUndefined();
		expect(sent.map((m) => [m.tool, m.targetTabId])).toEqual([
			['ui_network_reload', 'a'],
			['ui_network', 'a']
		]);
		expect(sent[0].args).toEqual({ includeBodies: true });
		expect(sent[1].args).toEqual({
			includeBodies: true,
			filter: { type: ['fetch'] },
			since: 'navigation',
			waitMs: 0,
			afterTimeOrigin: 5_000
		});
		expect(c.sleeps).toContain(DEFAULT_NETWORK_WAIT_MS);
		expect(out.content[0].text).toMatch(
			/^# reloaded tab a: reconnected after \d+ms, then waited 2000ms\nNETWORK 42 requests$/
		);
		expect(out.structuredContent).toMatchObject({
			totals: { count: 42 },
			reloaded: true,
			waitedMs: 2_000
		});
	});

	it('reload: retries while the old page answers "page has not reloaded yet"', async () => {
		const registry = new TabRegistry();
		registry.hello(hello('a'));
		const c = clock();
		let reports = 0;
		const { channel, sent } = fakePage(registry, (msg) => {
			if (msg.tool === 'ui_network_reload') {
				registry.hello(hello('a')); // e.g. a heartbeat of the old page right before unload
				return { ok: true, result: { text: 'reloading', data: { timeOrigin: 5_000 } } };
			}
			reports++;
			return reports < 3
				? { ok: false, error: 'page has not reloaded yet' }
				: { ok: true, result: { text: 'NETWORK fresh' } };
		});
		const out = await runUiNetwork(
			{ channel, registry, sleep: c.sleep, now: c.now },
			{ reload: true, waitMs: 0 }
		);
		expect(out.content[0].text).toMatch(/NETWORK fresh$/);
		expect(sent.filter((m) => m.tool === 'ui_network')).toHaveLength(3);
	});

	it('reload: fails clearly when the tab never reconnects', async () => {
		const registry = new TabRegistry({ now: () => Date.now() });
		registry.hello(hello('a'));
		const c = clock();
		const { channel } = fakePage(registry, () => ({
			ok: true,
			result: { text: 'reloading', data: { timeOrigin: 1 } }
		}));
		const out = await runUiNetwork(
			{ channel, registry, sleep: c.sleep, now: c.now, reconnectTimeoutMs: 1_000 },
			{ reload: true }
		);
		expect(out.isError).toBe(true);
		expect(out.content[0].text).toMatch(/^Tab a did not reconnect within 1s after the reload/);
	});

	it('reload: no tab / unknown tab / page error on the reload command', async () => {
		const empty = new TabRegistry();
		const none = fakePage(empty, () => null).channel;
		expect(await runUiNetwork({ channel: none, registry: empty }, { reload: true })).toEqual({
			content: [{ type: 'text', text: NO_TAB_MESSAGE }],
			isError: true
		});

		const registry = new TabRegistry();
		registry.hello(hello('a'));
		const { channel } = fakePage(registry, () => ({ ok: false, error: 'Unknown tool' }));
		expect(
			(await runUiNetwork({ channel, registry }, { reload: true, tabId: 'zzz' })).content[0].text
		).toMatch(/"zzz" is not connected/);
		expect((await runUiNetwork({ channel, registry }, { reload: true })).content[0].text).toBe(
			'ui_network reload failed: Unknown tool'
		);
	});

	it('registers ui_network and ui_security_scan with their schemas', () => {
		const tools = new Map<string, { config: McpToolConfig; handler: McpToolHandler }>();
		const registry = new TabRegistry();
		const channel = new CommandChannel({ registry, broadcast: () => 1 });
		const server = {
			registerTool: (name: string, config: McpToolConfig, handler: McpToolHandler) =>
				tools.set(name, { config, handler })
		};
		registerNetworkTool(server, fakeZ, { channel, registry, tabIdHint: 'hint' });
		registerSecurityScanTool(server, fakeZ, { channel, tabIdHint: 'hint' });
		expect(Object.keys(tools.get('ui_network')!.config.inputSchema!)).toEqual([
			'reload',
			'waitMs',
			'since',
			'filter',
			'includeBodies',
			'tabId'
		]);
		expect(tools.get('ui_network')!.config.description).toMatch(/What does this screen load\?/);
		expect(tools.get('ui_network')!.config.description).toContain('kind:abcd…(len N, sha xxxxxx)');
		expect(Object.keys(tools.get('ui_security_scan')!.config.inputSchema!)).toEqual([
			'checks',
			'tabId'
		]);
		expect(tools.get('ui_security_scan')!.config.description).toMatch(/grouped by severity/);

		const names: string[] = [];
		registerRuntimeTools({ registerTool: (name) => names.push(name) }, fakeZ, {
			registry,
			channel
		});
		expect(names).toEqual(expect.arrayContaining(['ui_network', 'ui_security_scan']));
	});
});

describe('ui_security_scan (server)', () => {
	it('forwards checks with its own timeout and maps errors', async () => {
		const registry = new TabRegistry();
		registry.hello(hello('a'));
		const { channel, sent, timeouts } = fakePage(registry, () => ({
			ok: true,
			result: { text: 'SECURITY no findings', data: { counts: {} } }
		}));
		const out = await forwardSecurityScan(channel, { checks: ['storage'], tabId: 'a' });
		expect(sent[0]).toMatchObject({ tool: 'ui_security_scan', args: { checks: ['storage'] } });
		expect(timeouts).toEqual([SECURITY_SCAN_TIMEOUT_MS]);
		expect(out.content[0].text).toBe('SECURITY no findings');

		const failing = fakePage(registry, () => ({ ok: false, error: 'Unknown check "x"' }));
		expect(await forwardSecurityScan(failing.channel, { checks: ['x'] })).toEqual({
			content: [{ type: 'text', text: 'Unknown check "x"' }],
			isError: true
		});
	});
});
