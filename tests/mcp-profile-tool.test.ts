import { describe, it, expect } from 'vitest';
import { CommandChannel, MAX_COMMAND_TIMEOUT_MS, type RuntimeCommandMessage } from '../src/mcp/runtime/command-channel.js';
import { TabRegistry } from '../src/mcp/runtime/tab-registry.js';
import {
	forwardProfile,
	profileDurationMs,
	profileServerTimeoutMs,
	registerProfileTool,
	DEFAULT_PROFILE_MS,
	MIN_PROFILE_MS,
	MAX_PROFILE_MS,
	UI_PROFILE_ACTIONS
} from '../src/mcp/runtime/profile-tool.js';
import { registerRuntimeTools, type McpToolConfig, type McpToolHandler } from '../src/mcp/runtime/tools.js';
import * as page from '../src/lib/runtime/profile.js';

function hello(tabId: string) {
	return { tabId, url: `http://localhost:5173/${tabId}`, title: `Tab ${tabId}`, focused: true };
}

const chain: any = new Proxy(() => chain, { get: () => () => chain, apply: () => chain });
const fakeZ: any = new Proxy({}, { get: () => () => chain });

describe('ui_profile (server)', () => {
	it('uses the same window defaults/caps and action types as the page', () => {
		expect(DEFAULT_PROFILE_MS).toBe(page.DEFAULT_PROFILE_MS);
		expect(MIN_PROFILE_MS).toBe(page.MIN_PROFILE_MS);
		expect(MAX_PROFILE_MS).toBe(page.MAX_PROFILE_MS);
		expect(UI_PROFILE_ACTIONS).toEqual(page.PROFILE_ACTION_TYPES);
	});

	it('waits durationMs + 10s, capped at the 60s channel limit', () => {
		expect(profileDurationMs(undefined)).toBe(3_000);
		expect(profileServerTimeoutMs(undefined)).toBe(13_000);
		expect(profileServerTimeoutMs(1_500)).toBe(11_500);
		expect(profileServerTimeoutMs(10)).toBe(10_100);
		expect(profileServerTimeoutMs(30_000)).toBe(40_000);
		expect(profileServerTimeoutMs(999_999)).toBe(40_000);
		expect(profileServerTimeoutMs('x')).toBe(13_000);
		expect(profileServerTimeoutMs(MAX_PROFILE_MS)).toBeLessThanOrEqual(MAX_COMMAND_TIMEOUT_MS);
	});

	it('forwards args (tabId stripped) with the custom timeout and maps the result', async () => {
		const registry = new TabRegistry();
		registry.hello(hello('a'));
		const sent: RuntimeCommandMessage[] = [];
		const timeouts: (number | undefined)[] = [];
		const channel: CommandChannel = new CommandChannel({
			registry,
			broadcast: (msg) => {
				sent.push(msg);
				queueMicrotask(() =>
					channel.settle({
						id: msg.id,
						tabId: msg.targetTabId,
						ok: true,
						result: { text: 'HOT HotFixture 90 mutations in 1.5s (burst x2)', data: { verdict: 'HOT' } }
					})
				);
				return 1;
			}
		});
		const send = channel.send.bind(channel);
		channel.send = (tool, args, opts) => {
			timeouts.push(opts?.timeoutMs);
			return send(tool, args, opts);
		};
		const action = { ref: 'e3', type: 'click', repeat: 2 };
		const out = await forwardProfile(channel, { durationMs: 1_500, action, component: 'HotFixture', tabId: 'a' });
		expect(sent[0]).toMatchObject({
			targetTabId: 'a',
			tool: 'ui_profile',
			args: { durationMs: 1_500, action, component: 'HotFixture' }
		});
		expect(sent[0].args).not.toHaveProperty('tabId');
		expect(timeouts).toEqual([11_500]);
		expect(out).toEqual({
			content: [{ type: 'text', text: 'HOT HotFixture 90 mutations in 1.5s (burst x2)' }],
			structuredContent: { verdict: 'HOT' }
		});
	});

	it('maps page errors and missing tabs to tool errors', async () => {
		const registry = new TabRegistry();
		const none = new CommandChannel({ registry, broadcast: () => 1 });
		expect((await forwardProfile(none, {})).isError).toBe(true);

		registry.hello(hello('a'));
		const channel: CommandChannel = new CommandChannel({
			registry,
			broadcast: (msg) => {
				queueMicrotask(() =>
					channel.settle({ id: msg.id, tabId: msg.targetTabId, ok: false, error: 'Unknown action ref "e9"' })
				);
				return 1;
			}
		});
		expect(await forwardProfile(channel, { action: { ref: 'e9', type: 'click' } })).toEqual({
			content: [{ type: 'text', text: 'Unknown action ref "e9"' }],
			isError: true
		});
	});

	it('registers with a description pointing agents at ui_verify and explaining mutations vs re-renders', () => {
		const tools = new Map<string, { config: McpToolConfig; handler: McpToolHandler }>();
		const channel = new CommandChannel({ registry: new TabRegistry(), broadcast: () => 1 });
		registerProfileTool({ registerTool: (name, config, handler) => tools.set(name, { config, handler }) }, fakeZ, {
			channel,
			tabIdHint: 'hint'
		});
		const { config } = tools.get('ui_profile')!;
		expect(config.title).toBeTruthy();
		expect(config.description).toMatch(/^Use after ui_verify/);
		expect(config.description).toContain('Svelte 5 has no component re-renders');
		expect(Object.keys(config.inputSchema!)).toEqual(['durationMs', 'action', 'component', 'ref', 'tabId']);
	});

	it('registerRuntimeTools includes ui_profile', () => {
		const names: string[] = [];
		registerRuntimeTools({ registerTool: (name) => names.push(name) }, fakeZ, {
			registry: new TabRegistry(),
			channel: new CommandChannel({ registry: new TabRegistry(), broadcast: () => 1 })
		});
		expect(names).toContain('ui_profile');
	});
});
