// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	HmrTracker,
	HMR_LOG_SIZE,
	HMR_LOG_STORAGE_KEY,
	MAX_HMR_TIMEOUT_MS,
	hmrPathMatches,
	normalizeHmrPath,
	recordMatches,
	uiWaitForHmr,
	type HotContextLike,
	type HmrRecord
} from '../src/lib/runtime/hmr.js';
import { RefRegistry } from '../src/lib/runtime/refs.js';
import { dispatchRuntimeCommand, runtimeTools } from '../src/lib/runtime/commands.js';
import { HMR_BRIDGE_EVENT, VITE_PLUGIN_GLOBAL } from '../src/lib/utils/vite-plugin-info.js';
import { buildFixture, component, h, meta } from './runtime-helpers.js';

/** `import.meta.hot` double: tests emit Vite events by hand. */
class FakeHot implements HotContextLike {
	listeners = new Map<string, Set<(payload: unknown) => unknown>>();
	on(event: string, cb: (payload: unknown) => unknown) {
		if (!this.listeners.has(event)) this.listeners.set(event, new Set());
		this.listeners.get(event)!.add(cb);
	}
	off(event: string, cb: (payload: unknown) => unknown) {
		this.listeners.get(event)?.delete(cb);
	}
	emit(event: string, payload: unknown): unknown[] {
		return [...(this.listeners.get(event) ?? [])].map((cb) => cb(payload));
	}
	count(): number {
		let n = 0;
		for (const set of this.listeners.values()) n += set.size;
		return n;
	}
}

function update(...paths: string[]) {
	return { type: 'update', updates: paths.map((path) => ({ type: 'js-update', path, acceptedPath: path, timestamp: 1 })) };
}

function emitUpdate(hot: FakeHot, ...paths: string[]) {
	hot.emit('vite:beforeUpdate', update(...paths));
	hot.emit('vite:afterUpdate', update(...paths));
}

/** In-memory Storage. */
function memoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		get length() {
			return map.size;
		},
		clear: () => map.clear(),
		getItem: (k) => map.get(k) ?? null,
		key: (i) => [...map.keys()][i] ?? null,
		removeItem: (k) => void map.delete(k),
		setItem: (k, v) => void map.set(k, String(v))
	};
}

const noSettle = () => Promise.resolve();

let hot: FakeHot;
let storage: Storage;
let clock: number;
let tracker: HmrTracker;

beforeEach(() => {
	document.body.innerHTML = '';
	hot = new FakeHot();
	storage = memoryStorage();
	clock = 1_000;
	tracker = new HmrTracker({ hot, storage, now: () => clock, pluginInfo: () => null });
});

afterEach(() => {
	while (tracker.active) tracker.release();
	delete (window as unknown as Record<string, unknown>)[VITE_PLUGIN_GLOBAL];
	vi.useRealTimers();
});

describe('path matching', () => {
	it('normalizes Vite update paths', () => {
		expect(normalizeHmrPath('/src/lib/Card.svelte?svelte&type=style&lang.css')).toBe('/src/lib/Card.svelte');
		expect(normalizeHmrPath('/@fs/Users/me/app/src/x.ts?t=1')).toBe('/Users/me/app/src/x.ts');
		expect(normalizeHmrPath('.\\src\\x.ts')).toBe('src/x.ts');
	});

	it('suffix-matches on path boundaries, both directions', () => {
		expect(hmrPathMatches('/src/components/Card.svelte', 'Card.svelte')).toBe(true);
		expect(hmrPathMatches('/src/components/Card.svelte', 'src/components/Card.svelte')).toBe(true);
		expect(hmrPathMatches('/src/components/Card.svelte', '/Users/me/app/src/components/Card.svelte')).toBe(true);
		expect(hmrPathMatches('/src/components/FixtureCard.svelte', 'Card.svelte')).toBe(false);
		expect(hmrPathMatches('/src/components/Card.svelte?svelte&type=style&lang.css', 'Card.svelte')).toBe(true);
		expect(hmrPathMatches('/src/a.ts', '')).toBe(false);
	});

	it('full reloads and file-less errors match any filter', () => {
		const base: HmrRecord = { kind: 'update', at: 1, files: ['/src/a.ts'], errors: [], consoleErrors: 0, source: 'vite-hmr' };
		expect(recordMatches(base, undefined)).toBe(true);
		expect(recordMatches(base, ['b.ts'])).toBe(false);
		expect(recordMatches({ ...base, kind: 'full-reload' }, ['b.ts'])).toBe(true);
		expect(recordMatches({ ...base, kind: 'error', files: [] }, ['b.ts'])).toBe(true);
	});
});

describe('HmrTracker', () => {
	it('records afterUpdate with file paths and installs/removes listeners with retain/release', () => {
		tracker.retain();
		tracker.retain();
		expect(hot.count()).toBe(4);
		emitUpdate(hot, '/src/A.svelte', '/src/A.svelte?svelte&type=style&lang.css');
		expect(tracker.log()).toEqual([
			{ kind: 'update', at: 1_000, files: ['/src/A.svelte'], errors: [], consoleErrors: 0, source: 'vite-hmr' }
		]);
		tracker.release();
		expect(hot.count()).toBe(4);
		tracker.release();
		expect(hot.count()).toBe(0);
	});

	it('keeps a ring buffer of the last 20 records, persisted to sessionStorage', () => {
		tracker.retain();
		for (let i = 0; i < HMR_LOG_SIZE + 5; i++) {
			clock = 2_000 + i;
			emitUpdate(hot, `/src/F${i}.svelte`);
		}
		const log = tracker.log();
		expect(log).toHaveLength(HMR_LOG_SIZE);
		expect(log[0].files).toEqual(['/src/F5.svelte']);
		expect(log[HMR_LOG_SIZE - 1].files).toEqual([`/src/F${HMR_LOG_SIZE + 4}.svelte`]);

		// A new page (after a full reload) restores the log.
		const next = new HmrTracker({ hot: null, storage, now: () => clock, pluginInfo: () => null });
		expect(next.log()).toEqual(log);
	});

	it('records vite:error messages with the failing file', () => {
		tracker.retain();
		hot.emit('vite:error', {
			type: 'error',
			err: { message: 'Unexpected token', plugin: 'vite-plugin-svelte', id: '/Users/me/app/src/Card.svelte', loc: { line: 4 } }
		});
		const [rec] = tracker.log();
		expect(rec.kind).toBe('error');
		expect(rec.files).toEqual(['/Users/me/app/src/Card.svelte']);
		expect(rec.errors[0]).toBe('[vite-plugin-svelte] Unexpected token (/Users/me/app/src/Card.svelte:4)');
	});

	it('counts console errors and uncaught errors against the latest update', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		tracker.retain();
		console.error('before any update'); // no record yet: not counted
		emitUpdate(hot, '/src/A.svelte');
		console.error('boom');
		window.dispatchEvent(new Event('error'));
		expect(tracker.log()[0].consoleErrors).toBe(2);
		expect(spy).toHaveBeenCalledWith('boom');
		tracker.release();
		console.error('after release');
		expect(tracker.log()[0].consoleErrors).toBe(2);
		spy.mockRestore();
	});

	it('uses the plugin bridge only without import.meta.hot', () => {
		const viaBridge = new HmrTracker({ hot: null, storage: null, now: () => clock, pluginInfo: () => null });
		expect(viaBridge.source).toBe('heuristic');
		viaBridge.retain();
		window.dispatchEvent(
			new CustomEvent(HMR_BRIDGE_EVENT, { detail: { type: 'vite:afterUpdate', payload: update('/src/B.svelte') } })
		);
		expect(viaBridge.source).toBe('plugin');
		expect(viaBridge.log()).toMatchObject([{ kind: 'update', files: ['/src/B.svelte'], source: 'plugin' }]);
		viaBridge.release();

		// With import.meta.hot the same bridged event is ignored (no double count).
		tracker.retain();
		window.dispatchEvent(
			new CustomEvent(HMR_BRIDGE_EVENT, { detail: { type: 'vite:afterUpdate', payload: update('/src/B.svelte') } })
		);
		expect(tracker.log()).toEqual([]);
		expect(tracker.source).toBe('vite-hmr');
	});

	it('reports source "plugin" when the plugin marker says the bridge is on', () => {
		const t = new HmrTracker({ hot: null, storage: null, pluginInfo: () => ({ hmrBridge: true }) });
		expect(t.source).toBe('plugin');
	});

	it('holds a full reload briefly (bridge waitUntil) only when a waiter is pending', async () => {
		const t = new HmrTracker({ hot: null, storage: null, now: () => clock, pluginInfo: () => ({ hmrBridge: true }) });
		t.retain();
		const holds: Promise<unknown>[] = [];
		const fire = () =>
			window.dispatchEvent(
				new CustomEvent(HMR_BRIDGE_EVENT, {
					detail: { type: 'vite:beforeFullReload', payload: { type: 'full-reload' }, waitUntil: (p: Promise<unknown>) => holds.push(p) }
				})
			);
		fire();
		expect(holds).toHaveLength(0);

		clock = 5_000;
		const waiting = t.waitFor({ after: 5_000, timeoutMs: 1_000 });
		fire();
		expect(holds).toHaveLength(1);
		await expect(waiting).resolves.toMatchObject({ kind: 'full-reload' });
		await holds[0];
		t.release();
	});
});

describe('ui_wait_for_hmr', () => {
	it('is registered as a page tool', () => {
		expect(Object.keys(runtimeTools)).toContain('ui_wait_for_hmr');
	});

	it('resolves on a matching update after the call, ignoring other files', async () => {
		const registry = new RefRegistry();
		const pending = uiWaitForHmr({ files: ['Card.svelte'] }, { tracker, registry, now: () => clock, settle: noSettle });
		clock = 1_100;
		emitUpdate(hot, '/src/Other.svelte');
		emitUpdate(hot, '/src/FixtureCard.svelte'); // boundary: not Card.svelte
		await Promise.resolve();
		expect(tracker.waiterCount).toBe(1);
		emitUpdate(hot, '/src/lib/Card.svelte');
		const out = await pending;
		expect(out.data).toMatchObject({
			status: 'updated',
			updated: ['/src/lib/Card.svelte'],
			errors: [],
			rebound: [],
			lost: [],
			consoleErrors: 0,
			source: 'vite-hmr'
		});
		expect(out.text).toContain('HMR update applied (source: vite-hmr): /src/lib/Card.svelte');
		expect(tracker.active).toBe(false);
	});

	it('ignores updates from before the call unless since covers them', async () => {
		tracker.retain(); // the runtime keeps the tracker running
		clock = 1_000;
		emitUpdate(hot, '/src/lib/Card.svelte');
		clock = 2_000;

		const out = await uiWaitForHmr({ files: ['Card.svelte'], since: 900 }, { tracker, now: () => clock, settle: noSettle, registry: new RefRegistry() });
		expect(out.data).toMatchObject({ status: 'updated', updated: ['/src/lib/Card.svelte'], at: 1_000 });

		vi.useFakeTimers();
		const late = uiWaitForHmr({ files: ['Card.svelte'], timeoutMs: 500 }, { tracker, now: () => clock, settle: noSettle, registry: new RefRegistry() });
		const assertion = expect(late).rejects.toThrow(/No HMR update touching Card\.svelte within 0\.5s \(source: vite-hmr\)\. Recent updates: update \/src\/lib\/Card\.svelte/);
		await vi.advanceTimersByTimeAsync(600);
		await assertion;
	});

	it('since combines every matching update in the ring buffer', async () => {
		tracker.retain();
		clock = 1_000;
		emitUpdate(hot, '/src/A.svelte');
		clock = 1_500;
		emitUpdate(hot, '/src/B.svelte');
		clock = 1_800;
		emitUpdate(hot, '/src/C.svelte');
		const out = await uiWaitForHmr({ files: ['A.svelte', 'B.svelte'], since: 1_000 }, { tracker, now: () => 2_000, settle: noSettle, registry: new RefRegistry() });
		expect(out.data).toMatchObject({ updated: ['/src/A.svelte', '/src/B.svelte'], at: 1_500 });
	});

	it('a vite:error for the file resolves with status "error"', async () => {
		const pending = uiWaitForHmr({ files: ['Card.svelte'] }, { tracker, now: () => clock, settle: noSettle, registry: new RefRegistry() });
		hot.emit('vite:error', { err: { message: 'Expected }', id: '/app/src/lib/Card.svelte' } });
		const out = await pending;
		expect(out.data).toMatchObject({ status: 'error', errors: ['Expected } (/app/src/lib/Card.svelte)'] });
		expect(out.text).toMatch(/^Vite reported an error instead of an update/);
	});

	it('a full reload answers immediately and says the refs are gone', async () => {
		const settle = vi.fn(noSettle);
		const pending = uiWaitForHmr({ files: ['main.ts'] }, { tracker, now: () => clock, settle, registry: new RefRegistry() });
		const holds = hot.emit('vite:beforeFullReload', { type: 'full-reload', triggeredBy: '/app/src/main.ts' });
		const out = await pending;
		expect(out.data).toMatchObject({ status: 'full-reload', updated: ['/app/src/main.ts'] });
		expect(out.text).toMatch(/^Full page reload \(triggered by \/app\/src\/main\.ts\)/);
		expect(settle).not.toHaveBeenCalled();
		expect(holds[0]).toBeInstanceOf(Promise);
	});

	it('rebinds refs whose elements were replaced and reports lost ones', async () => {
		const registry = new RefRegistry();
		const { buttons, h1 } = buildFixture();
		const keptRef = registry.refFor(h1);
		const oldRef = registry.refFor(buttons[0]);
		const goneEl = meta(h('span', {}, 'gone'), '/src/App.svelte', 9, 1, null);
		document.querySelector('main')!.append(goneEl);
		const goneRef = registry.refFor(goneEl);

		const pending = uiWaitForHmr({}, { tracker, registry, now: () => clock, settle: noSettle });
		// "HMR": the Button instance is re-created, the span disappears.
		const inst = component('Button', '/src/lib/Card.svelte', 7, null);
		const fresh = meta(h('button', {}, 'a'), '/src/lib/Button.svelte', 2, 1, inst);
		buttons[0].replaceWith(fresh);
		goneEl.remove();
		emitUpdate(hot, '/src/lib/Button.svelte');

		const out = await pending;
		const data = out.data as { rebound: { from: string; to: string }[]; lost: string[]; kept: number };
		expect(data.kept).toBe(1);
		expect(data.lost).toEqual([goneRef]);
		expect(data.rebound).toHaveLength(1);
		expect(data.rebound[0].from).toBe(oldRef);
		const newRef = data.rebound[0].to;
		expect(fresh.getAttribute('data-sg-ref')).toBe(newRef);
		expect(out.text).toContain(`Refs: 1 kept, 1 rebound (${oldRef} -> ${newRef}), 1 lost (${goneRef})`);

		// The old ref keeps resolving to the replacement.
		expect(registry.resolve(oldRef)).toMatchObject({ element: fresh, ref: newRef, rebound: true, previous: oldRef });
		expect(registry.resolve(goneRef)).toBeNull();
		expect(registry.resolve(keptRef)?.element).toBe(h1);

		// A second pass has nothing left to report.
		expect(registry.rebindAll()).toEqual({ kept: 2, rebound: [], lost: [] });
	});

	it('counts console errors raised while the update settles', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const pending = uiWaitForHmr(
			{},
			{
				tracker,
				now: () => clock,
				registry: new RefRegistry(),
				settle: async () => {
					console.error('render failed');
				}
			}
		);
		emitUpdate(hot, '/src/A.svelte');
		const out = await pending;
		expect(out.data).toMatchObject({ consoleErrors: 1 });
		expect(out.text).toContain('Console errors since the update: 1');
		spy.mockRestore();
	});

	it('falls back to a DOM-mutation heuristic without any HMR source', async () => {
		const t = new HmrTracker({ hot: null, storage: null, pluginInfo: () => null });
		document.body.append(h('div', { id: 'app' }));
		const pending = uiWaitForHmr({ files: ['Card.svelte'] }, { tracker: t, registry: new RefRegistry(), settle: noSettle });
		await Promise.resolve();
		document.getElementById('app')!.append(h('p', {}, 'changed'));
		const out = await pending;
		expect(out.data).toMatchObject({ status: 'updated', updated: [], source: 'heuristic' });
		expect(out.text).toContain('source: heuristic');
		expect(out.text).toContain('svelte-grab/vite');
	});

	it('validates args and clamps the timeout', async () => {
		await expect(uiWaitForHmr({ files: [1] }, { tracker })).rejects.toThrow('"files" must be an array of strings');
		await expect(uiWaitForHmr({ since: 'yesterday' }, { tracker })).rejects.toThrow('"since" must be a number');

		vi.useFakeTimers();
		const pending = uiWaitForHmr({ timeoutMs: 999_999 }, { tracker, now: () => clock, settle: noSettle });
		const assertion = expect(pending).rejects.toThrow(`within ${MAX_HMR_TIMEOUT_MS / 1000}s`);
		await vi.advanceTimersByTimeAsync(MAX_HMR_TIMEOUT_MS - 10);
		expect(tracker.waiterCount).toBe(1);
		await vi.advanceTimersByTimeAsync(20);
		await assertion;
	});

	it('goes through dispatchRuntimeCommand with ok:false on timeout', async () => {
		vi.useFakeTimers();
		const outcome = dispatchRuntimeCommand('ui_wait_for_hmr', { timeoutMs: 50 }, {
			ui_wait_for_hmr: (args) => uiWaitForHmr(args, { tracker, now: () => clock, settle: noSettle })
		});
		await vi.advanceTimersByTimeAsync(60);
		await expect(outcome).resolves.toMatchObject({ ok: false, error: expect.stringContaining('No HMR update at all within 0.05s') });
	});

	it('persists the log so since works across a full reload', async () => {
		tracker.retain();
		clock = 3_000;
		hot.emit('vite:beforeFullReload', { type: 'full-reload', triggeredBy: '/app/src/main.ts' });
		expect(JSON.parse(storage.getItem(HMR_LOG_STORAGE_KEY)!)).toHaveLength(1);

		const reloaded = new HmrTracker({ hot: new FakeHot(), storage, now: () => 4_000, pluginInfo: () => null });
		const out = await uiWaitForHmr({ since: 2_500 }, { tracker: reloaded, now: () => 4_000, settle: noSettle, registry: new RefRegistry() });
		expect(out.data).toMatchObject({ status: 'full-reload', updated: ['/app/src/main.ts'] });
		expect(out.text).toContain('fully reloaded');
	});
});
