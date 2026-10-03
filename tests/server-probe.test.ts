import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	resolveMcpPort,
	isSvelteGrabMcp,
	resetMcpPortCacheForTests
} from '../src/lib/runtime/server-probe.js';
import { MCP_SERVICE_ID } from '../src/lib/runtime/mcp-constants.js';

type Responder = (port: number) => Response | Promise<Response> | 'refused';

/** fetch double: answers `/health` per port; 'refused' rejects like a closed port. */
function healthFetch(responder: Responder) {
	return vi.fn(async (url: string) => {
		const port = Number(new URL(url).port);
		expect(new URL(url).pathname).toBe('/health');
		const out = await responder(port);
		if (out === 'refused') throw new TypeError('Failed to fetch');
		return out;
	});
}

const grab = (port: number) =>
	new Response(JSON.stringify({ status: 'ok', service: MCP_SERVICE_ID, port }), { status: 200 });
const other = () => new Response(JSON.stringify({ status: 'ok', service: 'something-else' }), { status: 200 });

beforeEach(() => resetMcpPortCacheForTests());

describe('isSvelteGrabMcp', () => {
	it('is true only for a 200 whose service is svelte-grab-mcp', async () => {
		expect(await isSvelteGrabMcp('localhost', 4723, healthFetch(grab))).toBe(true);
		expect(await isSvelteGrabMcp('localhost', 4723, healthFetch(other))).toBe(false);
		expect(await isSvelteGrabMcp('localhost', 4723, healthFetch(() => 'refused'))).toBe(false);
		expect(
			await isSvelteGrabMcp('localhost', 4723, healthFetch(() => new Response('nope', { status: 500 })))
		).toBe(false);
		expect(
			await isSvelteGrabMcp('localhost', 4723, healthFetch(() => new Response('<html>', { status: 200 })))
		).toBe(false);
	});

	it('gives up after the timeout', async () => {
		const hanging = vi.fn(
			(_url: string, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
				})
		);
		expect(await isSvelteGrabMcp('localhost', 4723, hanging, 20)).toBe(false);
	});
});

describe('resolveMcpPort', () => {
	it('keeps the configured port when it is svelte-grab, with one request and no log', async () => {
		const fetch = healthFetch(grab);
		const log = vi.fn();
		expect(await resolveMcpPort(4723, { fetch, log })).toBe(4723);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0][0]).toBe('http://localhost:4723/health');
		expect(log).not.toHaveBeenCalled();
	});

	it('probes the range when the configured port is down and picks the first svelte-grab port', async () => {
		const fetch = healthFetch((p) => (p === 4726 || p === 4729 ? grab(p) : 'refused'));
		const log = vi.fn();
		expect(await resolveMcpPort(4723, { fetch, log })).toBe(4726);
		const ports = fetch.mock.calls.map(([url]) => Number(new URL(url).port)).sort();
		expect(ports).toEqual([4723, 4724, 4725, 4726, 4727, 4728, 4729, 4730, 4731, 4732]);
		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0][0]).toContain('using port 4726');
	});

	it('skips a configured port that answers as another service', async () => {
		const fetch = healthFetch((p) => (p === 4723 ? other() : p === 4724 ? grab(p) : 'refused'));
		expect(await resolveMcpPort(4723, { fetch, log: () => {} })).toBe(4724);
	});

	it('stays inside configured .. configured + 9', async () => {
		const fetch = healthFetch((p) => (p === 5010 ? grab(p) : 'refused'));
		expect(await resolveMcpPort(5000, { fetch, log: () => {} })).toBe(5000);
		const ports = fetch.mock.calls.map(([url]) => Number(new URL(url).port));
		expect(Math.max(...ports)).toBe(5009);
	});

	it('caches a found port per page load and logs only once', async () => {
		const fetch = healthFetch((p) => (p === 4725 ? grab(p) : 'refused'));
		const log = vi.fn();
		const [a, b] = await Promise.all([resolveMcpPort(4723, { fetch, log }), resolveMcpPort(4723, { fetch, log })]);
		expect(await resolveMcpPort(4723, { fetch, log })).toBe(4725);
		expect([a, b]).toEqual([4725, 4725]);
		expect(fetch).toHaveBeenCalledTimes(10);
		expect(log).toHaveBeenCalledTimes(1);
	});

	it('falls back to the configured port when nothing answers, and re-probes next time', async () => {
		let up = false;
		const fetch = healthFetch((p) => (up && p === 4727 ? grab(p) : 'refused'));
		const log = vi.fn();
		expect(await resolveMcpPort(4723, { fetch, log })).toBe(4723);
		expect(log).not.toHaveBeenCalled();

		up = true;
		expect(await resolveMcpPort(4723, { fetch, log })).toBe(4727);
		expect(log).toHaveBeenCalledTimes(1);
	});
});
