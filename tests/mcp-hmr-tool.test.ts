import { describe, it, expect } from 'vitest';
import { CommandChannel, MAX_COMMAND_TIMEOUT_MS, type RuntimeCommandMessage } from '../src/mcp/runtime/command-channel.js';
import { TabRegistry } from '../src/mcp/runtime/tab-registry.js';
import {
	forwardWaitForHmr,
	hmrServerTimeoutMs,
	hmrWaitMs,
	registerWaitForHmrTool,
	DEFAULT_HMR_WAIT_MS,
	MAX_HMR_WAIT_MS
} from '../src/mcp/runtime/hmr-tool.js';
import { registerRuntimeTools, type McpToolConfig, type McpToolHandler } from '../src/mcp/runtime/tools.js';
import { DEFAULT_HMR_TIMEOUT_MS, MAX_HMR_TIMEOUT_MS } from '../src/lib/runtime/hmr.js';

function hello(tabId: string) {
	return { tabId, url: `http://localhost:5173/${tabId}`, title: `Tab ${tabId}`, focused: true };
}

const chain: any = new Proxy(() => chain, { get: () => () => chain, apply: () => chain });
const fakeZ: any = new Proxy({}, { get: () => () => chain });

describe('ui_wait_for_hmr (server)', () => {
	it('uses the same defaults/caps as the page', () => {
		expect(DEFAULT_HMR_WAIT_MS).toBe(DEFAULT_HMR_TIMEOUT_MS);
		expect(MAX_HMR_WAIT_MS).toBe(MAX_HMR_TIMEOUT_MS);
	});

	it('gives the page timeoutMs + 5s, capped at the 60s channel limit', () => {
		expect(hmrWaitMs(undefined)).toBe(15_000);
		expect(hmrServerTimeoutMs(undefined)).toBe(20_000);
		expect(hmrServerTimeoutMs(1_000)).toBe(6_000);
		expect(hmrServerTimeoutMs(55_000)).toBe(MAX_COMMAND_TIMEOUT_MS);
		expect(hmrServerTimeoutMs(999_999)).toBe(MAX_COMMAND_TIMEOUT_MS);
		expect(hmrServerTimeoutMs('x')).toBe(20_000);
	});

	it('forwards files/since/timeoutMs to the target tab and maps the result', async () => {
		const registry = new TabRegistry();
		registry.hello(hello('a'));
		const sent: RuntimeCommandMessage[] = [];
		const channel: CommandChannel = new CommandChannel({
			registry,
			broadcast: (msg) => {
				sent.push(msg);
				queueMicrotask(() =>
					channel.settle({
						id: msg.id,
						tabId: msg.targetTabId,
						ok: true,
						result: { text: 'HMR update applied', data: { status: 'updated', updated: ['/src/Card.svelte'] } }
					})
				);
				return 1;
			}
		});
		const out = await forwardWaitForHmr(channel, { files: ['Card.svelte'], timeoutMs: 2_000, since: 5, tabId: 'a' });
		expect(sent[0]).toMatchObject({
			targetTabId: 'a',
			tool: 'ui_wait_for_hmr',
			args: { files: ['Card.svelte'], timeoutMs: 2_000, since: 5 }
		});
		expect(out).toEqual({
			content: [{ type: 'text', text: 'HMR update applied' }],
			structuredContent: { status: 'updated', updated: ['/src/Card.svelte'] }
		});
	});

	it('maps page errors and missing tabs to tool errors', async () => {
		const registry = new TabRegistry();
		const none = new CommandChannel({ registry, broadcast: () => 1 });
		expect((await forwardWaitForHmr(none, {})).isError).toBe(true);

		registry.hello(hello('a'));
		const channel: CommandChannel = new CommandChannel({
			registry,
			broadcast: (msg) => {
				queueMicrotask(() =>
					channel.settle({ id: msg.id, tabId: msg.targetTabId, ok: false, error: 'No HMR update at all within 1s' })
				);
				return 1;
			}
		});
		expect(await forwardWaitForHmr(channel, { timeoutMs: 1_000 })).toEqual({
			content: [{ type: 'text', text: 'No HMR update at all within 1s' }],
			isError: true
		});
	});

	it('registers with a description telling agents to call it right after an edit', () => {
		const tools = new Map<string, { config: McpToolConfig; handler: McpToolHandler }>();
		const channel = new CommandChannel({ registry: new TabRegistry(), broadcast: () => 1 });
		registerWaitForHmrTool({ registerTool: (name, config, handler) => tools.set(name, { config, handler }) }, fakeZ, {
			channel,
			tabIdHint: 'hint'
		});
		const { config } = tools.get('ui_wait_for_hmr')!;
		expect(config.title).toBeTruthy();
		expect(config.description).toMatch(/^Call right after editing a source file/);
		expect(Object.keys(config.inputSchema!)).toEqual(['files', 'timeoutMs', 'since', 'tabId']);
	});

	it('registerRuntimeTools includes ui_wait_for_hmr', () => {
		const names: string[] = [];
		registerRuntimeTools({ registerTool: (name) => names.push(name) }, fakeZ, {
			registry: new TabRegistry(),
			channel: new CommandChannel({ registry: new TabRegistry(), broadcast: () => 1 })
		});
		expect(names).toContain('ui_wait_for_hmr');
	});
});
