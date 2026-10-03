// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	startAgentRuntime,
	getRuntimeTabId,
	resetRuntimeTabIdForTests,
	RUNTIME_TAB_ID_KEY,
	RUNTIME_TAB_CHANNEL,
	type AgentRuntimeHandle
} from '../src/lib/runtime/connection.js';
import type { RuntimeCommandOutcome } from '../src/lib/runtime/types.js';
import { consoleCapture } from '../src/lib/runtime/console-capture.js';

/** Minimal EventSource double: tests drive open/error/messages by hand. */
class FakeEventSource extends EventTarget {
	static instances: FakeEventSource[] = [];
	closed = false;
	constructor(public url: string) {
		super();
		FakeEventSource.instances.push(this);
	}
	close() {
		this.closed = true;
	}
	open() {
		this.dispatchEvent(new Event('open'));
	}
	fail() {
		this.dispatchEvent(new Event('error'));
	}
	command(data: unknown) {
		this.dispatchEvent(new MessageEvent('runtime-command', { data: JSON.stringify(data) }));
	}
	static last(): FakeEventSource {
		return FakeEventSource.instances[FakeEventSource.instances.length - 1];
	}
}

/**
 * BroadcastChannel double: delivers asynchronously to every OTHER open
 * instance with the same name, like the real one. Two runtimes in one jsdom
 * stand in for two tabs.
 */
class FakeBroadcastChannel extends EventTarget {
	static open: FakeBroadcastChannel[] = [];
	static sent: unknown[] = [];
	closed = false;
	constructor(public name: string) {
		super();
		FakeBroadcastChannel.open.push(this);
	}
	postMessage(data: unknown) {
		if (this.closed) throw new Error('InvalidStateError: channel closed');
		FakeBroadcastChannel.sent.push(data);
		for (const other of FakeBroadcastChannel.open) {
			if (other === this || other.name !== this.name) continue;
			const copy = structuredClone(data);
			queueMicrotask(() => {
				if (!other.closed) other.dispatchEvent(new MessageEvent('message', { data: copy }));
			});
		}
	}
	close() {
		this.closed = true;
		FakeBroadcastChannel.open = FakeBroadcastChannel.open.filter((c) => c !== this);
	}
}

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

let calls: Call[];
let fetchMock: ReturnType<typeof vi.fn>;
let handle: AgentRuntimeHandle | null;
let handles: AgentRuntimeHandle[];

function posts(path: string): Call[] {
	return calls.filter((c) => c.url.endsWith(path));
}

async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

function start(extra: Record<string, unknown> = {}): AgentRuntimeHandle {
	handle = startAgentRuntime({
		serverUrl: 'http://localhost:4723/',
		forceEnable: true,
		EventSource: FakeEventSource as unknown as new (url: string) => EventSource,
		fetch: fetchMock as unknown as (input: string, init?: RequestInit) => Promise<Response>,
		BroadcastChannel: FakeBroadcastChannel as unknown as new (name: string) => BroadcastChannel,
		...extra
	});
	handles.push(handle);
	return handle;
}

beforeEach(() => {
	FakeEventSource.instances = [];
	FakeBroadcastChannel.open = [];
	FakeBroadcastChannel.sent = [];
	calls = [];
	fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		calls.push({
			url,
			body: JSON.parse(String(init?.body ?? '{}')),
			headers: (init?.headers ?? {}) as Record<string, string>
		});
		return new Response('{"ok":true}', { status: 200 });
	});
	sessionStorage.clear();
	resetRuntimeTabIdForTests();
	handle = null;
	handles = [];
});

afterEach(() => {
	for (const h of handles) h.stop();
	vi.useRealTimers();
});

describe('agent runtime connection', () => {
	it('is a no-op without Svelte dev metadata (production)', () => {
		const h = startAgentRuntime({
			serverUrl: 'http://localhost:4723',
			EventSource: FakeEventSource as unknown as new (url: string) => EventSource,
			fetch: fetchMock as unknown as (input: string) => Promise<Response>
		});
		expect(h.active).toBe(false);
		expect(h.tabId).toBe(null);
		expect(FakeEventSource.instances).toHaveLength(0);
		h.stop();
	});

	it('connects to /events and sends hello on open', async () => {
		const h = start();
		expect(h.active).toBe(true);
		expect(FakeEventSource.last().url).toBe('http://localhost:4723/events');
		expect(posts('/runtime/hello')).toHaveLength(0);

		document.title = 'Playground';
		FakeEventSource.last().open();
		await flush();
		const [hello] = posts('/runtime/hello');
		expect(hello.url).toBe('http://localhost:4723/runtime/hello');
		expect(hello.body).toEqual({
			tabId: h.tabId,
			url: location.href,
			title: 'Playground',
			focused: expect.any(Boolean)
		});
		expect(hello.headers['Content-Type']).toBe('application/json');
	});

	it('re-sends hello on focus/blur/visibilitychange and every 15s', async () => {
		vi.useFakeTimers();
		start();
		FakeEventSource.last().open();
		window.dispatchEvent(new Event('focus'));
		window.dispatchEvent(new Event('blur'));
		document.dispatchEvent(new Event('visibilitychange'));
		expect(posts('/runtime/hello')).toHaveLength(4);
		vi.advanceTimersByTime(15_000);
		expect(posts('/runtime/hello')).toHaveLength(5);
	});

	it('handles commands for its tab and posts the result', async () => {
		const dispatch = vi.fn(async (): Promise<RuntimeCommandOutcome> => ({
			ok: true,
			result: { text: 'e1 button "Save"', data: { nodes: [] } }
		}));
		const h = start({ dispatch });
		FakeEventSource.last().open();
		FakeEventSource.last().command({
			id: 'c1',
			targetTabId: h.tabId,
			tool: 'ui_snapshot',
			args: { scope: 'page' }
		});
		await flush();
		expect(dispatch).toHaveBeenCalledWith('ui_snapshot', { scope: 'page' });
		const [result] = posts('/runtime/result');
		expect(result.url).toBe('http://localhost:4723/runtime/result');
		expect(result.body).toEqual({
			id: 'c1',
			tabId: h.tabId,
			ok: true,
			result: { text: 'e1 button "Save"', data: { nodes: [] } }
		});
	});

	it('ignores commands for another tab, malformed events and duplicate ids', async () => {
		const dispatch = vi.fn(async (): Promise<RuntimeCommandOutcome> => ({
			ok: true,
			result: { text: '' }
		}));
		const h = start({ dispatch });
		const es = FakeEventSource.last();
		es.open();
		es.command({ id: 'x', targetTabId: 'other-tab', tool: 'ui_find', args: {} });
		es.dispatchEvent(new MessageEvent('runtime-command', { data: 'not json' }));
		es.command({ id: 'd', targetTabId: h.tabId, tool: 'ui_find', args: {} });
		es.command({ id: 'd', targetTabId: h.tabId, tool: 'ui_find', args: {} });
		await flush();
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(posts('/runtime/result')).toHaveLength(1);
	});

	it('posts ok:false with the error for unknown tools (real dispatcher)', async () => {
		const h = start();
		FakeEventSource.last().open();
		FakeEventSource.last().command({ id: 'u', targetTabId: h.tabId, tool: 'ui_nope', args: {} });
		await flush();
		expect(posts('/runtime/result')[0].body).toEqual({
			id: 'u',
			tabId: h.tabId,
			ok: false,
			error: 'Unknown tool'
		});
	});

	it('posts ok:false when the dispatcher rejects', async () => {
		const h = start({ dispatch: async () => Promise.reject(new Error('kaboom')) });
		FakeEventSource.last().open();
		FakeEventSource.last().command({ id: 'k', targetTabId: h.tabId, tool: 'ui_find', args: {} });
		await flush();
		expect(posts('/runtime/result')[0].body).toMatchObject({ id: 'k', ok: false, error: 'kaboom' });
	});

	it('reconnects with exponential backoff and resets it on open', () => {
		vi.useFakeTimers();
		start({ minBackoffMs: 100, maxBackoffMs: 400 });
		const first = FakeEventSource.last();
		first.fail();
		expect(first.closed).toBe(true);
		vi.advanceTimersByTime(99);
		expect(FakeEventSource.instances).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(FakeEventSource.instances).toHaveLength(2);
		FakeEventSource.last().fail();
		vi.advanceTimersByTime(200);
		expect(FakeEventSource.instances).toHaveLength(3);
		FakeEventSource.last().fail();
		vi.advanceTimersByTime(400);
		expect(FakeEventSource.instances).toHaveLength(4);
		FakeEventSource.last().fail();
		vi.advanceTimersByTime(400); // capped
		expect(FakeEventSource.instances).toHaveLength(5);
		FakeEventSource.last().open();
		FakeEventSource.last().fail();
		vi.advanceTimersByTime(100); // reset after a successful open
		expect(FakeEventSource.instances).toHaveLength(6);
	});

	it('passes the token as ?token= on SSE and as a header on POSTs', async () => {
		start({ token: 's3cret' });
		expect(FakeEventSource.last().url).toBe('http://localhost:4723/events?token=s3cret');
		FakeEventSource.last().open();
		await flush();
		expect(posts('/runtime/hello')[0].headers['x-svelte-grab-token']).toBe('s3cret');
	});

	it('stop() closes the stream, stops heartbeats and reconnects', () => {
		vi.useFakeTimers();
		const h = start();
		const es = FakeEventSource.last();
		es.open();
		h.stop();
		expect(es.closed).toBe(true);
		const before = calls.length;
		vi.advanceTimersByTime(60_000);
		window.dispatchEvent(new Event('focus'));
		expect(calls.length).toBe(before);
		expect(FakeEventSource.instances).toHaveLength(1);
	});

	it('captures console errors/warnings while running (even with trackHmr off) and restores console on stop', () => {
		const originalError = console.error;
		const originalWarn = console.warn;
		const spyError = vi.fn();
		const spyWarn = vi.fn();
		console.error = spyError;
		console.warn = spyWarn;
		try {
			consoleCapture.clear();
			const h = start({ trackHmr: false });
			expect(consoleCapture.active).toBe(true);
			expect(console.error).not.toBe(spyError);
			console.error('boom');
			console.warn('careful');
			expect(spyError).toHaveBeenCalledWith('boom');
			expect(spyWarn).toHaveBeenCalledWith('careful');
			expect(consoleCapture.entries().map((e) => [e.level, e.message])).toEqual([
				['error', 'boom'],
				['warn', 'careful']
			]);
			h.stop();
			expect(consoleCapture.active).toBe(false);
			expect(console.error).toBe(spyError);
			expect(console.warn).toBe(spyWarn);
		} finally {
			console.error = originalError;
			console.warn = originalWarn;
			consoleCapture.clear();
		}
	});
});

describe('tab id', () => {
	it('is persisted in sessionStorage', () => {
		const id = getRuntimeTabId();
		expect(id).toMatch(/\S{8,}/);
		expect(sessionStorage.getItem(RUNTIME_TAB_ID_KEY)).toBe(id);
		expect(getRuntimeTabId()).toBe(id);
	});

	it('falls back to memory when sessionStorage throws', () => {
		const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('denied');
		});
		const id = getRuntimeTabId();
		expect(getRuntimeTabId()).toBe(id);
		spy.mockRestore();
	});
});

describe('duplicated tab', () => {
	it('a lone tab keeps its id', async () => {
		const h = start();
		const id = h.tabId;
		await flush();
		expect(h.tabId).toBe(id);
		expect(sessionStorage.getItem(RUNTIME_TAB_ID_KEY)).toBe(id);
		expect(FakeBroadcastChannel.sent).toEqual([
			expect.objectContaining({ type: 'ping', tabId: id })
		]);
		expect(FakeBroadcastChannel.open[0].name).toBe(RUNTIME_TAB_CHANNEL);
	});

	it('regenerates the id when another live tab answers with the same id', async () => {
		// Tab A is live. Tab B is its duplicate: sessionStorage (shared here, copied
		// by the browser on duplicate) hands it the same id.
		const a = start();
		const original = a.tabId!;
		FakeEventSource.last().open();
		await flush();

		const b = start();
		expect(b.tabId).toBe(original);
		const esB = FakeEventSource.last();
		esB.open();
		await flush();

		expect(a.tabId).toBe(original);
		expect(b.tabId).not.toBe(original);
		expect(b.tabId).toMatch(/\S{8,}/);
		expect(sessionStorage.getItem(RUNTIME_TAB_ID_KEY)).toBe(b.tabId);

		// B announced its new id right away.
		const hellos = posts('/runtime/hello').map((c) => c.body.tabId);
		expect(hellos[hellos.length - 1]).toBe(b.tabId);

		// B answers only commands for its new id.
		esB.command({ id: 'old', targetTabId: original, tool: 'ui_nope', args: {} });
		esB.command({ id: 'new', targetTabId: b.tabId, tool: 'ui_nope', args: {} });
		await flush();
		expect(posts('/runtime/result').map((c) => c.body)).toEqual([
			{ id: 'new', tabId: b.tabId, ok: false, error: 'Unknown tool' }
		]);
	});

	it('a stopped tab no longer answers pings', async () => {
		const a = start();
		const id = a.tabId;
		a.stop();
		const b = start();
		await flush();
		expect(b.tabId).toBe(id);
		expect(FakeBroadcastChannel.open).toHaveLength(1);
	});

	it('works without BroadcastChannel', async () => {
		const h = start({ BroadcastChannel: null });
		await flush();
		expect(h.active).toBe(true);
		expect(FakeBroadcastChannel.open).toHaveLength(0);
	});
});
