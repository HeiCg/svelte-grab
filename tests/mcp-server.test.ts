import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { startMcpServer } from '../src/mcp/server.js';
import { DEFAULT_MCP_PORT, MCP_PORT_RANGE_END, MCP_PORT_RANGE_SIZE, MCP_SERVICE_ID } from '../src/mcp/constants.js';

// Real server on 127.0.0.1, ephemeral ports.
const HOST = '127.0.0.1';
const TOKEN = 'server-test-token';
const GOOD_ORIGIN = 'http://localhost:5173';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const PKG_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
	.version;

function listenOn(port: number): Promise<Server> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once('error', reject);
		srv.listen(port, HOST, () => resolve(srv));
	});
}

async function freePort(): Promise<number> {
	const srv = await listenOn(0);
	const { port } = srv.address() as AddressInfo;
	await new Promise<void>((r) => srv.close(() => r()));
	return port;
}

interface HttpResult {
	status: number;
	headers: IncomingHttpHeaders;
	json: any;
}

/**
 * POST/GET with either a Content-Length body or a chunked body (written in
 * 64 KB pieces, no Content-Length), so both overflow paths are exercised.
 */
function send(
	port: number,
	method: string,
	path: string,
	opts: { body?: string; chunked?: boolean; auth?: boolean } = {}
): Promise<HttpResult> {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (opts.auth !== false) {
		headers.origin = GOOD_ORIGIN;
		headers['x-svelte-grab-token'] = TOKEN;
	}
	if (opts.body !== undefined && !opts.chunked) headers['content-length'] = String(Buffer.byteLength(opts.body));
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: HOST, port, method, path, headers, agent: false }, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (c: Buffer) => chunks.push(c));
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString();
				let json: unknown = text;
				try {
					json = JSON.parse(text);
				} catch {
					// keep text
				}
				resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
			});
			res.on('error', reject);
		});
		req.on('error', reject);
		if (opts.body !== undefined) {
			if (opts.chunked) {
				for (let i = 0; i < opts.body.length; i += 64 * 1024) req.write(opts.body.slice(i, i + 64 * 1024));
			} else {
				req.write(opts.body);
			}
		}
		req.end();
	});
}

const saved = { token: process.env.SVELTE_GRAB_TOKEN, origins: process.env.SVELTE_GRAB_ALLOWED_ORIGINS };

beforeAll(() => {
	delete process.env.SVELTE_GRAB_TOKEN;
	delete process.env.SVELTE_GRAB_ALLOWED_ORIGINS;
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
	if (saved.token !== undefined) process.env.SVELTE_GRAB_TOKEN = saved.token;
	if (saved.origins !== undefined) process.env.SVELTE_GRAB_ALLOWED_ORIGINS = saved.origins;
	vi.restoreAllMocks();
});

describe('MCP HTTP server', () => {
	let port: number;
	let preferred: number;
	let close: () => void;

	beforeAll(async () => {
		preferred = await freePort();
		const started = await startMcpServer({ port: preferred, token: TOKEN });
		if (!started) throw new Error('server did not start');
		port = started.port;
		close = started.close;
	});

	afterAll(() => close?.());

	describe('oversized request bodies', () => {
		const cases = [
			{ label: 'Content-Length just over the cap', size: MAX_BODY_BYTES + 10, chunked: false },
			{ label: 'chunked just over the cap', size: MAX_BODY_BYTES + 10, chunked: true },
			{ label: 'Content-Length 10x the cap', size: MAX_BODY_BYTES * 10, chunked: false },
			{ label: 'chunked 10x the cap', size: MAX_BODY_BYTES * 10, chunked: true }
		];

		describe.each(['/context', '/runtime/hello', '/runtime/result', '/mcp'])('POST %s', (path) => {
			it.each(cases)('$label -> 413 JSON, then close (no connection reset)', async ({ size, chunked }) => {
				const body = JSON.stringify({ content: ['x'.repeat(size)] });
				const r = await send(port, 'POST', path, { body, chunked });
				expect(r.status).toBe(413);
				expect(r.json).toEqual({ error: 'Request body too large' });
				expect(r.headers.connection).toBe('close');
			});
		});

		it('keeps serving after refusing an oversized body', async () => {
			await send(port, 'POST', '/context', { body: 'x'.repeat(MAX_BODY_BYTES * 3) });
			const r = await send(port, 'POST', '/context', { body: JSON.stringify({ content: ['after'] }) });
			expect(r.status).toBe(200);
		});

		it('still accepts a body just under the cap', async () => {
			const body = JSON.stringify({ content: ['x'.repeat(MAX_BODY_BYTES - 100)] });
			expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_BODY_BYTES);
			const r = await send(port, 'POST', '/context', { body });
			expect(r.status).toBe(200);
		});
	});

	it('POST /mcp with malformed JSON -> 400 JSON-RPC parse error', async () => {
		const r = await send(port, 'POST', '/mcp', { body: '{nope' });
		expect(r.status).toBe(400);
		expect(r.json).toMatchObject({ jsonrpc: '2.0', error: { code: -32700 }, id: null });
	});

	it('GET /health stays unauthenticated and identifies the server', async () => {
		const r = await send(port, 'GET', '/health', { auth: false });
		expect(r.status).toBe(200);
		expect(r.json).toEqual({
			status: 'ok',
			service: MCP_SERVICE_ID,
			version: PKG_VERSION,
			port,
			preferredPort: preferred,
			portFallback: false,
			hasContext: expect.any(Boolean),
			agentWatching: false,
			watcherCount: 0,
			sseClients: 0
		});
		expect(MCP_SERVICE_ID).toBe('svelte-grab-mcp');
	});
});

describe('MCP port fallback', () => {
	it('exposes the default fallback range 4723-4732', () => {
		expect(DEFAULT_MCP_PORT).toBe(4723);
		expect(MCP_PORT_RANGE_SIZE).toBe(10);
		expect(MCP_PORT_RANGE_END).toBe(4732);
	});

	it('falls back to a later port when busy, logs the mcpPort to use, and reports it on /health', async () => {
		const blocker = await listenOn(0);
		const busy = (blocker.address() as AddressInfo).port;
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const started = await startMcpServer({ port: busy, token: TOKEN });
		try {
			if (!started) throw new Error('server did not start');
			expect(started.port).toBeGreaterThan(busy);
			expect(started.port).toBeLessThan(busy + MCP_PORT_RANGE_SIZE);

			const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
			expect(logged).toContain(`Port ${busy} was in use, using ${started.port} instead`);
			expect(logged).toContain(`page must use mcpPort=${started.port}`);

			const r = await send(started.port, 'GET', '/health', { auth: false });
			expect(r.json).toMatchObject({
				service: MCP_SERVICE_ID,
				port: started.port,
				preferredPort: busy,
				portFallback: true
			});
		} finally {
			started?.close();
			errorSpy.mockRestore();
			await new Promise<void>((r) => blocker.close(() => r()));
		}
	});
});
