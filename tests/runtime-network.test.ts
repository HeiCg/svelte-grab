// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
	NETWORK_BODIES_FLAG,
	NETWORK_BUFFER_SIZE,
	NetworkCapture,
	initiatorFromStack,
	installNetworkCapture,
	isOwnTraffic,
	longestChain,
	redactedBodyExcerpt,
	releaseEarlyNetworkCapture,
	summarizeNetwork,
	typeFromResource,
	uiNetwork,
	uiNetworkReload,
	urlTags,
	type NetworkEntry
} from '../src/lib/runtime/network.js';

/** Fake credentials, assembled at runtime (never a literal secret in the repo). */
const FAKE_STRIPE = 'sk_' + 'test_' + 'FAKEfake0000FAKEfake0000';
const b64url = (s: string) => Buffer.from(s).toString('base64url');
const FAKE_JWT = `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url('{"sub":"fake-user","iat":1700000000}')}.FAKEsignatureFAKE0000`;

// ------------------------------------------------------------------ real HTTP server

let server: Server;
let origin = '';
const seenHeaders: Record<string, string | string[] | undefined>[] = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Headers', '*');
		res.setHeader('Access-Control-Expose-Headers', '*');
		if (req.method === 'OPTIONS') {
			res.writeHead(204);
			res.end();
			return;
		}
		seenHeaders.push(req.headers);
		if (req.url?.startsWith('/json')) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: true, user: { name: 'Ada', password: 'fake-pass-1234' } }));
			return;
		}
		if (req.url?.startsWith('/stream')) {
			// chunked, no content-length
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			res.write('part1-');
			setTimeout(() => res.end('part2'), 20);
			return;
		}
		if (req.url?.startsWith('/missing')) {
			res.writeHead(404, { 'Content-Type': 'text/plain' });
			res.end('nope');
			return;
		}
		res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '5' });
		res.end('hello');
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ------------------------------------------------------------------ fake window

interface FakeWindow {
	fetch: typeof fetch;
	XMLHttpRequest: typeof XMLHttpRequest;
	navigator: { sendBeacon?: (url: string, data?: unknown) => boolean };
	WebSocket?: unknown;
	EventSource?: unknown;
	location: { href: string };
	performance: { now(): number; timeOrigin: number; getEntriesByType(type: string): unknown[] };
	sessionStorage: Storage;
}

function makeWindow(overrides: Partial<FakeWindow> = {}): FakeWindow {
	const resources: unknown[] = [];
	return {
		fetch: globalThis.fetch,
		XMLHttpRequest: window.XMLHttpRequest,
		navigator: { sendBeacon: () => true },
		location: { href: `${origin}/page` },
		performance: {
			now: () => performance.now(),
			timeOrigin: 1_700_000_000_000,
			getEntriesByType: (type: string) => (type === 'resource' ? resources : [])
		},
		sessionStorage: window.sessionStorage,
		...overrides
	};
}

function captureFor(win: FakeWindow, size?: number): NetworkCapture {
	return new NetworkCapture({ target: win as unknown as Window, size });
}

beforeEach(() => {
	seenHeaders.length = 0;
	sessionStorage.clear();
});

// ------------------------------------------------------------------ fetch

describe('network capture: fetch wrapper is transparent', () => {
	it('same Response, body readable by the app, request recorded with initiator and headers', async () => {
		const win = makeWindow();
		const original = win.fetch;
		const capture = captureFor(win);
		capture.retain();
		expect(win.fetch).not.toBe(original);

		const res = await win.fetch(`${origin}/json?x=1`, { method: 'post', headers: { Authorization: `Bearer ${FAKE_JWT}` }, body: '{"a":1}' });
		expect(res).toBeInstanceOf(Response);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, user: { name: 'Ada', password: 'fake-pass-1234' } });
		expect(seenHeaders[0].authorization).toBe(`Bearer ${FAKE_JWT}`);

		const [e] = capture.entries();
		expect(e).toMatchObject({ type: 'fetch', method: 'POST', url: `${origin}/json?x=1`, status: 200, wrapped: true });
		expect(e.requestHeaders.authorization).toBe(`Bearer ${FAKE_JWT}`);
		expect(e.requestBody).toBe('{"a":1}');
		expect(e.requestBodySize).toBe(7);
		expect(e.contentType).toMatch(/json/);
		expect(e.initiator?.file).toMatch(/tests\/runtime-network\.test\.ts$/);
		expect(e.responseBody).toBeNull(); // bodies off by default
		capture.release();
		expect(win.fetch).toBe(original);
	});

	it('streaming bodies are untouched (no content-length, read by the app chunk by chunk)', async () => {
		const win = makeWindow();
		const capture = captureFor(win);
		capture.retain();
		const res = await win.fetch(`${origin}/stream`);
		expect(await res.text()).toBe('part1-part2');
		capture.release();
	});

	it('rejections propagate with the same error, and are recorded', async () => {
		const boom = new TypeError('Failed to fetch');
		const win = makeWindow({ fetch: (() => Promise.reject(boom)) as unknown as typeof fetch });
		const capture = captureFor(win);
		capture.retain();
		await expect(win.fetch('/x')).rejects.toBe(boom);
		expect(capture.entries()[0]).toMatchObject({ status: 0, error: 'TypeError: Failed to fetch' });
		capture.release();
	});

	it('a real network error propagates as the native TypeError', async () => {
		const win = makeWindow();
		const capture = captureFor(win);
		capture.retain();
		await expect(win.fetch('http://127.0.0.1:1/unreachable')).rejects.toThrow(TypeError);
		expect(capture.entries()[0].status).toBe(0);
		capture.release();
	});

	it('synchronous throws from the original fetch propagate', () => {
		const err = new TypeError('Invalid URL');
		const win = makeWindow({
			fetch: (() => {
				throw err;
			}) as unknown as typeof fetch
		});
		const capture = captureFor(win);
		capture.retain();
		expect(() => win.fetch('::bad')).toThrow(err);
		capture.release();
	});

	it('forwards the exact arguments and this', async () => {
		const calls: { self: unknown; args: unknown[] }[] = [];
		const res = new Response('ok');
		const win = makeWindow({
			fetch: function (this: unknown, ...args: unknown[]) {
				calls.push({ self: this, args });
				return Promise.resolve(res);
			} as unknown as typeof fetch
		});
		const capture = captureFor(win);
		capture.retain();
		const init = { method: 'GET' };
		expect(await win.fetch('/a', init)).toBe(res);
		expect(calls[0].args).toEqual(['/a', init]);
		expect(calls[0].args[1]).toBe(init);
		expect(calls[0].self).toBe(win);
		capture.release();
	});

	it('does not clone/read bodies unless body capture is on; then same-origin JSON only', async () => {
		const make = (ct: string) => {
			const r = new Response('{"token":"x"}', { headers: { 'content-type': ct } });
			return Object.assign(r, { clone: vi.fn(() => new Response('{"token":"abcdefgh-fake"}')) });
		};
		let next = make('application/json');
		const win = makeWindow({ fetch: (() => Promise.resolve(next)) as unknown as typeof fetch });
		const capture = captureFor(win);
		capture.retain();
		await win.fetch('/api');
		expect(next.clone).not.toHaveBeenCalled();

		capture.bodies = true;
		next = make('application/json');
		await win.fetch('/api');
		expect(next.clone).toHaveBeenCalledTimes(1);
		await new Promise((r) => setTimeout(r, 0));
		expect(capture.entries()[1].responseBody).toBe('{"token":"abcdefgh-fake"}');

		next = make('application/json');
		await win.fetch('https://third.example/api');
		expect(next.clone).not.toHaveBeenCalled();
		next = make('text/html');
		await win.fetch('/page');
		expect(next.clone).not.toHaveBeenCalled();
		capture.release();
	});

	it('a wrapper installed after ours stays in the chain on release (ours becomes inert)', async () => {
		const win = makeWindow({ fetch: (() => Promise.resolve(new Response('a'))) as unknown as typeof fetch });
		const capture = captureFor(win);
		capture.retain();
		const ours = win.fetch;
		const theirs = ((...args: Parameters<typeof fetch>) => ours(...args)) as typeof fetch;
		win.fetch = theirs;
		capture.release();
		expect(win.fetch).toBe(theirs);
		await win.fetch('/after');
		expect(capture.entries()).toHaveLength(0);
	});

	it('skips svelte-grab own traffic (MCP server, plugin endpoints)', async () => {
		const win = makeWindow({ fetch: (() => Promise.resolve(new Response('{}'))) as unknown as typeof fetch });
		const capture = captureFor(win);
		capture.retain();
		await win.fetch('http://localhost:4723/runtime/hello', { method: 'POST' });
		await win.fetch('http://127.0.0.1:4799/health');
		await win.fetch('/__svelte-grab/importers?file=x');
		await win.fetch('/api/real');
		expect(capture.entries().map((e) => e.url)).toEqual([`${origin}/api/real`]);
		capture.release();
	});
});

// ------------------------------------------------------------------ XHR

function xhrRequest(
	XHR: typeof XMLHttpRequest,
	method: string,
	url: string,
	headers: Record<string, string> = {},
	body?: string
): Promise<{ xhr: XMLHttpRequest; event: string }> {
	return new Promise((resolve) => {
		const xhr = new XHR();
		xhr.open(method, url);
		for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
		xhr.onload = () => resolve({ xhr, event: 'load' });
		xhr.onerror = () => resolve({ xhr, event: 'error' });
		xhr.send(body);
	});
}

describe('network capture: XHR wrapper is transparent', () => {
	it('real request still works (status, responseText, headers) and is recorded', async () => {
		const win = makeWindow();
		const proto = win.XMLHttpRequest.prototype;
		const { open, send, setRequestHeader } = proto;
		const capture = captureFor(win);
		capture.retain();
		expect(proto.open).not.toBe(open);

		const { xhr, event } = await xhrRequest(win.XMLHttpRequest, 'POST', `${origin}/json`, { 'X-Api-Key': 'abcdefgh-fake-key' }, 'a=1');
		expect(event).toBe('load');
		expect(xhr.status).toBe(200);
		expect(JSON.parse(xhr.responseText).ok).toBe(true);
		expect(seenHeaders[0]['x-api-key']).toBe('abcdefgh-fake-key');
		await new Promise((r) => setTimeout(r, 0));

		const e = capture.entries().find((x) => x.type === 'xhr')!;
		expect(e).toMatchObject({ method: 'POST', url: `${origin}/json`, status: 200, requestBody: 'a=1' });
		expect(e.requestHeaders['x-api-key']).toBe('abcdefgh-fake-key');
		expect(e.initiator?.file).toMatch(/runtime-network\.test\.ts$/);

		capture.release();
		expect(proto.open).toBe(open);
		expect(proto.send).toBe(send);
		expect(proto.setRequestHeader).toBe(setRequestHeader);
	});

	it('errors still reach the app (onerror) and are recorded', async () => {
		const win = makeWindow();
		const capture = captureFor(win);
		capture.retain();
		const { event, xhr } = await xhrRequest(win.XMLHttpRequest, 'GET', 'http://127.0.0.1:1/down');
		expect(event).toBe('error');
		expect(xhr.status).toBe(0);
		await new Promise((r) => setTimeout(r, 0));
		expect(capture.entries()[0]).toMatchObject({ type: 'xhr', status: 0 });
		capture.release();
	});

	it('setRequestHeader before open still throws like the native one', () => {
		const win = makeWindow();
		const capture = captureFor(win);
		capture.retain();
		const xhr = new win.XMLHttpRequest();
		expect(() => xhr.setRequestHeader('a', 'b')).toThrow();
		capture.release();
	});
});

// ------------------------------------------------------------------ beacon / sockets

describe('network capture: sendBeacon, WebSocket, EventSource', () => {
	it('sendBeacon returns the original result and is restored', () => {
		const beacon = vi.fn(() => false);
		const nav = Object.create({ sendBeacon: beacon }) as FakeWindow['navigator'];
		const win = makeWindow({ navigator: nav });
		const capture = captureFor(win);
		capture.retain();
		expect(Object.prototype.hasOwnProperty.call(nav, 'sendBeacon')).toBe(true);
		expect(nav.sendBeacon!('/collect', 'a=1')).toBe(false);
		expect(beacon).toHaveBeenCalledWith('/collect', 'a=1');
		expect(capture.entries()[0]).toMatchObject({ type: 'beacon', method: 'POST', status: 0, requestBody: 'a=1' });
		capture.release();
		expect(Object.prototype.hasOwnProperty.call(nav, 'sendBeacon')).toBe(false);
		expect(nav.sendBeacon).toBe(beacon);
	});

	it('WebSocket proxy keeps statics, instanceof and subclassing; counts messages', () => {
		class FakeWS extends EventTarget {
			static OPEN = 1;
			url: string;
			sent: unknown[] = [];
			constructor(url: string) {
				super();
				this.url = url;
			}
			send(data: unknown) {
				this.sent.push(data);
			}
		}
		const win = makeWindow({ WebSocket: FakeWS });
		const capture = captureFor(win);
		capture.retain();
		const WS = win.WebSocket as typeof FakeWS;
		expect(WS).not.toBe(FakeWS);
		expect(WS.OPEN).toBe(1);
		const ws = new WS('ws://127.0.0.1:9999/live');
		expect(ws).toBeInstanceOf(FakeWS);
		expect(ws).toBeInstanceOf(WS);
		expect(ws.url).toBe('ws://127.0.0.1:9999/live');
		ws.send('hello');
		expect(ws.sent).toEqual(['hello']);
		ws.dispatchEvent(Object.assign(new Event('message'), { data: 'abc' }));
		class Sub extends WS {}
		expect(new Sub('ws://x/y')).toBeInstanceOf(Sub);
		const e = capture.entries()[0];
		expect(e).toMatchObject({ type: 'websocket', method: 'WS', messages: { sent: 1, received: 1, bytesSent: 5, bytesReceived: 3 } });
		capture.release();
		expect(win.WebSocket).toBe(FakeWS);
		expect(FakeWS.prototype.send).toBeTypeOf('function');
		new FakeWS('ws://x').send('after');
		expect(capture.entries()).toHaveLength(2); // Sub was recorded; nothing after release
	});

	it('EventSource proxy records the stream', () => {
		class FakeES extends EventTarget {
			constructor(public url: string) {
				super();
			}
		}
		const win = makeWindow({ EventSource: FakeES });
		const capture = captureFor(win);
		capture.retain();
		const es = new (win.EventSource as typeof FakeES)('/stream');
		expect(es).toBeInstanceOf(FakeES);
		expect(capture.entries()[0]).toMatchObject({ type: 'eventsource', url: `${origin}/stream` });
		capture.release();
	});
});

// ------------------------------------------------------------------ buffer, resources, lifecycle

describe('network capture: buffer, resource timing, lifecycle', () => {
	it('ring buffer keeps the last N', () => {
		const capture = captureFor(makeWindow(), 5);
		for (let i = 0; i < 8; i++) capture.record({ type: 'fetch', url: `${origin}/r${i}` });
		expect(capture.entries().map((e) => e.url.split('/').pop())).toEqual(['r3', 'r4', 'r5', 'r6', 'r7']);
		expect(NETWORK_BUFFER_SIZE).toBe(500);
	});

	it('merges resource timing into the wrapper entry; adds other resources once', () => {
		const resources: unknown[] = [];
		const win = makeWindow({ fetch: (() => Promise.resolve(new Response('{}'))) as unknown as typeof fetch });
		win.performance.getEntriesByType = (t: string) => (t === 'resource' ? resources : []);
		const capture = captureFor(win);
		capture.retain();
		const fetched = capture.record({ type: 'fetch', url: `${origin}/api/a`, start: 100 });
		resources.push(
			{ name: `${origin}/api/a`, initiatorType: 'fetch', startTime: 101, duration: 50, responseEnd: 151, transferSize: 900, encodedBodySize: 600, decodedBodySize: 800, responseStatus: 200 },
			{ name: `${origin}/assets/app.css`, initiatorType: 'link', startTime: 5, duration: 10, responseEnd: 15, transferSize: 300, encodedBodySize: 280, decodedBodySize: 280 },
			{ name: 'https://fonts.example/f.woff2', initiatorType: 'css', startTime: 20, duration: 10, responseEnd: 30, transferSize: 0, encodedBodySize: 0, decodedBodySize: 0 },
			{ name: 'http://localhost:4723/runtime/result', initiatorType: 'fetch', startTime: 30, duration: 1, responseEnd: 31, transferSize: 10, encodedBodySize: 2, decodedBodySize: 2 }
		);
		const list = capture.entries();
		capture.entries(); // idempotent
		expect(capture.entries()).toHaveLength(3);
		const merged = list.find((e) => e.id === fetched.id)!;
		expect(merged).toMatchObject({ timed: true, transferSize: 900, bodySize: 800, end: 151, status: 200 });
		expect(list.find((e) => e.url.endsWith('app.css'))).toMatchObject({ type: 'stylesheet', wrapped: false });
		expect(list.find((e) => e.url.endsWith('f.woff2'))).toMatchObject({ type: 'font' });
		capture.release();
	});

	it('installNetworkCapture holds early; the runtime retain survives releaseEarly', () => {
		const win = makeWindow();
		const original = win.fetch;
		const capture = captureFor(win);
		installNetworkCapture({ capture, dev: false });
		expect(capture.active).toBe(false); // not the Vite dev server
		installNetworkCapture({ capture, dev: true });
		installNetworkCapture({ capture, dev: true }); // idempotent
		expect(capture.active).toBe(true);
		capture.retain(); // runtime start
		releaseEarlyNetworkCapture(capture);
		releaseEarlyNetworkCapture(capture);
		expect(capture.active).toBe(true);
		expect(win.fetch).not.toBe(original);
		capture.release(); // runtime stop
		expect(capture.active).toBe(false);
		expect(win.fetch).toBe(original);

		installNetworkCapture({ capture, dev: true });
		releaseEarlyNetworkCapture(capture); // no runtime: restored right away
		expect(win.fetch).toBe(original);
	});

	it('the sessionStorage flag (set before a reload) turns body capture on at install', () => {
		sessionStorage.setItem(NETWORK_BODIES_FLAG, '1');
		const capture = captureFor(makeWindow());
		capture.retain();
		expect(capture.bodies).toBe(true);
		expect(sessionStorage.getItem(NETWORK_BODIES_FLAG)).toBeNull();
		capture.release();
	});
});

// ------------------------------------------------------------------ helpers

describe('network helpers', () => {
	it('urlTags: SvelteKit 3 data, route resolution, remote functions, Vite internals', () => {
		expect(urlTags('http://x/blog/__data.json?x-sveltekit-invalidated=01')).toEqual(['sveltekit-data']);
		expect(urlTags('http://x/about.html__data.json')).toEqual(['sveltekit-data']);
		expect(urlTags('http://x/blog/__route.js')).toEqual(['sveltekit-route']);
		expect(urlTags('http://x/_app/remote/abc123/getPosts')).toEqual(['remote-function']);
		expect(urlTags('http://x/node_modules/.vite/deps/svelte.js?v=1')).toEqual(['vite-dev']);
		expect(urlTags('http://x/api/users')).toEqual([]);
	});

	it('isOwnTraffic', () => {
		const page = 'http://localhost:5173/';
		expect(isOwnTraffic('http://localhost:4723/events', page)).toBe(true);
		expect(isOwnTraffic('http://127.0.0.1:4730/runtime/result', page)).toBe(true);
		expect(isOwnTraffic('http://localhost:5173/__open-in-editor?file=a', page)).toBe(true);
		expect(isOwnTraffic('http://localhost:5173/health', page)).toBe(false); // the app's own endpoint
		expect(isOwnTraffic('https://api.example.com/health', page)).toBe(false);
	});

	it('initiatorFromStack: first app frame, own/vendor frames skipped, component from .svelte', () => {
		const stack = [
			'Error',
			'    at NetworkCapture.startFetch (http://localhost:5173/@fs/repo/src/lib/runtime/network.ts:300:10)',
			'    at fetch (http://localhost:5173/@fs/repo/src/lib/runtime/network.ts:280:5)',
			'    at load (http://localhost:5173/node_modules/.vite/deps/chunk-XYZ.js?v=1:10:3)',
			'    at api (http://localhost:5173/src/lib/api.ts?t=123:12:9)',
			'    at HTMLButtonElement.save (http://localhost:5173/src/components/Profile.svelte:40:5)'
		].join('\n');
		expect(initiatorFromStack(stack)).toEqual({ file: 'src/lib/api.ts', line: 12, column: 9, component: 'Profile' });
		expect(initiatorFromStack('Error\n    at x (http://localhost:5173/src/lib/runtime/network.ts:1:1)')).toBeNull();
		expect(initiatorFromStack(undefined)).toBeNull();
	});

	it('typeFromResource', () => {
		expect(typeFromResource('script', 'http://x/a.js')).toBe('script');
		expect(typeFromResource('link', 'http://x/a.css?v=1')).toBe('stylesheet');
		expect(typeFromResource('img', 'http://x/a')).toBe('image');
		expect(typeFromResource('other', 'http://x/f.woff2')).toBe('font');
		expect(typeFromResource('xmlhttprequest', 'http://x/a')).toBe('xhr');
		expect(typeFromResource('other', 'http://x/thing')).toBe('other');
	});

	it('redactedBodyExcerpt redacts sensitive keys and secret-shaped values', () => {
		const out = redactedBodyExcerpt(JSON.stringify({ user: { name: 'Ada', password: 'fake-pass-1234' }, t: FAKE_JWT }));
		expect(out).toContain('"name":"Ada"');
		expect(out).not.toContain('fake-pass-1234');
		expect(out).not.toContain(FAKE_JWT);
		expect(out).toMatch(/"password":"password:fa…\(len 14, sha [0-9a-f]{6}\)"/);
	});
});

// ------------------------------------------------------------------ summary + ui_network

function entry(partial: Partial<NetworkEntry> & Pick<NetworkEntry, 'id' | 'url'>): NetworkEntry {
	return {
		type: 'fetch',
		wrapped: true,
		method: 'GET',
		start: 0,
		end: 10,
		status: 200,
		error: null,
		transferSize: 100,
		bodySize: 100,
		contentType: null,
		initiator: null,
		initiatorType: null,
		tags: [],
		requestHeaders: {},
		requestBody: null,
		requestBodySize: null,
		responseBody: null,
		timed: false,
		...partial
	};
}

describe('summarizeNetwork / ui_network', () => {
	const page = 'http://localhost:5173/';
	const init = { file: 'src/components/LeakyRequests.svelte', line: 12, column: 3, component: 'LeakyRequests' };
	const list = [
		entry({ id: 1, type: 'document', url: page, start: 0, end: 5 }),
		entry({ id: 2, url: `http://localhost:5173/api/mock?api_key=${FAKE_STRIPE}`, start: 10, end: 40, initiator: init }),
		entry({ id: 3, url: 'http://localhost:5173/api/items', start: 41, end: 80, initiator: init }),
		entry({ id: 4, url: 'http://localhost:5173/api/items', start: 81, end: 300, initiator: init }),
		entry({ id: 5, method: 'POST', url: 'https://third-party.example/collect', start: 70, end: 95, status: 500, transferSize: 0, bodySize: 20 }),
		entry({ id: 6, url: 'http://localhost:5173/blog/__data.json', start: 400, end: 420, tags: ['sveltekit-data'] })
	];

	it('totals, origins, duplicates, slowest, waterfall, failed, per-request lines; URLs redacted', () => {
		const { text, data } = summarizeNetwork(list, page);
		expect(text).toMatch(/^NETWORK 6 requests, 520B transferred, 5 first-party \/ 1 third-party \(fetch 5, document 1\)/);
		expect(text).toContain('third-party https://third-party.example 1 req 20B');
		expect(text).toMatch(/DUPLICATES 1\n {2}x2 GET http:\/\/localhost:5173\/api\/items <- src\/components\/LeakyRequests\.svelte:12 \(LeakyRequests\)/);
		expect(text).toMatch(/SLOWEST\n {2}#4 219ms GET/);
		expect(text).toMatch(/WATERFALL sequential chain of 3/);
		expect(text).toMatch(/FAILED 1\n {2}#5 500 POST https:\/\/third-party\.example\/collect/);
		expect(text).toMatch(/#2 GET 200 fetch 100B 30ms http:\/\/localhost:5173\/api\/mock\?api_key=stripe-secret-key:sk_t…\(len \d+, sha [0-9a-f]{6}\) <- src\/components\/LeakyRequests\.svelte:12 \(LeakyRequests\)/);
		expect(text).toContain('[sveltekit-data]');
		expect(text).toContain('(third-party)');
		expect(text).not.toContain(FAKE_STRIPE);
		expect(JSON.stringify(data)).not.toContain(FAKE_STRIPE);
		expect(data!.totals).toEqual({ count: 6, bytes: 520, firstParty: 5, thirdParty: 1 });
		expect(data!.duplicates).toEqual([expect.objectContaining({ count: 2, ids: [3, 4] })]);
		expect(data!.failed).toEqual([5]);
	});

	it('longestChain only links requests fired right after another finished', () => {
		expect(longestChain(list).map((e) => e.id)).toEqual([2, 3, 4]);
		expect(longestChain([list[1]])).toEqual([]);
	});

	it('ui_network: since, filter, waitMs, includeBodies, reload refusal, afterTimeOrigin', async () => {
		const win = makeWindow();
		const capture = captureFor(win);
		capture.retain();
		capture.record({ type: 'fetch', url: `${origin}/api/a`, start: 10, end: 20, status: 200, responseBody: JSON.stringify({ secret: 'fake-secret-value' }) });
		capture.record({ type: 'fetch', url: 'https://other.example/x', start: 2_000, end: 2_010, status: 404 });
		const pageUrl = `${origin}/page`;
		const sleep = vi.fn(async () => {});

		const all = await uiNetwork({}, { capture, pageUrl, sleep });
		expect(all.data!.totals).toMatchObject({ count: 2 });
		expect(sleep).not.toHaveBeenCalled();

		const late = await uiNetwork({ since: capture.timeOrigin + 1_000, waitMs: 50 }, { capture, pageUrl, sleep });
		expect(late.data!.totals).toMatchObject({ count: 1 });
		expect(sleep).toHaveBeenCalledWith(50);

		expect((await uiNetwork({ filter: { origin: 'third-party' } }, { capture, pageUrl })).data!.totals).toMatchObject({ count: 1 });
		expect((await uiNetwork({ filter: { status: 'failed' } }, { capture, pageUrl })).data!.totals).toMatchObject({ count: 1 });
		expect((await uiNetwork({ filter: { status: '4xx', type: ['fetch'] } }, { capture, pageUrl })).data!.totals).toMatchObject({ count: 1 });
		await expect(uiNetwork({ filter: { type: ['nope'] } }, { capture, pageUrl })).rejects.toThrow(/Unknown filter.type/);

		const bodies = await uiNetwork({ includeBodies: true }, { capture, pageUrl });
		expect(bodies.text).toMatch(/body: \{"secret":"secret:fake…\(len 17, sha [0-9a-f]{6}\)"\}/);
		expect(bodies.text).not.toContain('fake-secret-value');
		expect(bodies.text).toContain('Bodies are captured from now on');
		expect(capture.bodies).toBe(true);

		await expect(uiNetwork({ reload: true }, { capture, pageUrl })).rejects.toThrow(/orchestrated by the MCP server/);
		await expect(uiNetwork({ afterTimeOrigin: capture.timeOrigin }, { capture, pageUrl })).rejects.toThrow('page has not reloaded yet');
		expect((await uiNetwork({ afterTimeOrigin: capture.timeOrigin - 1 }, { capture, pageUrl })).data!.timeOrigin).toBe(capture.timeOrigin);
		await expect(uiNetwork({ since: 'yesterday' }, { capture, pageUrl })).rejects.toThrow(/"since"/);
		capture.release();
	});

	it('ui_network_reload persists the bodies flag and schedules the reload after replying', () => {
		vi.useFakeTimers();
		try {
			const reload = vi.fn();
			const capture = captureFor(makeWindow());
			const out = uiNetworkReload({ includeBodies: true }, { capture, reload, delayMs: 100 });
			expect(out.data).toEqual({ reloading: true, timeOrigin: 1_700_000_000_000 });
			expect(sessionStorage.getItem(NETWORK_BODIES_FLAG)).toBe('1');
			expect(reload).not.toHaveBeenCalled();
			vi.advanceTimersByTime(100);
			expect(reload).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
