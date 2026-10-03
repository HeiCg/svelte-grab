/**
 * MCP tools of the opt-in CDP mode (docs/agent-runtime-spec.md, Phase 8b):
 * `ui_perf_metrics` and `ui_leak_check`.
 *
 * Both combine the page runtime (actions, WeakRef leak tracking; internal page
 * commands `ui_run_actions`, `ui_leak_track_start`, `ui_leak_track_report`,
 * see src/lib/runtime/leak.ts) with Chrome DevTools Protocol calls on the tab's
 * page target (`Performance.getMetrics`, `Memory.getDOMCounters`,
 * `HeapProfiler.collectGarbage`). The CDP target is the one whose URL matches
 * the runtime tab (`/runtime/hello` url).
 *
 * Without CDP (`--cdp` / `SVELTE_GRAB_CDP` unset): `ui_perf_metrics` returns an
 * error explaining how to enable it; `ui_leak_check` still runs the page-side
 * tracking, without a forced GC, and reports `INCONCLUSIVE`.
 */

import { MAX_COMMAND_TIMEOUT_MS, NO_TAB_MESSAGE, type CommandChannel } from './command-channel.js';
import type { TabEntry, TabRegistry } from './tab-registry.js';
import type { RuntimeResultData } from './validate.js';
import type { McpToolResult, McpToolServer, ZodNamespace } from './tools.js';
import {
	CDP_HOW_TO_ENABLE,
	connectToTab,
	type CdpConfig,
	type CdpSessionLike,
	type CdpTarget
} from '../cdp/client.js';

/** Page command names; must match src/lib/runtime/leak.ts. */
export const LEAK_TRACK_START_TOOL = 'ui_leak_track_start';
export const LEAK_TRACK_REPORT_TOOL = 'ui_leak_track_report';
export const RUN_ACTIONS_TOOL = 'ui_run_actions';

/** Must match src/lib/runtime/leak.ts. */
export const DEFAULT_SETTLE_MS = 300;
export const MAX_SETTLE_MS = 5_000;
export const MAX_RUN_ACTIONS = 10;
export const DEFAULT_LEAK_ITERATIONS = 5;
export const MAX_LEAK_ITERATIONS = 20;
/** Must match PROFILE_ACTION_TYPES in src/lib/runtime/profile.ts. */
export const CDP_ACTION_TYPES = ['click', 'input', 'scroll'] as const;

/** Budget per action (one frame + dispatch) when sizing the page timeout. */
const ACTION_BUDGET_MS = 250;
/** Budget for the 2-frame settle on top of `waitMs`. */
const SETTLE_FRAMES_BUDGET_MS = 250;
const SERVER_GRACE_MS = 10_000;
/** Delay between the two forced GCs. */
const GC_GAP_MS = 100;

export interface CdpToolDeps {
	registry: TabRegistry;
	channel: CommandChannel;
	/** CDP config, read on each call (null: CDP mode off). */
	cdp: () => CdpConfig | null;
	tabIdHint: string;
	/** Test seam: open a CDP session on the tab's page target. */
	connect?: (
		config: CdpConfig,
		tab: { url: string; title?: string }
	) => Promise<{ session: CdpSessionLike; target: CdpTarget; ambiguous: boolean }>;
	sleep?: (ms: number) => Promise<void>;
}

export interface CdpAction {
	ref: string;
	type: string;
	value?: string;
}

/** A metric read before/after. */
export interface MetricDelta extends Record<string, unknown> {
	name: string;
	unit: 'count' | 'bytes' | 'ms';
	before: number;
	after: number;
	delta: number;
}

/** Counters read over CDP, in the order they are reported. */
export const PERF_METRICS: readonly { name: string; unit: MetricDelta['unit'] }[] = [
	{ name: 'Nodes', unit: 'count' },
	{ name: 'JSEventListeners', unit: 'count' },
	{ name: 'Documents', unit: 'count' },
	{ name: 'JSHeapUsedSize', unit: 'bytes' },
	{ name: 'LayoutCount', unit: 'count' },
	{ name: 'RecalcStyleCount', unit: 'count' },
	{ name: 'ScriptDuration', unit: 'ms' },
	{ name: 'TaskDuration', unit: 'ms' }
];

/** Metrics `ui_leak_check` reports growth for. */
const LEAK_METRICS = ['Nodes', 'JSEventListeners', 'JSHeapUsedSize'] as const;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorResult(message: string): McpToolResult {
	return { content: [{ type: 'text', text: message }], isError: true };
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The tab a call targets (explicit `tabId` or the active tab), with the channel's error messages. */
export function resolveTab(registry: TabRegistry, tabId: unknown): TabEntry {
	if (typeof tabId === 'string' && tabId) {
		const tab = registry.get(tabId);
		if (tab) return tab;
		throw new Error(
			registry.size === 0
				? NO_TAB_MESSAGE
				: `Browser tab "${tabId}" is not connected. Call ui_tabs to list connected tabs.`
		);
	}
	const tab = registry.active();
	if (!tab) throw new Error(NO_TAB_MESSAGE);
	return tab;
}

/** Clamp `waitMs` like the page does. */
export function settleMs(waitMs: unknown): number {
	if (typeof waitMs !== 'number' || !Number.isFinite(waitMs)) return DEFAULT_SETTLE_MS;
	return Math.min(MAX_SETTLE_MS, Math.max(0, Math.floor(waitMs)));
}

/** Clamp `iterations` to 1..20 (default 5). */
export function leakIterations(iterations: unknown): number {
	if (typeof iterations !== 'number' || !Number.isFinite(iterations))
		return DEFAULT_LEAK_ITERATIONS;
	return Math.min(MAX_LEAK_ITERATIONS, Math.max(1, Math.floor(iterations)));
}

/** Server timeout for a `ui_run_actions` call, capped at the channel's 60s. */
export function runActionsTimeoutMs(
	actionCount: number,
	iterations: number,
	waitMs: number
): number {
	const runs = actionCount > 0 ? iterations : 1;
	const budget =
		runs * (actionCount * ACTION_BUDGET_MS + SETTLE_FRAMES_BUDGET_MS + waitMs) + SERVER_GRACE_MS;
	return Math.min(MAX_COMMAND_TIMEOUT_MS, budget);
}

function isAction(value: unknown): value is CdpAction {
	return (
		!!value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		typeof (value as CdpAction).ref === 'string' &&
		typeof (value as CdpAction).type === 'string'
	);
}

/** The action list of a call: `actions` (array) or `action` (one), validated for shape. */
export function readActions(
	args: Record<string, unknown>,
	options: { required: boolean }
): CdpAction[] {
	let list: unknown[] = [];
	if (args.actions !== undefined && args.actions !== null) {
		if (!Array.isArray(args.actions))
			throw new Error('"actions" must be an array of { ref, type, value? }');
		list = args.actions;
	} else if (args.action !== undefined && args.action !== null) {
		list = [args.action];
	}
	if (list.length > MAX_RUN_ACTIONS)
		throw new Error(`"actions" takes at most ${MAX_RUN_ACTIONS} actions per iteration`);
	const actions = list.map((a, i) => {
		if (!isAction(a))
			throw new Error(`actions[${i}] must be { ref, type: "click"|"input"|"scroll", value? }`);
		const out: CdpAction = { ref: a.ref, type: a.type };
		if (typeof a.value === 'string') out.value = a.value;
		return out;
	});
	if (options.required && actions.length === 0) {
		throw new Error(
			'Pass action { ref, type } or actions [...] (e.g. open then close a modal): ui_leak_check repeats them to find leaks.'
		);
	}
	return actions;
}

/** Read the counters of {@link PERF_METRICS} (ScriptDuration/TaskDuration in ms). */
export async function readCounters(session: CdpSessionLike): Promise<Record<string, number>> {
	const dom = await session.send<{ documents?: number; nodes?: number; jsEventListeners?: number }>(
		'Memory.getDOMCounters'
	);
	const perf = await session.send<{ metrics?: { name: string; value: number }[] }>(
		'Performance.getMetrics'
	);
	const metrics = new Map((perf.metrics ?? []).map((m) => [m.name, m.value]));
	const read = (name: string) => {
		const v = metrics.get(name);
		return typeof v === 'number' && Number.isFinite(v) ? v : 0;
	};
	return {
		Nodes: dom.nodes ?? read('Nodes'),
		JSEventListeners: dom.jsEventListeners ?? read('JSEventListeners'),
		Documents: dom.documents ?? read('Documents'),
		JSHeapUsedSize: read('JSHeapUsedSize'),
		LayoutCount: read('LayoutCount'),
		RecalcStyleCount: read('RecalcStyleCount'),
		ScriptDuration: read('ScriptDuration') * 1000,
		TaskDuration: read('TaskDuration') * 1000
	};
}

export function computeDeltas(
	before: Record<string, number>,
	after: Record<string, number>
): MetricDelta[] {
	return PERF_METRICS.map(({ name, unit }) => {
		const b = before[name] ?? 0;
		const a = after[name] ?? 0;
		const round = (n: number) => (unit === 'ms' ? Math.round(n * 10) / 10 : Math.round(n));
		return { name, unit, before: round(b), after: round(a), delta: round(a - b) };
	});
}

function formatBytes(n: number): string {
	const abs = Math.abs(n);
	if (abs >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	if (abs >= 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${n} B`;
}

export function formatMetricValue(value: number, unit: MetricDelta['unit']): string {
	if (unit === 'bytes') return formatBytes(value);
	if (unit === 'ms') return `${value.toFixed(1)}ms`;
	return String(value);
}

function signed(value: number, unit: MetricDelta['unit']): string {
	const text = formatMetricValue(value, unit);
	return value > 0 ? `+${text}` : text;
}

/** `metric before after delta` table; changed rows are marked with `*`. */
export function formatMetricsTable(rows: MetricDelta[]): string[] {
	const cells = rows.map((r) => [
		r.name,
		formatMetricValue(r.before, r.unit),
		formatMetricValue(r.after, r.unit),
		signed(r.delta, r.unit)
	]);
	const header = ['metric', 'before', 'after', 'delta'];
	const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
	const line = (c: string[], mark = '') =>
		`  ${c[0].padEnd(widths[0])}  ${c[1].padStart(widths[1])}  ${c[2].padStart(widths[2])}  ${c[3].padStart(widths[3])}${mark}`.trimEnd();
	return [line(header), ...cells.map((c, i) => line(c, rows[i].delta !== 0 ? ' *' : ''))];
}

function describeActions(actions: CdpAction[]): string {
	return actions
		.map((a) => `${a.type} ${a.ref}${a.value !== undefined ? ` "${a.value}"` : ''}`)
		.join(' -> ');
}

async function openSession(deps: CdpToolDeps, config: CdpConfig, tab: TabEntry) {
	const connect = deps.connect ?? ((c, t) => connectToTab(c, t));
	return connect(config, { url: tab.url, title: tab.title });
}

/** `ui_perf_metrics` handler. */
export async function uiPerfMetrics(
	deps: CdpToolDeps,
	rawArgs: Record<string, unknown> | undefined
): Promise<McpToolResult> {
	const args = rawArgs ?? {};
	const config = deps.cdp();
	if (!config) {
		return errorResult(
			'ui_perf_metrics needs CDP mode, which is off (the default). ' +
				CDP_HOW_TO_ENABLE +
				' A CDP port gives full control of that browser: keep it on 127.0.0.1 and never expose it.'
		);
	}
	let tab: TabEntry;
	let actions: CdpAction[];
	try {
		tab = resolveTab(deps.registry, args.tabId);
		actions = readActions(args, { required: false });
		if (actions.length === 0 && typeof args.ref === 'string' && args.ref) {
			actions = [{ ref: args.ref, type: 'click' }];
		}
	} catch (err) {
		return errorResult(messageOf(err));
	}
	const waitMs = settleMs(args.waitMs);

	let conn;
	try {
		conn = await openSession(deps, config, tab);
	} catch (err) {
		return errorResult(`ui_perf_metrics: ${messageOf(err)}`);
	}
	const { session, target } = conn;
	try {
		await session.send('Performance.enable');
		const before = await readCounters(session);
		const run = await deps.channel.send(
			RUN_ACTIONS_TOOL,
			{ actions, iterations: 1, waitMs },
			{ tabId: tab.tabId, timeoutMs: runActionsTimeoutMs(actions.length, 1, waitMs) }
		);
		const after = await readCounters(session);
		const rows = computeDeltas(before, after);
		const performed = Number((run.data as { performed?: unknown } | undefined)?.performed ?? 0);
		const changed = rows.filter((r) => r.delta !== 0);
		const what =
			actions.length > 0 ? `${describeActions(actions)} (isTrusted=false)` : 'idle (no action)';
		const lines = [
			`PERF ${what}: ` +
				(changed.length > 0
					? changed.map((r) => `${r.name} ${signed(r.delta, r.unit)}`).join(', ')
					: 'no counter changed'),
			`ui_perf_metrics via CDP (${target.url}), settled 2 frames + ${waitMs}ms after the action`,
			...formatMetricsTable(rows),
			'* changed. ScriptDuration/TaskDuration are main-thread time spent; LayoutCount/RecalcStyleCount count layouts and style recalcs.'
		];
		if (actions.length > 0 && performed < actions.length) lines.push(`warning: ${run.text}`);
		if (conn.ambiguous)
			lines.push(`note: several Chrome tabs show ${tab.url}; measured the first match`);
		return {
			content: [{ type: 'text', text: lines.join('\n') }],
			structuredContent: {
				metrics: rows,
				actions,
				performed,
				waitMs,
				target: { id: target.id, url: target.url },
				tabId: tab.tabId
			}
		};
	} catch (err) {
		return errorResult(`ui_perf_metrics: ${messageOf(err)}`);
	} finally {
		session.close();
	}
}

/** Retained group as reported by the page (`ui_leak_track_report`). */
export interface LeakGroup {
	component: string | null;
	/** `file:line` of the root of the detached subtree(s). */
	source: string;
	/** Retained elements in those subtrees. */
	count: number;
	/** Detached subtrees rooted there (e.g. one per leaked instance). */
	roots?: number;
}

export type LeakVerdict = 'LEAK SUSPECTED' | 'NO LEAK DETECTED' | 'INCONCLUSIVE';

export interface LeakVerdictInput {
	forcedGc: boolean;
	iterations: number;
	performed: number;
	/** Elements tracked (removed while tracking). */
	tracked: number;
	groups: LeakGroup[];
	/** Counter growth over the run (after - baseline), when CDP is on. */
	growth: Record<string, number> | null;
}

export interface LeakAssessment {
	verdict: LeakVerdict;
	/** Why (`no forced GC; enable --cdp`, ...), shown in parentheses. */
	reason?: string;
	/** `LEAK? ...` lines. */
	findings: string[];
}

function perIteration(n: number, iterations: number): string {
	const v = n / Math.max(1, iterations);
	return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/**
 * Verdict of a leak check:
 * - no forced GC -> INCONCLUSIVE (alive elements may just be uncollected garbage);
 * - no action performed -> INCONCLUSIVE;
 * - detached Svelte elements alive after GC, or JS event listeners grown by at
 *   least one per iteration -> LEAK SUSPECTED;
 * - nothing was removed by the actions -> INCONCLUSIVE (nothing unmounted);
 * - else NO LEAK DETECTED.
 */
export function assessLeak(input: LeakVerdictInput): LeakAssessment {
	const findings: string[] = [];
	if (input.forcedGc) {
		for (const g of input.groups) {
			findings.push(
				`LEAK? ${g.component ?? '(unknown component)'} ${g.source} retains ${g.count} detached node${g.count === 1 ? '' : 's'} (~${perIteration(g.count, input.iterations)}/iteration)`
			);
		}
		const listeners = input.growth?.JSEventListeners ?? 0;
		if (listeners >= input.iterations && listeners > 0) {
			findings.push(
				`LEAK? +${listeners} JS event listeners after GC (~${perIteration(listeners, input.iterations)}/iteration): a listener added on mount is not removed on destroy`
			);
		}
	}
	if (!input.forcedGc)
		return { verdict: 'INCONCLUSIVE', reason: 'no forced GC; enable --cdp', findings };
	if (input.performed === 0)
		return { verdict: 'INCONCLUSIVE', reason: 'no action could be performed', findings };
	if (findings.length > 0) return { verdict: 'LEAK SUSPECTED', findings };
	if (input.tracked === 0) {
		return {
			verdict: 'INCONCLUSIVE',
			reason: 'the actions did not unmount any Svelte element',
			findings
		};
	}
	return { verdict: 'NO LEAK DETECTED', findings };
}

/** `ui_leak_check` handler. */
export async function uiLeakCheck(
	deps: CdpToolDeps,
	rawArgs: Record<string, unknown> | undefined
): Promise<McpToolResult> {
	const args = rawArgs ?? {};
	const sleep = deps.sleep ?? defaultSleep;
	let tab: TabEntry;
	let actions: CdpAction[];
	try {
		tab = resolveTab(deps.registry, args.tabId);
		actions = readActions(args, { required: true });
	} catch (err) {
		return errorResult(messageOf(err));
	}
	const iterations = leakIterations(args.iterations);
	const waitMs = settleMs(args.waitMs);
	const notes: string[] = [];
	const send = (
		tool: string,
		toolArgs: Record<string, unknown>,
		timeoutMs?: number
	): Promise<RuntimeResultData> =>
		deps.channel.send(tool, toolArgs, { tabId: tab.tabId, timeoutMs });

	const config = deps.cdp();
	let session: CdpSessionLike | null = null;
	let target: CdpTarget | null = null;
	if (config) {
		try {
			const conn = await openSession(deps, config, tab);
			session = conn.session;
			target = conn.target;
			if (conn.ambiguous)
				notes.push(`several Chrome tabs show ${tab.url}; measured the first match`);
		} catch (err) {
			notes.push(`CDP unavailable, ran without a forced GC: ${messageOf(err)}`);
		}
	}

	const gc = async () => {
		await session!.send('HeapProfiler.collectGarbage');
		await sleep(GC_GAP_MS);
		await session!.send('HeapProfiler.collectGarbage');
	};

	let tracking = false;
	try {
		let baseline: Record<string, number> | null = null;
		if (session) {
			await session.send('Performance.enable');
			await gc();
			baseline = await readCounters(session);
		}
		await send(LEAK_TRACK_START_TOOL, {});
		tracking = true;
		const run = await send(
			RUN_ACTIONS_TOOL,
			{ actions, iterations, waitMs },
			runActionsTimeoutMs(actions.length, iterations, waitMs)
		);
		const runData = (run.data ?? {}) as { performed?: number; skipped?: string[] };
		if (session) await gc();
		const report = await send(LEAK_TRACK_REPORT_TOOL, {});
		tracking = false;
		const after = session ? await readCounters(session) : null;

		const reportData = (report.data ?? {}) as {
			tracked?: number;
			retained?: number;
			groups?: LeakGroup[];
			truncated?: boolean;
		};
		const groups = Array.isArray(reportData.groups) ? reportData.groups : [];
		const tracked = Number(reportData.tracked ?? 0);
		const retained = Number(reportData.retained ?? 0);
		const performed = Number(runData.performed ?? 0);
		const growth: Record<string, number> | null =
			baseline && after
				? Object.fromEntries(LEAK_METRICS.map((m) => [m, Math.round(after[m] - baseline![m])]))
				: null;
		const assessment = assessLeak({
			forcedGc: session !== null,
			iterations,
			performed,
			tracked,
			groups,
			growth
		});

		const lines = [
			`${assessment.verdict}${assessment.reason ? ` (${assessment.reason})` : ''}: ${iterations} iteration${iterations === 1 ? '' : 's'} of [${describeActions(actions)}]` +
				(session ? ', forced GC via CDP' : ''),
			...assessment.findings
		];
		if (baseline && after) {
			lines.push('COUNTERS after forced GC (baseline -> after, growth per iteration):');
			const rows = LEAK_METRICS.map((name) => {
				const unit = PERF_METRICS.find((m) => m.name === name)!.unit;
				const d = Math.round(after[name] - baseline![name]);
				return [
					name,
					`${formatMetricValue(Math.round(baseline![name]), unit)} -> ${formatMetricValue(Math.round(after[name]), unit)}`,
					`${signed(d, unit)} (~${unit === 'bytes' ? formatBytes(Math.round(d / iterations)) : perIteration(d, iterations)}/iteration)`
				];
			});
			const w0 = Math.max(...rows.map((r) => r[0].length));
			const w1 = Math.max(...rows.map((r) => r[1].length));
			for (const r of rows) lines.push(`  ${r[0].padEnd(w0)}  ${r[1].padEnd(w1)}  ${r[2]}`);
		}
		lines.push(
			`PAGE TRACKING: ${tracked} Svelte element${tracked === 1 ? '' : 's'} removed during the run, ${retained} still alive and detached` +
				(session ? ' after GC' : ' (no GC forced: may be garbage not collected yet)') +
				(reportData.truncated ? ' (tracking capped)' : '')
		);
		if (!session && groups.length > 0) {
			lines.push('CANDIDATES (unconfirmed without a forced GC):');
			for (const g of groups.slice(0, 15)) {
				const roots =
					typeof g.roots === 'number' ? ` in ${g.roots} subtree${g.roots === 1 ? '' : 's'}` : '';
				lines.push(
					`  ${g.component ?? '(unknown component)'} ${g.source} ${g.count} detached node${g.count === 1 ? '' : 's'}${roots}`
				);
			}
		}
		if (performed < actions.length * iterations) lines.push(`warning: ${run.text}`);
		if (!config) lines.push(`To confirm, enable CDP mode: ${CDP_HOW_TO_ENABLE}`);
		for (const note of notes) lines.push(`note: ${note}`);

		return {
			content: [{ type: 'text', text: lines.join('\n') }],
			structuredContent: {
				verdict: assessment.verdict,
				...(assessment.reason ? { reason: assessment.reason } : {}),
				findings: assessment.findings,
				forcedGc: session !== null,
				iterations,
				actions,
				performed,
				tracked,
				retained,
				groups,
				counters: baseline && after ? { baseline, after, growth } : null,
				...(target ? { target: { id: target.id, url: target.url } } : {}),
				tabId: tab.tabId
			}
		};
	} catch (err) {
		if (tracking) {
			// Stop the page-side observer; the result does not matter.
			send(LEAK_TRACK_REPORT_TOOL, {}).catch(() => {});
		}
		return errorResult(`ui_leak_check: ${messageOf(err)}`);
	} finally {
		session?.close();
	}
}

export function registerCdpTools(server: McpToolServer, z: ZodNamespace, deps: CdpToolDeps): void {
	const actionSchema = () =>
		z.object({
			ref: z.string().describe('Ref (eN) or ui:// stable key of the element to act on.'),
			type: z
				.enum(CDP_ACTION_TYPES)
				.describe('"click", "input" (sets value, fires input + change) or "scroll".'),
			value: z
				.string()
				.optional()
				.describe('input: the text to set (required). scroll: "dy" or "dx,dy" px.')
		});

	server.registerTool(
		'ui_perf_metrics',
		{
			title: 'Browser performance counters around an action (CDP)',
			description:
				'Needs CDP mode (svelte-grab-mcp --cdp=http://127.0.0.1:9222, Chrome started with ' +
				'--remote-debugging-port); without it returns an error saying how to enable it. Reads Chrome counters ' +
				'of the tab (Memory.getDOMCounters + Performance.getMetrics) before and after an optional in-page action ' +
				'(best effort, isTrusted=false) and a settle (2 frames + waitMs): Nodes, JSEventListeners, Documents, ' +
				'JSHeapUsedSize, LayoutCount, RecalcStyleCount, ScriptDuration, TaskDuration. First line summarizes the ' +
				'changed counters ("PERF click e5: Nodes +12, LayoutCount +1, ..."), then a before/after/delta table ' +
				'(changed rows marked *). structuredContent: { metrics: [{ name, unit, before, after, delta }] }.',
			inputSchema: {
				action: actionSchema().optional().describe('In-page action to measure.'),
				ref: z.string().optional().describe('Shorthand for action { ref, type: "click" }.'),
				waitMs: z
					.number()
					.int()
					.optional()
					.describe(
						`Settle time after the action, after 2 frames (default ${DEFAULT_SETTLE_MS}, max ${MAX_SETTLE_MS}).`
					),
				tabId: z.string().optional().describe(deps.tabIdHint)
			}
		},
		async (args) => uiPerfMetrics(deps, args)
	);

	server.registerTool(
		'ui_leak_check',
		{
			title: 'Check open/close cycles for memory leaks',
			description:
				'Repeats in-page actions (e.g. actions [open, close] on a modal toggle) `iterations` times and checks ' +
				'what survives. The page records a WeakRef + source of every Svelte element removed during the run; ' +
				'with CDP mode (--cdp) the server forces GC (HeapProfiler.collectGarbage) before and after, so ' +
				'elements still alive and detached are really retained: reported as "LEAK? <Component> <file:line> ' +
				'retains N detached nodes (~N/iteration)", plus growth of Nodes, JSEventListeners and JSHeapUsedSize ' +
				'per iteration. First line is the verdict: LEAK SUSPECTED, NO LEAK DETECTED or INCONCLUSIVE (no forced ' +
				'GC without --cdp, nothing unmounted, or no action performed); without CDP the alive elements are ' +
				'listed as unconfirmed candidates. Typical leaks: a module-level array or store holding elements, a ' +
				'window/document listener or interval not removed on destroy.',
			inputSchema: {
				actions: z
					.array(actionSchema())
					.optional()
					.describe(
						`Actions per iteration, in order (max ${MAX_RUN_ACTIONS}), e.g. [open toggle, close toggle].`
					),
				action: actionSchema()
					.optional()
					.describe('A single action per iteration (e.g. a toggle clicked once).'),
				iterations: z
					.number()
					.int()
					.positive()
					.optional()
					.describe(
						`How many times to run the actions (default ${DEFAULT_LEAK_ITERATIONS}, max ${MAX_LEAK_ITERATIONS}).`
					),
				waitMs: z
					.number()
					.int()
					.optional()
					.describe(
						`Settle time after each iteration, after 2 frames (default ${DEFAULT_SETTLE_MS}, max ${MAX_SETTLE_MS}).`
					),
				tabId: z.string().optional().describe(deps.tabIdHint)
			}
		},
		async (args) => uiLeakCheck(deps, args)
	);
}
