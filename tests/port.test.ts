import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server, type AddressInfo } from 'node:net';
import { findAvailablePort, validatePort } from '../src/utils/port.js';

/**
 * findAvailablePort binds its probe to the IPv4 loopback host (127.0.0.1) so
 * the check matches the real loopback-only server bind. Tests must occupy the
 * SAME host/port for EADDRINUSE to be observed.
 */
const HOST = '127.0.0.1';

function listenOn(port: number): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(port, HOST, () => resolve(server));
	});
}

function portOf(server: Server): number {
	return (server.address() as AddressInfo).port;
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

describe('findAvailablePort', () => {
	const openServers: Server[] = [];

	function track(s: Server): Server {
		openServers.push(s);
		return s;
	}

	afterEach(async () => {
		while (openServers.length) {
			const s = openServers.pop();
			if (s) await close(s);
		}
	});

	it('returns the preferred port when it is free', async () => {
		// Bind to obtain a genuinely free port, then release it.
		const probe = await listenOn(0);
		const freePort = portOf(probe);
		await close(probe);

		const port = await findAvailablePort(freePort);
		expect(port).toBe(freePort);
	});

	it('increments to the next free port when the preferred one is in use', async () => {
		const busy = track(await listenOn(0));
		const base = portOf(busy);

		const port = await findAvailablePort(base);
		expect(port).toBe(base + 1);
	});

	it('skips multiple consecutive busy ports', async () => {
		const busy1 = track(await listenOn(0));
		const base = portOf(busy1);
		track(await listenOn(base + 1));

		const port = await findAvailablePort(base, 10);
		expect(port).toBe(base + 2);
	});

	it('rejects after exhausting maxAttempts', async () => {
		// Occupy base and base+1 on the loopback host. With maxAttempts=1 the
		// search tries base (busy) -> increments once to base+1 (busy) -> rejects.
		const busy1 = track(await listenOn(0));
		const base = portOf(busy1);
		track(await listenOn(base + 1));

		await expect(findAvailablePort(base, 1)).rejects.toMatchObject({
			code: 'EADDRINUSE'
		});
	});
});

describe('validatePort', () => {
	it('accepts a valid integer port', () => {
		expect(validatePort(8080, 3000)).toBe(8080);
		expect(validatePort(1, 3000)).toBe(1);
		expect(validatePort(65535, 3000)).toBe(65535);
	});

	it('parses a numeric string', () => {
		expect(validatePort('4321', 3000)).toBe(4321);
	});

	it('falls back for out-of-range or non-integer values', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(validatePort(0, 3000)).toBe(3000);
		expect(validatePort(70000, 3000)).toBe(3000);
		expect(validatePort(3.5, 3000)).toBe(3000);
		expect(validatePort('abc', 3000)).toBe(3000);
		warn.mockRestore();
	});

	it('falls back silently for undefined/null/empty without warning', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(validatePort(undefined, 3000)).toBe(3000);
		expect(validatePort(null, 3000)).toBe(3000);
		expect(validatePort('', 3000)).toBe(3000);
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});
