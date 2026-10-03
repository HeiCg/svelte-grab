import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	CDP_ENV,
	CdpSession,
	cdpArgFromArgv,
	connectToTab,
	listTargets,
	normalizeTargetUrl,
	parseCdpUrl,
	pickTarget,
	resolveCdpConfig,
	type CdpTarget,
	type FetchLike,
	type WebSocketLike
} from '../src/mcp/cdp/client.js';

type Listener = (event: { data?: unknown; message?: string }) => void;

/** Fake WHATWG WebSocket: records sent frames, lets the test emit events. */
class FakeWebSocket implements WebSocketLike {
	sent: { id: number; method: string; params: Record<string, unknown> }[] = [];
	closed = false;
	private listeners = new Map<string, Listener[]>();
	constructor(public url: string) {}
	addEventListener(type: string, listener: Listener): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	send(data: string): void {
		this.sent.push(JSON.parse(data));
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.emit('close', {});
	}
	emit(type: string, event: { data?: unknown; message?: string } = {}): void {
		for (const l of this.listeners.get(type) ?? []) l(event);
	}
	reply(id: number, result: unknown): void {
		this.emit('message', { data: JSON.stringify({ id, result }) });
	}
}

afterEach(() => {
	vi.useRealTimers();
});

describe('CDP URL validation', () => {
	it.each([
		['http://127.0.0.1:9222', 'http://127.0.0.1:9222'],
		['http://localhost:9222/', 'http://localhost:9222'],
		['https://localhost:9222', 'https://localhost:9222'],
		['http://[::1]:9222', 'http://[::1]:9222'],
		['ws://127.0.0.1:9222/devtools/browser/abc', 'http://127.0.0.1:9222'],
		['wss://localhost:9333', 'https://localhost:9333'],
		['  http://127.0.0.1:9222  ', 'http://127.0.0.1:9222']
	])('accepts loopback %s', (raw, httpUrl) => {
		expect(parseCdpUrl(raw)).toEqual({ httpUrl });
	});

	it.each([
		['http://192.168.1.10:9222', /host must be 127\.0\.0\.1, localhost or \[::1\]/],
		['http://example.com:9222', /full control of the browser/],
		['ws://0.0.0.0:9222', /host must be/],
		['http://127.0.0.1.nip.io:9222', /host must be/],
		['http://localhost.evil.com:9222', /host must be/],
		['ftp://127.0.0.1:9222', /use http:\/\/, https:\/\/ or ws:\/\//],
		['file:///tmp/x', /use http/],
		['127.0.0.1:9222', /Invalid --cdp URL|use http/],
		['not a url', /Invalid --cdp URL/],
		['http://user:pw@127.0.0.1:9222', /credentials/]
	])('rejects %s', (raw, message) => {
		expect(() => parseCdpUrl(raw)).toThrow(message);
	});

	it('reads --cdp from argv (bare flag = empty value)', () => {
		expect(cdpArgFromArgv(['--port=4723'])).toBeUndefined();
		expect(cdpArgFromArgv(['--cdp=http://127.0.0.1:9222', '--stdio'])).toBe(
			'http://127.0.0.1:9222'
		);
		expect(cdpArgFromArgv(['--cdp'])).toBe('');
	});

	it('is off by default; the option wins over SVELTE_GRAB_CDP; invalid values throw', () => {
		expect(resolveCdpConfig(undefined, {})).toBeNull();
		expect(resolveCdpConfig(undefined, { [CDP_ENV]: '' })).toBeNull();
		expect(resolveCdpConfig(undefined, { [CDP_ENV]: 'http://localhost:9333' })).toEqual({
			httpUrl: 'http://localhost:9333'
		});
		expect(
			resolveCdpConfig('http://127.0.0.1:9222', { [CDP_ENV]: 'http://localhost:9333' })
		).toEqual({
			httpUrl: 'http://127.0.0.1:9222'
		});
		expect(() => resolveCdpConfig('', {})).toThrow('--cdp needs a URL');
		expect(() => resolveCdpConfig(undefined, { [CDP_ENV]: 'http://10.0.0.2:9222' })).toThrow(
			/host must be/
		);
	});
});

describe('target matching', () => {
	const page = (id: string, url: string, title = ''): CdpTarget => ({
		id,
		type: 'page',
		url,
		title,
		webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}`
	});

	it('normalizes the hash and a trailing slash', () => {
		expect(normalizeTargetUrl('http://localhost:5173/#top')).toBe('http://localhost:5173');
		expect(normalizeTargetUrl('http://localhost:5173/?mcp=1#x')).toBe(
			'http://localhost:5173?mcp=1'
		);
		expect(normalizeTargetUrl('http://localhost:5173/a/b/')).toBe('http://localhost:5173/a/b');
		expect(normalizeTargetUrl('http://localhost:5173/a/b?x=1')).toBe(
			'http://localhost:5173/a/b?x=1'
		);
	});

	it('prefers an exact match, then a loose one; skips non-page targets and pages without a debugger URL', () => {
		const targets: CdpTarget[] = [
			{
				id: 'sw',
				type: 'service_worker',
				url: 'http://localhost:5173/',
				webSocketDebuggerUrl: 'ws://127.0.0.1:9222/sw'
			},
			{ id: 'nows', type: 'page', url: 'http://localhost:5173/' },
			page('a', 'http://localhost:5173/#section'),
			page('b', 'http://localhost:5173/other')
		];
		expect(pickTarget(targets, 'http://localhost:5173/')).toEqual({
			target: targets[2],
			ambiguous: false
		});
		expect(pickTarget(targets, 'http://localhost:5173/other/')?.target.id).toBe('b');
		expect(
			pickTarget(
				[...targets, page('c', 'http://localhost:5173/other/')],
				'http://localhost:5173/other/'
			)?.target.id
		).toBe('c');
		expect(pickTarget(targets, 'http://localhost:5173/missing')).toBeNull();
	});

	it('breaks ties by title and flags ambiguity', () => {
		const targets = [
			page('a', 'http://localhost:5173/', 'One'),
			page('b', 'http://localhost:5173/', 'Two')
		];
		expect(pickTarget(targets, 'http://localhost:5173/', 'Two')).toEqual({
			target: targets[1],
			ambiguous: false
		});
		expect(pickTarget(targets, 'http://localhost:5173/', 'Nope')).toEqual({
			target: targets[0],
			ambiguous: true
		});
	});
});

describe('CdpSession', () => {
	async function open(timeoutMs?: number) {
		let ws!: FakeWebSocket;
		const pending = CdpSession.connect('ws://127.0.0.1:9222/devtools/page/A', {
			createWebSocket: (url) => (ws = new FakeWebSocket(url)),
			timeoutMs
		});
		ws.emit('open');
		return { session: await pending, ws };
	}

	it('sends JSON-RPC with incrementing ids and resolves by id (events ignored)', async () => {
		const { session, ws } = await open();
		const a = session.send('Memory.getDOMCounters');
		const b = session.send('Performance.getMetrics', { x: 1 });
		expect(ws.sent).toEqual([
			{ id: 1, method: 'Memory.getDOMCounters', params: {} },
			{ id: 2, method: 'Performance.getMetrics', params: { x: 1 } }
		]);
		ws.emit('message', { data: JSON.stringify({ method: 'Performance.metrics', params: {} }) });
		ws.emit('message', { data: 'not json' });
		ws.reply(2, { metrics: [] });
		ws.reply(1, { nodes: 10 });
		await expect(a).resolves.toEqual({ nodes: 10 });
		await expect(b).resolves.toEqual({ metrics: [] });
		expect(session.pendingCount).toBe(0);
	});

	it('rejects on a CDP error, on timeout and when the socket closes', async () => {
		vi.useFakeTimers();
		const { session, ws } = await open(1_000);
		const failing = session.send('HeapProfiler.collectGarbage');
		ws.emit('message', {
			data: JSON.stringify({ id: 1, error: { code: -32601, message: 'not found' } })
		});
		await expect(failing).rejects.toThrow('CDP HeapProfiler.collectGarbage failed: not found');

		const slow = session.send('Performance.enable');
		vi.advanceTimersByTime(1_000);
		await expect(slow).rejects.toThrow('CDP Performance.enable did not answer in 1s');

		const cut = session.send('Memory.getDOMCounters');
		ws.emit('close');
		await expect(cut).rejects.toThrow('CDP Memory.getDOMCounters failed: CDP connection closed');
		await expect(session.send('Performance.getMetrics')).rejects.toThrow('connection closed');
	});

	it('close() rejects pending calls and closes the socket', async () => {
		const { session, ws } = await open();
		const p = session.send('Performance.getMetrics');
		session.close();
		await expect(p).rejects.toThrow('CDP session closed');
		expect(ws.closed).toBe(true);
	});

	it('connect rejects on error or timeout before open', async () => {
		let ws!: FakeWebSocket;
		const failed = CdpSession.connect('ws://127.0.0.1:1/x', {
			createWebSocket: (u) => (ws = new FakeWebSocket(u))
		});
		ws.emit('error', { message: 'ECONNREFUSED' });
		await expect(failed).rejects.toThrow(
			'Could not open the CDP WebSocket ws://127.0.0.1:1/x: ECONNREFUSED'
		);

		vi.useFakeTimers();
		const slow = CdpSession.connect('ws://127.0.0.1:1/y', {
			createWebSocket: (u) => new FakeWebSocket(u),
			timeoutMs: 500
		});
		vi.advanceTimersByTime(500);
		await expect(slow).rejects.toThrow('did not open in 0.5s');
	});
});

describe('listTargets / connectToTab', () => {
	const config = { httpUrl: 'http://127.0.0.1:9222' };
	const json = (body: unknown, ok = true): FetchLike =>
		vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }));

	it('lists /json/list and explains how to enable CDP when unreachable', async () => {
		const fetch = json([{ id: 'a', type: 'page', url: 'x' }]);
		expect(await listTargets(config, { fetch })).toHaveLength(1);
		expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
			'http://127.0.0.1:9222/json/list'
		);

		const down: FetchLike = async () => {
			throw new Error('fetch failed');
		};
		await expect(listTargets(config, { fetch: down })).rejects.toThrow(
			/Could not reach Chrome DevTools at http:\/\/127\.0\.0\.1:9222 \(fetch failed\)\. Start Chrome with .*--remote-debugging-port=9222/
		);
		await expect(listTargets(config, { fetch: json({}, false) })).rejects.toThrow('HTTP 500');
		await expect(listTargets(config, { fetch: json({ not: 'a list' }) })).rejects.toThrow(
			'Unexpected /json/list'
		);
	});

	it('connects to the page target matching the tab', async () => {
		const sockets: FakeWebSocket[] = [];
		const fetch = json([
			{
				id: 'other',
				type: 'page',
				url: 'http://localhost:5173/other',
				webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/other'
			},
			{
				id: 'app',
				type: 'page',
				url: 'http://localhost:5173/?mcp=1',
				webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/app'
			}
		]);
		const pending = connectToTab(
			config,
			{ url: 'http://localhost:5173/?mcp=1#top' },
			{
				fetch,
				createWebSocket: (url) => {
					const ws = new FakeWebSocket(url);
					sockets.push(ws);
					queueMicrotask(() => ws.emit('open'));
					return ws;
				}
			}
		);
		const conn = await pending;
		expect(conn.target.id).toBe('app');
		expect(sockets.map((s) => s.url)).toEqual(['ws://127.0.0.1:9222/devtools/page/app']);
		conn.session.close();
	});

	it('refuses a non-loopback webSocketDebuggerUrl and reports a missing target', async () => {
		const createWebSocket = vi.fn();
		const evil = json([
			{
				id: 'x',
				type: 'page',
				url: 'http://localhost:5173/',
				webSocketDebuggerUrl: 'ws://203.0.113.5:9222/devtools/page/x'
			}
		]);
		await expect(
			connectToTab(config, { url: 'http://localhost:5173/' }, { fetch: evil, createWebSocket })
		).rejects.toThrow(/Refusing CDP WebSocket "ws:\/\/203\.0\.113\.5:9222/);
		expect(createWebSocket).not.toHaveBeenCalled();

		const none = json([
			{
				id: 'y',
				type: 'page',
				url: 'http://localhost:5173/b',
				webSocketDebuggerUrl: 'ws://127.0.0.1:9222/p/y'
			}
		]);
		await expect(
			connectToTab(config, { url: 'http://localhost:5173/a' }, { fetch: none })
		).rejects.toThrow(
			/No Chrome page target at http:\/\/127\.0\.0\.1:9222 shows the tab http:\/\/localhost:5173\/a \(page targets: http:\/\/localhost:5173\/b\)/
		);
	});
});
