// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	LeakTracker,
	LEAK_TRACK_REPORT_TOOL,
	LEAK_TRACK_START_TOOL,
	RUN_ACTIONS_TOOL,
	DEFAULT_SETTLE_MS as PAGE_DEFAULT_SETTLE_MS,
	MAX_SETTLE_MS as PAGE_MAX_SETTLE_MS,
	MAX_RUN_ACTIONS as PAGE_MAX_RUN_ACTIONS,
	MAX_RUN_ITERATIONS,
	isLeakTracking,
	uiLeakTrackReport,
	uiLeakTrackStart,
	uiRunActions
} from '../src/lib/runtime/leak.js';
import { PROFILE_ACTION_TYPES } from '../src/lib/runtime/profile.js';
import { RefRegistry } from '../src/lib/runtime/refs.js';
import { dispatchRuntimeCommand, runtimeTools } from '../src/lib/runtime/commands.js';
import * as server from '../src/mcp/runtime/cdp-tools.js';
import { SVELTE_GRAB_UI_ATTR } from '../src/lib/utils/hide-from-third-parties.js';
import { h, meta } from './runtime-helpers.js';

/** One macrotask: lets jsdom deliver the pending MutationObserver batch. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const PANEL = '/app/src/components/Panel.svelte';
const APP = '/app/src/App.svelte';

/** A Panel component instance: div (line 10) > strong (11) + ul (12) > li (13). */
function panel(): HTMLElement {
	return meta(
		h(
			'div',
			{ class: 'panel' },
			meta(h('strong', {}, 'Panel'), PANEL, 11, 3, null),
			meta(h('ul', {}, meta(h('li', {}, 'one'), PANEL, 13, 5, null)), PANEL, 12, 3, null)
		),
		PANEL,
		10,
		1,
		null
	);
}

beforeEach(() => {
	document.body.innerHTML = '';
});

afterEach(() => {
	if (isLeakTracking()) uiLeakTrackReport();
	vi.unstubAllGlobals();
});

describe('LeakTracker', () => {
	it('records removed Svelte elements with their subtree and groups the retained ones by detached root', async () => {
		const host = meta(h('section'), APP, 1, 1, null);
		document.body.append(host);
		const kept: HTMLElement[] = [];
		const tracker = new LeakTracker(document);
		tracker.start();
		for (let i = 0; i < 3; i++) {
			const p = panel();
			host.append(p);
			await tick();
			p.remove();
			kept.push(p); // retained, like a module-level array
			await tick();
		}
		const report = tracker.report();
		expect(tracker.running).toBe(false);
		expect(report.tracked).toBe(12);
		expect(report.retained).toBe(12);
		expect(report.groups).toEqual([
			{
				component: 'Panel',
				file: 'src/components/Panel.svelte',
				line: 10,
				source: 'src/components/Panel.svelte:10',
				count: 12,
				roots: 3
			}
		]);
		expect(kept).toHaveLength(3);
	});

	it('does not count elements that were collected (WeakRef empty) or moved back into the document', async () => {
		const collected = new WeakSet<object>();
		class FakeWeakRef<T extends object> {
			constructor(private readonly target: T) {}
			deref(): T | undefined {
				return collected.has(this.target) ? undefined : this.target;
			}
		}
		vi.stubGlobal('WeakRef', FakeWeakRef);

		const a = panel();
		const b = panel();
		document.body.append(a, b);
		const tracker = new LeakTracker(document);
		tracker.start();
		a.remove();
		b.remove();
		await tick();
		for (const el of [a, ...Array.from(a.querySelectorAll('*'))]) collected.add(el);
		document.body.append(b); // moved, not detached
		const report = tracker.report();
		expect(report.tracked).toBe(8);
		expect(report.retained).toBe(0);
		expect(report.groups).toEqual([]);
	});

	it('ignores elements without Svelte meta and svelte-grab own UI', async () => {
		const overlay = h('div', { [SVELTE_GRAB_UI_ATTR]: '' }, meta(h('span'), PANEL, 3, 1, null));
		const plain = h('div', {}, h('span'));
		const inner = panel();
		const ownHost = h('div', { [SVELTE_GRAB_UI_ATTR]: '' }, inner);
		document.body.append(overlay, plain, ownHost);
		const tracker = new LeakTracker(document);
		tracker.start();
		overlay.remove();
		plain.remove();
		inner.remove(); // removed from inside our own overlay
		await tick();
		const report = tracker.report();
		expect(report.tracked).toBe(0);
	});

	it('falls back to the element source when the detached root has no meta', async () => {
		const p = panel();
		const wrapper = h('div', {}, p);
		document.body.append(wrapper);
		const tracker = new LeakTracker(document);
		tracker.start();
		wrapper.remove();
		const report = tracker.report(); // takeRecords: no tick needed
		expect(report.groups.map((g) => [g.source, g.count, g.roots])).toEqual([
			['src/components/Panel.svelte:10', 1, 1],
			['src/components/Panel.svelte:11', 1, 1],
			['src/components/Panel.svelte:12', 1, 1],
			['src/components/Panel.svelte:13', 1, 1]
		]);
	});
});

describe('ui_leak_track_start / ui_leak_track_report', () => {
	it('reports retained elements as text + data and stops the session', async () => {
		const p = panel();
		document.body.append(p);
		const started = await dispatchRuntimeCommand(LEAK_TRACK_START_TOOL, {});
		expect(started).toMatchObject({
			ok: true,
			result: { data: { tracking: true, restarted: false } }
		});
		p.remove();
		await tick();
		const out = await dispatchRuntimeCommand(LEAK_TRACK_REPORT_TOOL, {});
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(out.result.text).toBe(
			'4 of 4 removed Svelte elements still alive and detached\n  Panel src/components/Panel.svelte:10 4 elements in 1 subtree'
		);
		expect(out.result.data).toMatchObject({ tracked: 4, retained: 4, truncated: false });
		expect(isLeakTracking()).toBe(false);
		expect(p.isConnected).toBe(false);
	});

	it('errors when no session runs, and a second start discards the first', async () => {
		expect(await dispatchRuntimeCommand(LEAK_TRACK_REPORT_TOOL, {})).toEqual({
			ok: false,
			error: 'No leak tracking session: call ui_leak_track_start first'
		});
		uiLeakTrackStart({}, document);
		expect(uiLeakTrackStart({}, document).data).toEqual({ tracking: true, restarted: true });
		expect(uiLeakTrackReport().data).toMatchObject({ tracked: 0, retained: 0, groups: [] });
	});
});

describe('ui_run_actions', () => {
	let registry: RefRegistry;
	const fast = { sleep: vi.fn(async () => {}), frame: vi.fn(async () => {}) };

	beforeEach(() => {
		registry = new RefRegistry();
		fast.sleep.mockClear();
		fast.frame.mockClear();
	});

	function toggle() {
		let open = 0;
		let close = 0;
		const openBtn = h('button', {}, 'Open');
		const closeBtn = h('button', {}, 'Close');
		openBtn.addEventListener('click', () => open++);
		closeBtn.addEventListener('click', () => close++);
		document.body.append(openBtn, closeBtn);
		return {
			openRef: registry.refFor(openBtn),
			closeRef: registry.refFor(closeBtn),
			counts: () => [open, close]
		};
	}

	it('runs the actions in order for each iteration, one frame after each and a settle after each iteration', async () => {
		const t = toggle();
		const out = await uiRunActions(
			{
				actions: [
					{ ref: t.openRef, type: 'click' },
					{ ref: t.closeRef, type: 'click' }
				],
				iterations: 3,
				waitMs: 50
			},
			{ registry, ...fast }
		);
		expect(t.counts()).toEqual([3, 3]);
		expect(fast.frame).toHaveBeenCalledTimes(3 * (2 + 2));
		expect(fast.sleep.mock.calls).toEqual([[50], [50], [50]]);
		expect(out.text).toBe(
			`Ran 3 iterations of [click ${t.openRef} -> click ${t.closeRef}]: 6 actions performed (isTrusted=false), settled 2 frames + 50ms after each`
		);
		expect(out.data).toMatchObject({
			iterations: 3,
			performed: 6,
			expected: 6,
			skipped: [],
			waitMs: 50,
			isTrusted: false
		});
	});

	it('with no actions only settles once (default 300ms)', async () => {
		const out = await uiRunActions({}, { registry, ...fast });
		expect(fast.sleep.mock.calls).toEqual([[PAGE_DEFAULT_SETTLE_MS]]);
		expect(out.text).toBe('No actions; settled 2 frames + 300ms');
		expect(out.data).toMatchObject({ iterations: 0, performed: 0, expected: 0 });
	});

	it('validates refs up front and the action shapes', async () => {
		await expect(
			uiRunActions({ actions: [{ ref: 'e99', type: 'click' }] }, { registry, ...fast })
		).rejects.toThrow('Unknown ref "e99" in actions[0]');
		await expect(uiRunActions({ actions: 'nope' }, { registry, ...fast })).rejects.toThrow(
			'"actions" must be an array'
		);
		await expect(
			uiRunActions({ actions: [{ ref: 'e1', type: 'hover' }] }, { registry, ...fast })
		).rejects.toThrow('"actions[0].type" must be one of click, input, scroll');
		const many = Array.from({ length: PAGE_MAX_RUN_ACTIONS + 1 }, () => ({
			ref: 'e1',
			type: 'click'
		}));
		await expect(uiRunActions({ actions: many }, { registry, ...fast })).rejects.toThrow(
			'at most 10 actions'
		);
	});

	it('skips (and reports) an action whose ref stops resolving mid-run', async () => {
		const t = toggle();
		const closeBtn = registry.resolve(t.closeRef)!.element;
		document.body.querySelector('button')!.addEventListener('click', () => closeBtn.remove());
		const out = await uiRunActions(
			{
				actions: [
					{ ref: t.openRef, type: 'click' },
					{ ref: t.closeRef, type: 'click' }
				],
				iterations: 2,
				waitMs: 0
			},
			{ registry, ...fast }
		);
		expect(out.data).toMatchObject({ performed: 2, expected: 4 });
		expect((out.data!.skipped as string[])[0]).toBe(
			`iteration 1, actions[1]: ref ${t.closeRef} no longer resolves`
		);
		expect(fast.sleep).not.toHaveBeenCalled();
	});

	it('clamps iterations to 20', async () => {
		const t = toggle();
		const out = await uiRunActions(
			{ actions: [{ ref: t.openRef, type: 'click' }], iterations: 99, waitMs: 0 },
			{ registry, ...fast }
		);
		expect(out.data).toMatchObject({
			iterations: MAX_RUN_ITERATIONS,
			performed: MAX_RUN_ITERATIONS
		});
	});
});

describe('page <-> server contract', () => {
	it('registers the internal commands under the names and limits the server uses', () => {
		for (const name of [LEAK_TRACK_START_TOOL, LEAK_TRACK_REPORT_TOOL, RUN_ACTIONS_TOOL]) {
			expect(Object.keys(runtimeTools)).toContain(name);
		}
		expect(LEAK_TRACK_START_TOOL).toBe(server.LEAK_TRACK_START_TOOL);
		expect(LEAK_TRACK_REPORT_TOOL).toBe(server.LEAK_TRACK_REPORT_TOOL);
		expect(RUN_ACTIONS_TOOL).toBe(server.RUN_ACTIONS_TOOL);
		expect(PAGE_DEFAULT_SETTLE_MS).toBe(server.DEFAULT_SETTLE_MS);
		expect(PAGE_MAX_SETTLE_MS).toBe(server.MAX_SETTLE_MS);
		expect(PAGE_MAX_RUN_ACTIONS).toBe(server.MAX_RUN_ACTIONS);
		expect(MAX_RUN_ITERATIONS).toBe(server.MAX_LEAK_ITERATIONS);
		expect(server.CDP_ACTION_TYPES).toEqual(PROFILE_ACTION_TYPES);
	});
});
