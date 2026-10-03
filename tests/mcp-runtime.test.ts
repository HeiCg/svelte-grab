import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { TabRegistry, TAB_EXPIRY_MS, type TabHello } from '../src/mcp/runtime/tab-registry.js';
import {
	CommandChannel,
	DEFAULT_COMMAND_TIMEOUT_MS,
	MAX_COMMAND_TIMEOUT_MS,
	MAX_PENDING_COMMANDS,
	NO_TAB_MESSAGE,
	resolveTimeoutMs,
	type RuntimeCommandMessage
} from '../src/mcp/runtime/command-channel.js';
import { parseHelloPayload, parseResultPayload, MAX_ID_LENGTH } from '../src/mcp/runtime/validate.js';
import {
	forwardToPage,
	registerRuntimeTools,
	splitForwardArgs,
	toToolResult,
	uiTabs,
	type McpToolConfig,
	type McpToolHandler
} from '../src/mcp/runtime/tools.js';
import { startMcpServer, sendRuntimeCommand } from '../src/mcp/server.js';

const hello = (tabId: string, focused = false, extra: Partial<TabHello> = {}): TabHello => ({
	tabId,
	url: `http://localhost:5173/${tabId}`,
	title: `Tab ${tabId}`,
	focused,
	...extra
});

function clock(start = 1_000_000) {
	let t = start;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		}
	};
}

// ============================================================
// Tab registry
// ============================================================
describe('TabRegistry', () => {
	it('registers tabs and lists them most recently seen first', () => {
		const c = clock();
		const reg = new TabRegistry({ now: c.now });
		reg.hello(hello('a'));
		c.advance(10);
		reg.hello(hello('b'));
		expect(reg.list().map((t) => t.tabId)).toEqual(['b', 'a']);
		c.advance(10);
		reg.hello(hello('a'));
		expect(reg.list().map((t) => t.tabId)).toEqual(['a', 'b']);
		expect(reg.get('a')?.lastSeen).toBe(c.now());
	});

	it('forgets tabs not seen for 45s', () => {
		const c = clock();
		const reg = new TabRegistry({ now: c.now });
		expect(TAB_EXPIRY_MS).toBe(45_000);
		reg.hello(hello('a'));
		c.advance(45_000);
		expect(reg.get('a')).toBeDefined();
		c.advance(1);
		expect(reg.get('a')).toBeUndefined();
		expect(reg.size).toBe(0);
	});

	it('a heartbeat keeps the tab alive', () => {
		const c = clock();
		const reg = new TabRegistry({ now: c.now });
		reg.hello(hello('a'));
		for (let i = 0; i < 6; i++) {
			c.advance(15_000);
			reg.hello(hello('a'));
		}
		expect(reg.get('a')).toBeDefined();
	});

	it('active tab = most recently seen when nothing was focused', () => {
		const c = clock();
		const reg = new TabRegistry({ now: c.now });
		expect(reg.active()).toBeUndefined();
		reg.hello(hello('a'));
		reg.hello(hello('b'));
		expect(reg.active()?.tabId).toBe('b');
	});

	it('active tab = most recent focused:true hello, even after it blurs or others heartbeat', () => {
		const c = clock();
		const reg = new TabRegistry({ now: c.now });
		reg.hello(hello('a', true));
		reg.hello(hello('b', false));
		expect(reg.active()?.tabId).toBe('a');
		// user switches to the editor: tab a blurs, b heartbeats
		reg.hello(hello('a', false));
		reg.hello(hello('b', false));
		expect(reg.active()?.tabId).toBe('a');
		expect(reg.get('a')?.focused).toBe(false);
		// b gets focus -> b wins
		reg.hello(hello('b', true));
		expect(reg.active()?.tabId).toBe('b');
	});

	it('falls back to most recently seen when the focused tab expires', () => {
		const c = clock();
		const reg = new TabRegistry({ now: c.now });
		reg.hello(hello('a', true));
		c.advance(30_000);
		reg.hello(hello('b'));
		reg.hello(hello('c'));
		c.advance(20_000); // a last seen 50s ago
		expect(reg.active()?.tabId).toBe('c');
	});

	it('summaries carry the active flag', () => {
		const reg = new TabRegistry();
		reg.hello(hello('a', true));
		reg.hello(hello('b'));
		const summaries = reg.summaries();
		expect(summaries).toHaveLength(2);
		expect(summaries.find((t) => t.tabId === 'a')).toMatchObject({ active: true, focused: true, title: 'Tab a' });
		expect(summaries.find((t) => t.tabId === 'b')).toMatchObject({ active: false, focused: false });
	});

	it('caps tracked tabs, evicting the least recently seen', () => {
		const reg = new TabRegistry({ maxTabs: 2 });
		reg.hello(hello('a'));
		reg.hello(hello('b'));
		reg.hello(hello('a'));
		reg.hello(hello('c'));
		expect(reg.list().map((t) => t.tabId).sort()).toEqual(['a', 'c']);
	});
});

// ============================================================
// Payload validation
// ============================================================
describe('parseHelloPayload', () => {
	it('accepts the contract shape', () => {
		const r = parseHelloPayload({ tabId: 't1', url: 'http://localhost:5173/', title: 'App', focused: true, extra: 1 });
		expect(r).toEqual({ ok: true, value: { tabId: 't1', url: 'http://localhost:5173/', title: 'App', focused: true } });
	});

	it.each([
		['null', null],
		['array', [1]],
		['string', 'x'],
		['missing tabId', { url: '', title: '', focused: true }],
		['empty tabId', { tabId: '', url: '', title: '', focused: true }],
		['numeric tabId', { tabId: 1, url: '', title: '', focused: true }],
		['too long tabId', { tabId: 'x'.repeat(MAX_ID_LENGTH + 1), url: '', title: '', focused: true }],
		['missing url', { tabId: 't', title: '', focused: true }],
		['numeric title', { tabId: 't', url: '', title: 3, focused: true }],
		['string focused', { tabId: 't', url: '', title: '', focused: 'true' }],
		['missing focused', { tabId: 't', url: '', title: '' }]
	])('rejects %s', (_label, body) => {
		expect(parseHelloPayload(body).ok).toBe(false);
	});

	it('truncates very long url/title instead of rejecting', () => {
		const r = parseHelloPayload({ tabId: 't', url: 'u'.repeat(10_000), title: 't'.repeat(10_000), focused: false });
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value.url.length).toBeLessThan(10_000);
			expect(r.value.title.length).toBeLessThan(10_000);
		}
	});
});

describe('parseResultPayload', () => {
	it('accepts ok:true with text and optional data', () => {
		expect(parseResultPayload({ id: 'c1', tabId: 't', ok: true, result: { text: 'hi' } })).toEqual({
			ok: true,
			value: { id: 'c1', tabId: 't', ok: true, result: { text: 'hi' } }
		});
		const withData = parseResultPayload({ id: 'c1', tabId: 't', ok: true, result: { text: 'hi', data: { n: 1 } } });
		expect(withData.ok && withData.value.ok && withData.value.result.data).toEqual({ n: 1 });
	});

	it('accepts ok:false with error', () => {
		expect(parseResultPayload({ id: 'c1', tabId: 't', ok: false, error: 'Unknown tool' })).toEqual({
			ok: true,
			value: { id: 'c1', tabId: 't', ok: false, error: 'Unknown tool' }
		});
	});

	it.each([
		['null', null],
		['missing id', { tabId: 't', ok: true, result: { text: '' } }],
		['numeric id', { id: 1, tabId: 't', ok: true, result: { text: '' } }],
		['missing tabId', { id: 'c', ok: true, result: { text: '' } }],
		['string ok', { id: 'c', tabId: 't', ok: 'true', result: { text: '' } }],
		['ok without result', { id: 'c', tabId: 't', ok: true }],
		['result.text not string', { id: 'c', tabId: 't', ok: true, result: { text: 5 } }],
		['result.data array', { id: 'c', tabId: 't', ok: true, result: { text: '', data: [1] } }],
		['result.data null', { id: 'c', tabId: 't', ok: true, result: { text: '', data: null } }],
		['ok:false without error', { id: 'c', tabId: 't', ok: false }],
		['ok:false numeric error', { id: 'c', tabId: 't', ok: false, error: 500 }]
	])('rejects %s', (_label, body) => {
		expect(parseResultPayload(body).ok).toBe(false);
	});
});

// ============================================================
// Pending-command map
// ============================================================
describe('CommandChannel', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function setup(opts: { delivered?: number; maxPending?: number } = {}) {
		const registry = new TabRegistry();
		const sent: RuntimeCommandMessage[] = [];
		let n = 0;
		const channel = new CommandChannel({
			registry,
			broadcast: (msg) => {
				sent.push(msg);
				return opts.delivered ?? 1;
			},
			maxPending: opts.maxPending,
			generateId: () => `cmd-${++n}`
		});
		return { registry, channel, sent };
	}

	it('rejects with the contract message when no tab is connected', async () => {
		const { channel, sent } = setup();
		await expect(channel.send('ui_snapshot', {})).rejects.toThrow(NO_TAB_MESSAGE);
		expect(sent).toHaveLength(0);
	});

	it('rejects an unknown tabId, pointing to ui_tabs', async () => {
		const { channel, registry } = setup();
		registry.hello(hello('a'));
		await expect(channel.send('ui_find', {}, { tabId: 'zzz' })).rejects.toThrow(/ui_tabs/);
	});

	it('rejects when the tab said hello but no SSE client received the command', async () => {
		const { channel, registry } = setup({ delivered: 0 });
		registry.hello(hello('a'));
		await expect(channel.send('ui_find', {})).rejects.toThrow(NO_TAB_MESSAGE);
		expect(channel.pendingCount).toBe(0);
	});

	it('broadcasts {id, targetTabId, tool, args} to the active tab and resolves on settle', async () => {
		const { channel, registry, sent } = setup();
		registry.hello(hello('a', true));
		registry.hello(hello('b'));
		const p = channel.send('ui_find', { text: 'Save' });
		expect(sent).toEqual([{ id: 'cmd-1', targetTabId: 'a', tool: 'ui_find', args: { text: 'Save' } }]);
		expect(channel.pendingCount).toBe(1);
		expect(channel.settle({ id: 'cmd-1', tabId: 'a', ok: true, result: { text: 'e1 button', data: { n: 1 } } })).toBe(
			'resolved'
		);
		await expect(p).resolves.toEqual({ text: 'e1 button', data: { n: 1 } });
		expect(channel.pendingCount).toBe(0);
	});

	it('targets an explicit tabId', async () => {
		const { channel, registry, sent } = setup();
		registry.hello(hello('a', true));
		registry.hello(hello('b'));
		const p = channel.send('ui_snapshot', {}, { tabId: 'b' });
		expect(sent[0].targetTabId).toBe('b');
		channel.settle({ id: sent[0].id, tabId: 'b', ok: true, result: { text: 'ok' } });
		await expect(p).resolves.toEqual({ text: 'ok' });
	});

	it('rejects with the page error on ok:false', async () => {
		const { channel, registry, sent } = setup();
		registry.hello(hello('a'));
		const p = channel.send('ui_nope', {});
		channel.settle({ id: sent[0].id, tabId: 'a', ok: false, error: 'Unknown tool' });
		await expect(p).rejects.toThrow('Unknown tool');
	});

	it('reports unknown ids and keeps the command pending on a tab mismatch', async () => {
		const { channel, registry, sent } = setup();
		registry.hello(hello('a'));
		const p = channel.send('ui_find', {});
		expect(channel.settle({ id: 'nope', tabId: 'a', ok: true, result: { text: '' } })).toBe('unknown-id');
		expect(channel.settle({ id: sent[0].id, tabId: 'other', ok: true, result: { text: '' } })).toBe('tab-mismatch');
		expect(channel.has(sent[0].id)).toBe(true);
		channel.settle({ id: sent[0].id, tabId: 'a', ok: true, result: { text: 'done' } });
		await expect(p).resolves.toEqual({ text: 'done' });
		// settled ids are gone
		expect(channel.settle({ id: sent[0].id, tabId: 'a', ok: true, result: { text: '' } })).toBe('unknown-id');
	});

	it('times out after 10s by default and forgets the id', async () => {
		vi.useFakeTimers();
		const { channel, registry, sent } = setup();
		registry.hello(hello('a'));
		const p = channel.send('ui_find', {});
		const assertion = expect(p).rejects.toThrow('Browser tab did not respond in 10s');
		await vi.advanceTimersByTimeAsync(DEFAULT_COMMAND_TIMEOUT_MS - 1);
		expect(channel.has(sent[0].id)).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		await assertion;
		expect(channel.settle({ id: sent[0].id, tabId: 'a', ok: true, result: { text: '' } })).toBe('unknown-id');
	});

	it('caps timeoutMs at 60s', async () => {
		vi.useFakeTimers();
		const { channel, registry } = setup();
		registry.hello(hello('a'));
		const p = channel.send('ui_wait_for_hmr', {}, { timeoutMs: 600_000 });
		const assertion = expect(p).rejects.toThrow('Browser tab did not respond in 60s');
		await vi.advanceTimersByTimeAsync(MAX_COMMAND_TIMEOUT_MS);
		await assertion;
	});

	it('resolveTimeoutMs falls back to the default for invalid values', () => {
		expect(resolveTimeoutMs(undefined)).toBe(10_000);
		expect(resolveTimeoutMs(0)).toBe(10_000);
		expect(resolveTimeoutMs(-5)).toBe(10_000);
		expect(resolveTimeoutMs(Number.NaN)).toBe(10_000);
		expect(resolveTimeoutMs(2_500)).toBe(2_500);
		expect(resolveTimeoutMs(61_000)).toBe(60_000);
	});

	it('caps the pending map (default 100)', async () => {
		expect(MAX_PENDING_COMMANDS).toBe(100);
		const { channel, registry, sent } = setup({ maxPending: 2 });
		registry.hello(hello('a'));
		const p1 = channel.send('ui_find', {});
		const p2 = channel.send('ui_find', {});
		await expect(channel.send('ui_find', {})).rejects.toThrow(/Too many pending/);
		expect(channel.pendingCount).toBe(2);
		channel.settle({ id: sent[0].id, tabId: 'a', ok: true, result: { text: '1' } });
		await p1;
		const p3 = channel.send('ui_find', {});
		expect(channel.pendingCount).toBe(2);
		channel.settle({ id: sent[1].id, tabId: 'a', ok: true, result: { text: '2' } });
		channel.settle({ id: sent[2].id, tabId: 'a', ok: true, result: { text: '3' } });
		await expect(Promise.all([p2, p3])).resolves.toHaveLength(2);
	});
});

// ============================================================
// MCP tool mapping
// ============================================================
describe('runtime MCP tools', () => {
	it('maps page results to content + structuredContent', () => {
		expect(toToolResult({ text: 'tree' })).toEqual({ content: [{ type: 'text', text: 'tree' }] });
		expect(toToolResult({ text: 'tree', data: { nodes: 3 } })).toEqual({
			content: [{ type: 'text', text: 'tree' }],
			structuredContent: { nodes: 3 }
		});
	});

	it('splitForwardArgs strips tabId and undefined values', () => {
		expect(splitForwardArgs({ text: 'x', limit: 3, tabId: 't1', role: undefined })).toEqual({
			tabId: 't1',
			args: { text: 'x', limit: 3 }
		});
		expect(splitForwardArgs(undefined)).toEqual({ tabId: undefined, args: {} });
	});

	it('forwardToPage returns an MCP tool error for failures', async () => {
		const channel = new CommandChannel({ registry: new TabRegistry(), broadcast: () => 1 });
		await expect(forwardToPage(channel, 'ui_snapshot', {})).resolves.toEqual({
			content: [{ type: 'text', text: NO_TAB_MESSAGE }],
			isError: true
		});
	});

	it('forwardToPage forwards args without tabId and maps the result', async () => {
		const registry = new TabRegistry();
		registry.hello(hello('a'));
		registry.hello(hello('b'));
		const sent: RuntimeCommandMessage[] = [];
		const channel: CommandChannel = new CommandChannel({
			registry,
			broadcast: (msg) => {
				sent.push(msg);
				queueMicrotask(() =>
					channel.settle({ id: msg.id, tabId: msg.targetTabId, ok: true, result: { text: 'e1', data: { matches: [] } } })
				);
				return 1;
			}
		});
		const out = await forwardToPage(channel, 'ui_find', { component: 'Card', tabId: 'a' });
		expect(sent[0]).toMatchObject({ targetTabId: 'a', tool: 'ui_find', args: { component: 'Card' } });
		expect(out).toEqual({ content: [{ type: 'text', text: 'e1' }], structuredContent: { matches: [] } });
	});

	it('ui_tabs lists tabs with structuredContent', () => {
		const registry = new TabRegistry();
		const empty = uiTabs(registry, Date.now());
		expect(empty.structuredContent).toEqual({ tabs: [] });
		expect(empty.content[0].text).toBe(NO_TAB_MESSAGE);
		expect(empty.isError).toBeUndefined();

		registry.hello(hello('a', true));
		const out = uiTabs(registry, Date.now());
		const tabs = (out.structuredContent as { tabs: Record<string, unknown>[] }).tabs;
		expect(tabs[0]).toMatchObject({ tabId: 'a', url: 'http://localhost:5173/a', title: 'Tab a', focused: true, active: true });
		expect(typeof tabs[0].lastSeen).toBe('number');
		expect(out.content[0].text).toContain('a [active, focused]');
	});

	it('registers ui_tabs, ui_snapshot, ui_find with the ref->locator recipe', () => {
		const chain: any = new Proxy(() => chain, { get: () => () => chain, apply: () => chain });
		const fakeZ: any = new Proxy({}, { get: () => () => chain });
		const tools = new Map<string, { config: McpToolConfig; handler: McpToolHandler }>();
		registerRuntimeTools(
			{ registerTool: (name, config, handler) => tools.set(name, { config, handler }) },
			fakeZ,
			{ registry: new TabRegistry(), channel: new CommandChannel({ registry: new TabRegistry(), broadcast: () => 1 }) }
		);
		expect([...tools.keys()]).toEqual(['ui_tabs', 'ui_snapshot', 'ui_find', 'ui_wait_for_hmr']);
		for (const name of ['ui_snapshot', 'ui_find']) {
			const { config } = tools.get(name)!;
			expect(config.title).toBeTruthy();
			expect(config.description).toContain('[data-sg-ref="e12"]');
			expect(Object.keys(config.inputSchema ?? {})).toContain('tabId');
		}
		expect(Object.keys(tools.get('ui_snapshot')!.config.inputSchema!)).toEqual(['scope', 'detail', 'maxNodes', 'tabId']);
		expect(Object.keys(tools.get('ui_find')!.config.inputSchema!)).toEqual([
			'text',
			'role',
			'name',
			'component',
			'file',
			'selector',
			'limit',
			'tabId'
		]);
		expect(tools.get('ui_tabs')!.config.outputSchema).toHaveProperty('tabs');
	});
});

// ============================================================
// HTTP endpoints (real server on 127.0.0.1, ephemeral port)
// ============================================================
const HOST = '127.0.0.1';
const TOKEN = 'test-token';
const GOOD_ORIGIN = 'http://localhost:5173';

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once('error', reject);
		srv.listen(0, HOST, () => {
			const { port } = srv.address() as AddressInfo;
			srv.close(() => resolve(port));
		});
	});
}

interface HttpResult {
	status: number;
	json: any;
}

function send(
	port: number,
	method: string,
	path: string,
	opts: { origin?: string | null; token?: string | null; body?: string | object } = {}
): Promise<HttpResult> {
	const headers: Record<string, string> = { 'content-type': 'application/json', connection: 'close' };
	const origin = opts.origin === undefined ? GOOD_ORIGIN : opts.origin;
	const token = opts.token === undefined ? TOKEN : opts.token;
	if (origin) headers.origin = origin;
	if (token) headers['x-svelte-grab-token'] = token;
	const body = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: HOST, port, method, path, headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (c: Buffer) => chunks.push(c));
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString();
				let json: unknown = null;
				try {
					json = JSON.parse(text);
				} catch {
					json = text;
				}
				resolve({ status: res.statusCode ?? 0, json });
			});
		});
		req.on('error', reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

interface SseConnection {
	req: ClientRequest;
	next(event: string): Promise<any>;
	close(): void;
}

function openSse(port: number): Promise<SseConnection> {
	return new Promise((resolve, reject) => {
		const queue: { event: string; data: any }[] = [];
		const waiters: { event: string; resolve: (data: any) => void }[] = [];
		let buffer = '';
		const req = httpRequest(
			{ host: HOST, port, method: 'GET', path: `/events?token=${TOKEN}`, headers: { origin: GOOD_ORIGIN } },
			(res: IncomingMessage) => {
				res.setEncoding('utf8');
				res.on('data', (chunk: string) => {
					buffer += chunk;
					let idx: number;
					while ((idx = buffer.indexOf('\n\n')) !== -1) {
						const raw = buffer.slice(0, idx);
						buffer = buffer.slice(idx + 2);
						const event = /^event: (.*)$/m.exec(raw)?.[1] ?? 'message';
						const data = JSON.parse(/^data: (.*)$/m.exec(raw)?.[1] ?? 'null');
						const w = waiters.findIndex((x) => x.event === event);
						if (w !== -1) waiters.splice(w, 1)[0].resolve(data);
						else queue.push({ event, data });
					}
				});
				resolve({
					req,
					next(event: string) {
						const i = queue.findIndex((x) => x.event === event);
						if (i !== -1) return Promise.resolve(queue.splice(i, 1)[0].data);
						return new Promise((r) => waiters.push({ event, resolve: r }));
					},
					close() {
						req.destroy();
					}
				});
			}
		);
		req.on('error', (err) => {
			if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
		});
		req.end();
	});
}

async function waitForSseClients(port: number, count: number): Promise<void> {
	for (let i = 0; i < 50; i++) {
		const { json } = await send(port, 'GET', '/health');
		if (json.sseClients === count) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`sseClients never reached ${count}`);
}

describe('runtime HTTP endpoints', () => {
	let port: number;
	let close: () => void;
	const savedToken = process.env.SVELTE_GRAB_TOKEN;
	const savedOrigins = process.env.SVELTE_GRAB_ALLOWED_ORIGINS;
	const connections: SseConnection[] = [];

	beforeAll(async () => {
		delete process.env.SVELTE_GRAB_TOKEN;
		delete process.env.SVELTE_GRAB_ALLOWED_ORIGINS;
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const started = await startMcpServer({ port: await freePort(), token: TOKEN });
		if (!started) throw new Error('server did not start');
		port = started.port;
		close = started.close;
	});

	afterEach(async () => {
		while (connections.length) connections.pop()!.close();
		await waitForSseClients(port, 0);
	});

	afterAll(() => {
		close?.();
		if (savedToken !== undefined) process.env.SVELTE_GRAB_TOKEN = savedToken;
		if (savedOrigins !== undefined) process.env.SVELTE_GRAB_ALLOWED_ORIGINS = savedOrigins;
		vi.restoreAllMocks();
	});

	describe.each(['/runtime/hello', '/runtime/result'])('%s access checks', (path) => {
		it('rejects a disallowed Origin with 403', async () => {
			const r = await send(port, 'POST', path, { origin: 'https://evil.example', body: {} });
			expect(r.status).toBe(403);
		});

		it('rejects a disallowed Origin even with a valid token', async () => {
			const r = await send(port, 'POST', path, { origin: 'https://evil.example', token: TOKEN, body: {} });
			expect(r.status).toBe(403);
		});

		it('rejects a missing token with 401', async () => {
			const r = await send(port, 'POST', path, { token: null, body: {} });
			expect(r.status).toBe(401);
		});

		it('rejects a wrong token with 401', async () => {
			const r = await send(port, 'POST', path, { token: 'nope', body: {} });
			expect(r.status).toBe(401);
		});

		it('rejects invalid JSON with 400', async () => {
			const r = await send(port, 'POST', path, { body: '{not json' });
			expect(r.status).toBe(400);
		});

		it('answers bodies over the 2 MB cap with a readable 413, like POST /context', async () => {
			const oversized = JSON.stringify({ content: ['x'.repeat(2 * 1024 * 1024 + 10)] });
			const tooLarge = { status: 413, json: { error: 'Request body too large' } };
			const [runtime, context] = await Promise.all([
				send(port, 'POST', path, { body: oversized }),
				send(port, 'POST', '/context', { body: oversized })
			]);
			expect(runtime).toEqual(tooLarge);
			expect(context).toEqual(tooLarge);
		});
	});

	it('POST /runtime/hello accepts the contract shape and rejects wrong types', async () => {
		const ok = await send(port, 'POST', '/runtime/hello', { body: hello('http-hello', true) });
		expect(ok).toEqual({ status: 200, json: { ok: true } });
		const bad = await send(port, 'POST', '/runtime/hello', { body: { ...hello('x'), focused: 'yes' } });
		expect(bad.status).toBe(400);
	});

	it('POST /runtime/result with an unknown id -> 404, wrong types -> 400', async () => {
		const unknown = await send(port, 'POST', '/runtime/result', {
			body: { id: 'does-not-exist', tabId: 't', ok: true, result: { text: '' } }
		});
		expect(unknown.status).toBe(404);
		const bad = await send(port, 'POST', '/runtime/result', { body: { id: 'x', tabId: 't', ok: 1 } });
		expect(bad.status).toBe(400);
	});

	it('sendRuntimeCommand rejects when the tab has no open SSE stream', async () => {
		await send(port, 'POST', '/runtime/hello', { body: hello('no-sse') });
		await expect(sendRuntimeCommand('ui_find', {}, { tabId: 'no-sse' })).rejects.toThrow(NO_TAB_MESSAGE);
	});

	it('round trip: SSE runtime-command -> POST /runtime/result resolves; replay -> 404', async () => {
		const sse = await openSse(port);
		connections.push(sse);
		await waitForSseClients(port, 1);
		await send(port, 'POST', '/runtime/hello', { body: hello('rt-tab', true) });

		const pending = sendRuntimeCommand('ui_find', { component: 'Card' }, { tabId: 'rt-tab' });
		const cmd = await sse.next('runtime-command');
		expect(cmd).toEqual({ id: expect.any(String), targetTabId: 'rt-tab', tool: 'ui_find', args: { component: 'Card' } });

		const wrongTab = await send(port, 'POST', '/runtime/result', {
			body: { id: cmd.id, tabId: 'other-tab', ok: true, result: { text: 'x' } }
		});
		expect(wrongTab.status).toBe(404);

		const r = await send(port, 'POST', '/runtime/result', {
			body: { id: cmd.id, tabId: 'rt-tab', ok: true, result: { text: 'e1 Card', data: { matches: [{ ref: 'e1' }] } } }
		});
		expect(r).toEqual({ status: 200, json: { ok: true } });
		await expect(pending).resolves.toEqual({ text: 'e1 Card', data: { matches: [{ ref: 'e1' }] } });

		const replay = await send(port, 'POST', '/runtime/result', {
			body: { id: cmd.id, tabId: 'rt-tab', ok: true, result: { text: 'again' } }
		});
		expect(replay.status).toBe(404);
	});

	it('a malformed result for a pending id is rejected (400) and fails the command', async () => {
		const sse = await openSse(port);
		connections.push(sse);
		await waitForSseClients(port, 1);
		await send(port, 'POST', '/runtime/hello', { body: hello('bad-tab') });

		const pending = sendRuntimeCommand('ui_snapshot', {}, { tabId: 'bad-tab' });
		const assertion = expect(pending).rejects.toThrow(/invalid result/);
		const cmd = await sse.next('runtime-command');
		const r = await send(port, 'POST', '/runtime/result', {
			body: { id: cmd.id, tabId: 'bad-tab', ok: true, result: { text: 42 } }
		});
		expect(r.status).toBe(400);
		await assertion;
	});

	it('times out when the page never answers', async () => {
		const sse = await openSse(port);
		connections.push(sse);
		await waitForSseClients(port, 1);
		await send(port, 'POST', '/runtime/hello', { body: hello('slow-tab') });
		await expect(sendRuntimeCommand('ui_find', {}, { tabId: 'slow-tab', timeoutMs: 50 })).rejects.toThrow(
			'Browser tab did not respond in 0.05s'
		);
	});
});
