import { describe, it, expect } from 'vitest';
import {
	CommandChannel,
	MAX_COMMAND_TIMEOUT_MS,
	NO_TAB_MESSAGE,
	type RuntimeCommandMessage
} from '../src/mcp/runtime/command-channel.js';
import { TabRegistry } from '../src/mcp/runtime/tab-registry.js';
import {
	assessLeak,
	computeDeltas,
	formatMetricsTable,
	leakIterations,
	readActions,
	registerCdpTools,
	runActionsTimeoutMs,
	settleMs,
	uiLeakCheck,
	uiPerfMetrics,
	type CdpToolDeps
} from '../src/mcp/runtime/cdp-tools.js';
import {
	registerRuntimeTools,
	type McpToolConfig,
	type McpToolHandler
} from '../src/mcp/runtime/tools.js';
import type { CdpSessionLike, CdpTarget } from '../src/mcp/cdp/client.js';
import type { RuntimeResultData } from '../src/mcp/runtime/validate.js';

const chain: any = new Proxy(() => chain, { get: () => () => chain, apply: () => chain });
const fakeZ: any = new Proxy({}, { get: () => () => chain });

const TAB_URL = 'http://localhost:5173/?mcp=1';
const TARGET: CdpTarget = {
	id: 'T1',
	type: 'page',
	url: TAB_URL,
	webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/T1'
};

interface Counters {
	nodes: number;
	listeners: number;
	heap: number;
	layouts?: number;
	script?: number;
}

/** Fake CDP session: answers the counters from a queue, logs every method. */
function fakeSession(snapshots: Counters[]) {
	const calls: string[] = [];
	let reads = 0;
	let closed = false;
	let current = snapshots[0];
	const session: CdpSessionLike = {
		async send<T>(method: string): Promise<T> {
			calls.push(method);
			if (method === 'Memory.getDOMCounters') {
				current = snapshots[Math.min(reads++, snapshots.length - 1)];
				return { documents: 2, nodes: current.nodes, jsEventListeners: current.listeners } as T;
			}
			if (method === 'Performance.getMetrics') {
				return {
					metrics: [
						{ name: 'Timestamp', value: 1 },
						{ name: 'JSHeapUsedSize', value: current.heap },
						{ name: 'LayoutCount', value: current.layouts ?? 0 },
						{ name: 'RecalcStyleCount', value: 0 },
						{ name: 'ScriptDuration', value: current.script ?? 0 },
						{ name: 'TaskDuration', value: 0.5 }
					]
				} as T;
			}
			return {} as T;
		},
		close() {
			closed = true;
		}
	};
	return { session, calls, isClosed: () => closed };
}

type PageHandler = (tool: string, args: Record<string, unknown>) => RuntimeResultData | Error;

/** Registry with one tab + a channel whose page answers through `handler`. */
function setup(handler: PageHandler) {
	const registry = new TabRegistry();
	registry.hello({ tabId: 'tab1', url: TAB_URL, title: 'App', focused: true });
	const sent: { msg: RuntimeCommandMessage; timeoutMs?: number }[] = [];
	const channel: CommandChannel = new CommandChannel({
		registry,
		broadcast: (msg) => {
			queueMicrotask(() => {
				const out = handler(msg.tool, msg.args);
				if (out instanceof Error)
					channel.settle({ id: msg.id, tabId: msg.targetTabId, ok: false, error: out.message });
				else channel.settle({ id: msg.id, tabId: msg.targetTabId, ok: true, result: out });
			});
			return 1;
		}
	});
	const send = channel.send.bind(channel);
	channel.send = (tool, args, opts) => {
		sent[sent.length] = {
			msg: { id: '', targetTabId: opts?.tabId ?? '', tool, args },
			timeoutMs: opts?.timeoutMs
		};
		return send(tool, args, opts);
	};
	return { registry, channel, sent };
}

const ACTIONS = [
	{ ref: 'e1', type: 'click' },
	{ ref: 'e2', type: 'click' }
];

function leakyPage(retainedGroups: unknown[], tracked = 30): PageHandler {
	return (tool, args) => {
		if (tool === 'ui_leak_track_start') return { text: 'started', data: { tracking: true } };
		if (tool === 'ui_run_actions') {
			const n = (args.actions as unknown[]).length * Number(args.iterations);
			return { text: `Ran ...: ${n} actions performed`, data: { performed: n } };
		}
		if (tool === 'ui_leak_track_report') {
			const retained = (retainedGroups as { count: number }[]).reduce((s, g) => s + g.count, 0);
			return {
				text: 'report',
				data: { tracked, retained, groups: retainedGroups, truncated: false }
			};
		}
		return new Error('Unknown tool');
	};
}

function deps(base: ReturnType<typeof setup>, extra: Partial<CdpToolDeps> = {}): CdpToolDeps {
	return {
		registry: base.registry,
		channel: base.channel,
		cdp: () => null,
		tabIdHint: 'hint',
		sleep: async () => {},
		...extra
	};
}

describe('helpers', () => {
	it('clamps waitMs, iterations and the page timeout', () => {
		expect(settleMs(undefined)).toBe(300);
		expect(settleMs(-5)).toBe(0);
		expect(settleMs(99_999)).toBe(5_000);
		expect(leakIterations(undefined)).toBe(5);
		expect(leakIterations(0)).toBe(1);
		expect(leakIterations(50)).toBe(20);
		expect(runActionsTimeoutMs(2, 5, 300)).toBe(5 * (2 * 250 + 250 + 300) + 10_000);
		expect(runActionsTimeoutMs(0, 5, 300)).toBe(250 + 300 + 10_000);
		expect(runActionsTimeoutMs(10, 20, 5_000)).toBe(MAX_COMMAND_TIMEOUT_MS);
	});

	it('reads actions from actions[] or action, validating the shape', () => {
		expect(readActions({ actions: ACTIONS }, { required: true })).toEqual(ACTIONS);
		expect(
			readActions(
				{ action: { ref: 'e3', type: 'input', value: 'x', extra: 1 } },
				{ required: true }
			)
		).toEqual([{ ref: 'e3', type: 'input', value: 'x' }]);
		expect(readActions({}, { required: false })).toEqual([]);
		expect(() => readActions({}, { required: true })).toThrow(
			'Pass action { ref, type } or actions [...]'
		);
		expect(() => readActions({ actions: [{ ref: 1 }] }, { required: true })).toThrow(
			'actions[0] must be'
		);
		expect(() => readActions({ actions: 'x' }, { required: true })).toThrow(
			'"actions" must be an array'
		);
	});

	it('computes deltas (durations in ms) and marks changed rows', () => {
		const rows = computeDeltas(
			{
				Nodes: 10,
				JSEventListeners: 1,
				Documents: 2,
				JSHeapUsedSize: 2048,
				LayoutCount: 0,
				RecalcStyleCount: 0,
				ScriptDuration: 1,
				TaskDuration: 2
			},
			{
				Nodes: 16,
				JSEventListeners: 1,
				Documents: 2,
				JSHeapUsedSize: 4096,
				LayoutCount: 1,
				RecalcStyleCount: 0,
				ScriptDuration: 1.26,
				TaskDuration: 2
			}
		);
		expect(rows.find((r) => r.name === 'Nodes')).toEqual({
			name: 'Nodes',
			unit: 'count',
			before: 10,
			after: 16,
			delta: 6
		});
		expect(rows.find((r) => r.name === 'ScriptDuration')!.delta).toBe(0.3);
		const table = formatMetricsTable(rows);
		expect(table[0]).toMatch(/^ {2}metric +before +after +delta$/);
		expect(table.find((l) => l.includes('Nodes'))).toMatch(/\+6 \*$/);
		expect(table.find((l) => l.includes('Documents'))).toMatch(/ 0$/);
		expect(table.find((l) => l.includes('JSHeapUsedSize'))).toMatch(
			/2\.0 KB +4\.0 KB +\+2\.0 KB \*$/
		);
	});
});

describe('assessLeak', () => {
	const base = {
		iterations: 5,
		performed: 10,
		tracked: 30,
		groups: [],
		growth: { Nodes: 0, JSEventListeners: 0, JSHeapUsedSize: 0 }
	};

	it('INCONCLUSIVE without a forced GC, even with alive elements', () => {
		expect(
			assessLeak({
				...base,
				forcedGc: false,
				groups: [{ component: 'Modal', source: 'src/Modal.svelte:3', count: 5 }],
				growth: null
			})
		).toEqual({ verdict: 'INCONCLUSIVE', reason: 'no forced GC; enable --cdp', findings: [] });
	});

	it('LEAK SUSPECTED for retained detached elements or listener growth', () => {
		const out = assessLeak({
			...base,
			forcedGc: true,
			groups: [{ component: 'Modal', source: 'src/Modal.svelte:3', count: 40 }]
		});
		expect(out).toEqual({
			verdict: 'LEAK SUSPECTED',
			findings: ['LEAK? Modal src/Modal.svelte:3 retains 40 detached nodes (~8/iteration)']
		});
		const listeners = assessLeak({
			...base,
			forcedGc: true,
			growth: { Nodes: 0, JSEventListeners: 5, JSHeapUsedSize: 0 }
		});
		expect(listeners.verdict).toBe('LEAK SUSPECTED');
		expect(listeners.findings[0]).toMatch(
			/^LEAK\? \+5 JS event listeners after GC \(~1\/iteration\)/
		);
		// Fewer listeners than iterations: noise, not a per-iteration leak.
		expect(
			assessLeak({
				...base,
				forcedGc: true,
				growth: { Nodes: 0, JSEventListeners: 2, JSHeapUsedSize: 0 }
			}).verdict
		).toBe('NO LEAK DETECTED');
	});

	it('INCONCLUSIVE when nothing was performed or nothing unmounted; else NO LEAK DETECTED', () => {
		expect(assessLeak({ ...base, forcedGc: true, performed: 0 })).toMatchObject({
			verdict: 'INCONCLUSIVE',
			reason: 'no action could be performed'
		});
		expect(assessLeak({ ...base, forcedGc: true, tracked: 0 })).toMatchObject({
			verdict: 'INCONCLUSIVE',
			reason: 'the actions did not unmount any Svelte element'
		});
		expect(assessLeak({ ...base, forcedGc: true })).toEqual({
			verdict: 'NO LEAK DETECTED',
			findings: []
		});
	});
});

describe('ui_leak_check', () => {
	it('with CDP: GC x2 -> baseline -> track_start -> run -> GC x2 -> report -> counters, LEAK SUSPECTED', async () => {
		const base = setup(
			leakyPage([
				{ component: 'LeakyFixture', source: 'src/LeakyFixture.svelte:23', count: 30, roots: 5 }
			])
		);
		const cdp = fakeSession([
			{ nodes: 900, listeners: 70, heap: 6_000_000 },
			{ nodes: 980, listeners: 75, heap: 6_200_000 }
		]);
		const out = await uiLeakCheck(
			deps(base, {
				cdp: () => ({ httpUrl: 'http://127.0.0.1:9222' }),
				connect: async (_config, tab) => {
					expect(tab).toEqual({ url: TAB_URL, title: 'App' });
					return { session: cdp.session, target: TARGET, ambiguous: false };
				}
			}),
			{ actions: ACTIONS, iterations: 5 }
		);
		expect(out.isError).toBeUndefined();
		expect(base.sent.map((s) => s.msg.tool)).toEqual([
			'ui_leak_track_start',
			'ui_run_actions',
			'ui_leak_track_report'
		]);
		expect(base.sent.every((s) => s.msg.targetTabId === 'tab1')).toBe(true);
		expect(base.sent[1].msg.args).toEqual({ actions: ACTIONS, iterations: 5, waitMs: 300 });
		expect(base.sent[1].timeoutMs).toBe(runActionsTimeoutMs(2, 5, 300));
		expect(cdp.calls).toEqual([
			'Performance.enable',
			'HeapProfiler.collectGarbage',
			'HeapProfiler.collectGarbage',
			'Memory.getDOMCounters',
			'Performance.getMetrics',
			'HeapProfiler.collectGarbage',
			'HeapProfiler.collectGarbage',
			'Memory.getDOMCounters',
			'Performance.getMetrics'
		]);
		expect(cdp.isClosed()).toBe(true);

		const lines = out.content[0].text.split('\n');
		expect(lines[0]).toBe(
			'LEAK SUSPECTED: 5 iterations of [click e1 -> click e2], forced GC via CDP'
		);
		expect(lines[1]).toBe(
			'LEAK? LeakyFixture src/LeakyFixture.svelte:23 retains 30 detached nodes (~6/iteration)'
		);
		expect(lines[2]).toMatch(/^LEAK\? \+5 JS event listeners after GC \(~1\/iteration\)/);
		expect(lines).toContain('COUNTERS after forced GC (baseline -> after, growth per iteration):');
		expect(out.content[0].text).toMatch(/Nodes +900 -> 980 +\+80 \(~16\/iteration\)/);
		expect(out.content[0].text).toContain(
			'PAGE TRACKING: 30 Svelte elements removed during the run, 30 still alive and detached after GC'
		);
		expect(out.structuredContent).toMatchObject({
			verdict: 'LEAK SUSPECTED',
			forcedGc: true,
			iterations: 5,
			performed: 10,
			tracked: 30,
			retained: 30,
			counters: { growth: { Nodes: 80, JSEventListeners: 5, JSHeapUsedSize: 200_000 } },
			target: { id: 'T1', url: TAB_URL },
			tabId: 'tab1'
		});
	});

	it('with CDP and nothing retained: NO LEAK DETECTED', async () => {
		const base = setup(leakyPage([]));
		const cdp = fakeSession([
			{ nodes: 900, listeners: 70, heap: 6_000_000 },
			{ nodes: 905, listeners: 70, heap: 6_010_000 }
		]);
		const out = await uiLeakCheck(
			deps(base, {
				cdp: () => ({ httpUrl: 'http://127.0.0.1:9222' }),
				connect: async () => ({ session: cdp.session, target: TARGET, ambiguous: false })
			}),
			{ action: { ref: 'e1', type: 'click' }, iterations: 3 }
		);
		expect(out.content[0].text.split('\n')[0]).toBe(
			'NO LEAK DETECTED: 3 iterations of [click e1], forced GC via CDP'
		);
		expect(out.content[0].text).not.toMatch(/^LEAK\?/m);
	});

	it('without CDP: page tracking only, INCONCLUSIVE with candidates and how to enable', async () => {
		const base = setup(
			leakyPage(
				[{ component: 'LeakyFixture', source: 'src/LeakyFixture.svelte:23', count: 18, roots: 3 }],
				18
			)
		);
		const out = await uiLeakCheck(deps(base), { actions: ACTIONS, iterations: 3 });
		expect(base.sent.map((s) => s.msg.tool)).toEqual([
			'ui_leak_track_start',
			'ui_run_actions',
			'ui_leak_track_report'
		]);
		const text = out.content[0].text;
		expect(text.split('\n')[0]).toBe(
			'INCONCLUSIVE (no forced GC; enable --cdp): 3 iterations of [click e1 -> click e2]'
		);
		expect(text).toContain(
			'CANDIDATES (unconfirmed without a forced GC):\n  LeakyFixture src/LeakyFixture.svelte:23 18 detached nodes in 3 subtrees'
		);
		expect(text).toContain('--cdp=http://127.0.0.1:9222');
		expect(text).not.toContain('COUNTERS');
		expect(out.structuredContent).toMatchObject({
			verdict: 'INCONCLUSIVE',
			reason: 'no forced GC; enable --cdp',
			forcedGc: false,
			counters: null
		});
	});

	it('CDP configured but unreachable: falls back to the page-only run with a note', async () => {
		const base = setup(leakyPage([]));
		const out = await uiLeakCheck(
			deps(base, {
				cdp: () => ({ httpUrl: 'http://127.0.0.1:9222' }),
				connect: async () => {
					throw new Error('Could not reach Chrome DevTools');
				}
			}),
			{ actions: ACTIONS }
		);
		expect(out.content[0].text.split('\n')[0]).toMatch(
			/^INCONCLUSIVE \(no forced GC; enable --cdp\)/
		);
		expect(out.content[0].text).toContain(
			'note: CDP unavailable, ran without a forced GC: Could not reach Chrome DevTools'
		);
	});

	it('errors: no tab, no actions; a failing run still stops the page tracking', async () => {
		const empty = new TabRegistry();
		const noTab = await uiLeakCheck(
			{
				registry: empty,
				channel: new CommandChannel({ registry: empty, broadcast: () => 1 }),
				cdp: () => null,
				tabIdHint: ''
			},
			{ actions: ACTIONS }
		);
		expect(noTab).toEqual({ content: [{ type: 'text', text: NO_TAB_MESSAGE }], isError: true });

		const base = setup(leakyPage([]));
		expect((await uiLeakCheck(deps(base), {})).isError).toBe(true);
		expect(
			(await uiLeakCheck(deps(base), { actions: ACTIONS, tabId: 'nope' })).content[0].text
		).toContain('Browser tab "nope" is not connected');

		const tools: string[] = [];
		const failing = setup((tool) => {
			tools.push(tool);
			if (tool === 'ui_run_actions') return new Error('Unknown ref "e1" in actions[0]');
			return { text: 'ok', data: {} };
		});
		const out = await uiLeakCheck(deps(failing), { actions: ACTIONS });
		expect(out).toEqual({
			content: [{ type: 'text', text: 'ui_leak_check: Unknown ref "e1" in actions[0]' }],
			isError: true
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(tools).toEqual(['ui_leak_track_start', 'ui_run_actions', 'ui_leak_track_report']);
	});
});

describe('ui_perf_metrics', () => {
	it('without CDP: an error explaining how to enable it', async () => {
		const base = setup(leakyPage([]));
		const out = await uiPerfMetrics(deps(base), {});
		expect(out.isError).toBe(true);
		expect(out.content[0].text).toMatch(
			/^ui_perf_metrics needs CDP mode, which is off \(the default\)\./
		);
		expect(out.content[0].text).toContain('--remote-debugging-port=9222');
		expect(out.content[0].text).toContain('svelte-grab-mcp --cdp=http://127.0.0.1:9222');
		expect(out.content[0].text).toContain('never expose it');
		expect(base.sent).toEqual([]);
	});

	it('reads counters before/after the action and reports deltas', async () => {
		const base = setup((tool, args) => ({
			text: 'ran',
			data: { performed: (args.actions as unknown[]).length }
		}));
		const cdp = fakeSession([
			{ nodes: 100, listeners: 5, heap: 1_000_000, layouts: 3, script: 0.01 },
			{ nodes: 124, listeners: 6, heap: 1_030_000, layouts: 4, script: 0.0115 }
		]);
		const out = await uiPerfMetrics(
			deps(base, {
				cdp: () => ({ httpUrl: 'http://127.0.0.1:9222' }),
				connect: async () => ({ session: cdp.session, target: TARGET, ambiguous: true })
			}),
			{ ref: 'e7', waitMs: 100, tabId: 'tab1' }
		);
		expect(out.isError).toBeUndefined();
		expect(base.sent.map((s) => [s.msg.tool, s.msg.args])).toEqual([
			['ui_run_actions', { actions: [{ ref: 'e7', type: 'click' }], iterations: 1, waitMs: 100 }]
		]);
		expect(cdp.calls).toEqual([
			'Performance.enable',
			'Memory.getDOMCounters',
			'Performance.getMetrics',
			'Memory.getDOMCounters',
			'Performance.getMetrics'
		]);
		expect(cdp.isClosed()).toBe(true);
		const lines = out.content[0].text.split('\n');
		expect(lines[0]).toBe(
			'PERF click e7 (isTrusted=false): Nodes +24, JSEventListeners +1, JSHeapUsedSize +29.3 KB, LayoutCount +1, ScriptDuration +1.5ms'
		);
		expect(lines[1]).toBe(
			`ui_perf_metrics via CDP (${TAB_URL}), settled 2 frames + 100ms after the action`
		);
		expect(out.content[0].text).toContain(
			`note: several Chrome tabs show ${TAB_URL}; measured the first match`
		);
		const metrics = (out.structuredContent as { metrics: { name: string; delta: number }[] })
			.metrics;
		expect(metrics.map((m) => [m.name, m.delta])).toEqual([
			['Nodes', 24],
			['JSEventListeners', 1],
			['Documents', 0],
			['JSHeapUsedSize', 30_000],
			['LayoutCount', 1],
			['RecalcStyleCount', 0],
			['ScriptDuration', 1.5],
			['TaskDuration', 0]
		]);
	});

	it('maps connection and page failures to tool errors and closes the session', async () => {
		const base = setup(() => new Error('Unknown ref "e9" in actions[0]'));
		const failConnect = await uiPerfMetrics(
			deps(base, {
				cdp: () => ({ httpUrl: 'http://127.0.0.1:9222' }),
				connect: async () => {
					throw new Error('No Chrome page target');
				}
			}),
			{}
		);
		expect(failConnect).toEqual({
			content: [{ type: 'text', text: 'ui_perf_metrics: No Chrome page target' }],
			isError: true
		});

		const cdp = fakeSession([{ nodes: 1, listeners: 1, heap: 1 }]);
		const failPage = await uiPerfMetrics(
			deps(base, {
				cdp: () => ({ httpUrl: 'http://127.0.0.1:9222' }),
				connect: async () => ({ session: cdp.session, target: TARGET, ambiguous: false })
			}),
			{ action: { ref: 'e9', type: 'click' } }
		);
		expect(failPage.content[0].text).toBe('ui_perf_metrics: Unknown ref "e9" in actions[0]');
		expect(cdp.isClosed()).toBe(true);
	});
});

describe('registration', () => {
	it('registers ui_perf_metrics and ui_leak_check with their inputs', () => {
		const tools = new Map<string, { config: McpToolConfig; handler: McpToolHandler }>();
		const base = setup(leakyPage([]));
		registerCdpTools(
			{ registerTool: (name, config, handler) => tools.set(name, { config, handler }) },
			fakeZ,
			deps(base)
		);
		expect([...tools.keys()]).toEqual(['ui_perf_metrics', 'ui_leak_check']);
		expect(Object.keys(tools.get('ui_perf_metrics')!.config.inputSchema!)).toEqual([
			'action',
			'ref',
			'waitMs',
			'tabId'
		]);
		expect(Object.keys(tools.get('ui_leak_check')!.config.inputSchema!)).toEqual([
			'actions',
			'action',
			'iterations',
			'waitMs',
			'tabId'
		]);
		expect(tools.get('ui_perf_metrics')!.config.description).toContain(
			'--cdp=http://127.0.0.1:9222'
		);
		expect(tools.get('ui_leak_check')!.config.description).toContain(
			'LEAK SUSPECTED, NO LEAK DETECTED or INCONCLUSIVE'
		);
	});

	it('registerRuntimeTools includes both, with CDP off unless configured', async () => {
		const tools = new Map<string, McpToolHandler>();
		const registry = new TabRegistry();
		registerRuntimeTools(
			{ registerTool: (name, _config, handler) => tools.set(name, handler) },
			fakeZ,
			{
				registry,
				channel: new CommandChannel({ registry, broadcast: () => 1 })
			}
		);
		expect([...tools.keys()]).toEqual(expect.arrayContaining(['ui_perf_metrics', 'ui_leak_check']));
		const out = (await tools.get('ui_perf_metrics')!({}, undefined)) as {
			isError?: boolean;
			content: { text: string }[];
		};
		expect(out.isError).toBe(true);
		expect(out.content[0].text).toContain('needs CDP mode');
	});
});
