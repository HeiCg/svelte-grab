/**
 * Minimal Chrome DevTools Protocol client for the opt-in CDP mode
 * (docs/agent-runtime-spec.md, Phase 8b). No dependencies: `fetch` for the
 * DevTools HTTP endpoint (`/json/list`) and Node's global `WebSocket`
 * (Node 22+) for the JSON-RPC session.
 *
 * SECURITY: a CDP port gives full control of the browser (read every page,
 * run script, read cookies). CDP mode is off unless `--cdp=<url>` or
 * `SVELTE_GRAB_CDP` is set, and only loopback endpoints are accepted
 * (127.0.0.1, localhost, [::1]): both the configured URL and the
 * `webSocketDebuggerUrl` Chrome hands back are checked.
 */

/** Env var that enables CDP mode (same value as `--cdp=`). */
export const CDP_ENV = 'SVELTE_GRAB_CDP';
/** Default per-call timeout (HTTP list, WebSocket open, each RPC). */
export const DEFAULT_CDP_TIMEOUT_MS = 10_000;

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);

export const CDP_HOW_TO_ENABLE =
	'Start Chrome with a loopback debugging port, e.g. ' +
	'`chrome --remote-debugging-port=9222 --user-data-dir=/tmp/svelte-grab-chrome`, open the app in that window, ' +
	'and start the MCP server with `svelte-grab-mcp --cdp=http://127.0.0.1:9222` ' +
	`(or ${CDP_ENV}=http://127.0.0.1:9222).`;

/** Resolved CDP mode config. */
export interface CdpConfig {
	/** Origin of the DevTools HTTP endpoint, e.g. `http://127.0.0.1:9222`. */
	httpUrl: string;
}

export function isLoopbackHostname(hostname: string): boolean {
	return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Validate a `--cdp` URL: http(s)/ws(s) on a loopback host. Throws with a
 * message fit for a startup error. ws(s) URLs (e.g. a browser
 * `webSocketDebuggerUrl`) map to the http(s) origin of the same host:port.
 */
export function parseCdpUrl(raw: string): CdpConfig {
	const value = raw.trim();
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`Invalid --cdp URL "${raw}": expected e.g. http://127.0.0.1:9222`);
	}
	if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
		throw new Error(`Invalid --cdp URL "${raw}": use http://, https:// or ws:// (e.g. http://127.0.0.1:9222)`);
	}
	if (!isLoopbackHostname(url.hostname)) {
		throw new Error(
			`Refusing --cdp URL "${raw}": the host must be 127.0.0.1, localhost or [::1]. ` +
				'A CDP port gives full control of the browser; never point svelte-grab at a remote one.'
		);
	}
	if (url.username || url.password) {
		throw new Error(`Invalid --cdp URL "${raw}": credentials in the URL are not supported`);
	}
	const protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'https:' : 'http:';
	return { httpUrl: `${protocol}//${url.host}` };
}

/** The raw `--cdp` value from argv: `--cdp=<url>` -> url, bare `--cdp` -> '', absent -> undefined. */
export function cdpArgFromArgv(argv: readonly string[]): string | undefined {
	for (const arg of argv) {
		if (arg === '--cdp') return '';
		if (arg.startsWith('--cdp=')) return arg.slice('--cdp='.length);
	}
	return undefined;
}

/**
 * CDP config from the `--cdp` option (wins) or `SVELTE_GRAB_CDP`. `null` when
 * neither is set (CDP mode off, the default). Throws on an invalid or
 * non-loopback URL, or a bare `--cdp` without a URL.
 */
export function resolveCdpConfig(
	option: string | undefined,
	env: Record<string, string | undefined> = process.env
): CdpConfig | null {
	if (option !== undefined) {
		if (option.trim() === '') {
			throw new Error('--cdp needs a URL, e.g. --cdp=http://127.0.0.1:9222');
		}
		return parseCdpUrl(option);
	}
	const fromEnv = env[CDP_ENV];
	if (fromEnv === undefined || fromEnv.trim() === '') return null;
	return parseCdpUrl(fromEnv);
}

/** One entry of `GET /json/list`. */
export interface CdpTarget {
	id: string;
	type: string;
	url: string;
	title?: string;
	webSocketDebuggerUrl?: string;
}

/** URL without the hash and without a trailing slash before the query (or end). */
export function normalizeTargetUrl(url: string): string {
	let out = url;
	try {
		const parsed = new URL(url);
		parsed.hash = '';
		out = parsed.href;
	} catch {
		const hash = out.indexOf('#');
		if (hash >= 0) out = out.slice(0, hash);
	}
	return out.replace(/\/+(?=\?|$)/, '');
}

export interface PickedTarget {
	target: CdpTarget;
	/** More than one page target matched; the first (title match preferred) was taken. */
	ambiguous: boolean;
}

/**
 * The page target showing `tabUrl`: exact URL match first, then a match that
 * ignores the hash and a trailing slash. Among several matches the one whose
 * title equals `title` wins. `null` when no page target matches.
 */
export function pickTarget(targets: readonly CdpTarget[], tabUrl: string, title?: string): PickedTarget | null {
	const pages = targets.filter(
		(t) => t && t.type === 'page' && typeof t.url === 'string' && typeof t.webSocketDebuggerUrl === 'string' && t.webSocketDebuggerUrl
	);
	let matches = pages.filter((t) => t.url === tabUrl);
	if (matches.length === 0) {
		const wanted = normalizeTargetUrl(tabUrl);
		matches = pages.filter((t) => normalizeTargetUrl(t.url) === wanted);
	}
	if (matches.length === 0) return null;
	if (matches.length > 1 && title) {
		const byTitle = matches.filter((t) => t.title === title);
		if (byTitle.length > 0) return { target: byTitle[0], ambiguous: byTitle.length > 1 };
	}
	return { target: matches[0], ambiguous: matches.length > 1 };
}

/** Structural subset of the WHATWG `WebSocket` used here (Node 22 global, or a fake in tests). */
export interface WebSocketLike {
	send(data: string): void;
	close(): void;
	addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown; message?: string }) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Node's global `WebSocket` (Node 22+). */
export const defaultWebSocketFactory: WebSocketFactory = (url) => {
	const WS = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
	if (typeof WS !== 'function') {
		throw new Error('CDP mode needs a global WebSocket (Node 22 or newer).');
	}
	return new WS(url);
};

interface PendingCall {
	method: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** Minimal surface of a CDP session (what the tools use; fakes implement it in tests). */
export interface CdpSessionLike {
	send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
	close(): void;
}

/** One JSON-RPC session over a target's WebSocket. Events (messages without `id`) are ignored. */
export class CdpSession implements CdpSessionLike {
	private nextId = 0;
	private readonly pending = new Map<number, PendingCall>();
	private closed = false;

	constructor(
		private readonly ws: WebSocketLike,
		private readonly timeoutMs: number = DEFAULT_CDP_TIMEOUT_MS
	) {
		ws.addEventListener('message', (event) => this.onMessage(event.data));
		ws.addEventListener('close', () => this.onClose('CDP connection closed'));
		ws.addEventListener('error', (event) => this.onClose(`CDP connection error${event?.message ? `: ${event.message}` : ''}`));
	}

	/** Open a WebSocket to `url` and resolve once it is open. */
	static connect(
		url: string,
		options: { createWebSocket?: WebSocketFactory; timeoutMs?: number } = {}
	): Promise<CdpSession> {
		const timeoutMs = options.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
		return new Promise<CdpSession>((resolve, reject) => {
			let ws: WebSocketLike;
			try {
				ws = (options.createWebSocket ?? defaultWebSocketFactory)(url);
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
				return;
			}
			let settled = false;
			const finish = (error: Error | null) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error) {
					try {
						ws.close();
					} catch {
						/* already closed */
					}
					reject(error);
				} else {
					resolve(new CdpSession(ws, timeoutMs));
				}
			};
			const timer = setTimeout(
				() => finish(new Error(`CDP WebSocket ${url} did not open in ${timeoutMs / 1000}s`)),
				timeoutMs
			);
			ws.addEventListener('open', () => finish(null));
			ws.addEventListener('error', (event) =>
				finish(new Error(`Could not open the CDP WebSocket ${url}${event?.message ? `: ${event.message}` : ''}`))
			);
			ws.addEventListener('close', () => finish(new Error(`CDP WebSocket ${url} closed before opening`)));
		});
	}

	get pendingCount(): number {
		return this.pending.size;
	}

	send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs: number = this.timeoutMs): Promise<T> {
		if (this.closed) return Promise.reject(new Error(`CDP ${method} failed: connection closed`));
		const id = ++this.nextId;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP ${method} did not answer in ${timeoutMs / 1000}s`));
			}, timeoutMs);
			this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
			try {
				this.ws.send(JSON.stringify({ id, method, params }));
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new Error(`CDP ${method} failed: ${err instanceof Error ? err.message : String(err)}`));
			}
		});
	}

	close(): void {
		if (this.closed) return;
		this.onClose('CDP session closed');
		try {
			this.ws.close();
		} catch {
			/* already closed */
		}
	}

	private onMessage(data: unknown): void {
		let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
		try {
			message = JSON.parse(typeof data === 'string' ? data : String(data));
		} catch {
			return;
		}
		if (!message || typeof message.id !== 'number') return; // an event
		const call = this.pending.get(message.id);
		if (!call) return;
		this.pending.delete(message.id);
		clearTimeout(call.timer);
		if (message.error) {
			const detail = typeof message.error.message === 'string' ? message.error.message : JSON.stringify(message.error);
			call.reject(new Error(`CDP ${call.method} failed: ${detail}`));
		} else {
			call.resolve(message.result ?? {});
		}
	}

	private onClose(reason: string): void {
		this.closed = true;
		for (const [id, call] of this.pending) {
			this.pending.delete(id);
			clearTimeout(call.timer);
			call.reject(new Error(`CDP ${call.method} failed: ${reason}`));
		}
	}
}

export interface CdpConnectOptions {
	fetch?: FetchLike;
	createWebSocket?: WebSocketFactory;
	timeoutMs?: number;
}

/** `GET <cdp>/json/list`. */
export async function listTargets(config: CdpConfig, options: CdpConnectOptions = {}): Promise<CdpTarget[]> {
	const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
	const timeoutMs = options.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
	let body: unknown;
	try {
		const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
		const res = await fetchImpl(`${config.httpUrl}/json/list`, signal ? { signal } : undefined);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		body = await res.json();
	} catch (err) {
		throw new Error(
			`Could not reach Chrome DevTools at ${config.httpUrl} (${err instanceof Error ? err.message : String(err)}). ` +
				CDP_HOW_TO_ENABLE
		);
	}
	if (!Array.isArray(body)) throw new Error(`Unexpected /json/list answer from ${config.httpUrl}`);
	return body as CdpTarget[];
}

export interface CdpTabConnection {
	session: CdpSessionLike;
	target: CdpTarget;
	ambiguous: boolean;
}

/** Connect to the page target showing the runtime tab `{url, title}`. */
export async function connectToTab(
	config: CdpConfig,
	tab: { url: string; title?: string },
	options: CdpConnectOptions = {}
): Promise<CdpTabConnection> {
	const targets = await listTargets(config, options);
	const picked = pickTarget(targets, tab.url, tab.title);
	if (!picked) {
		const pages = targets.filter((t) => t && t.type === 'page').map((t) => t.url);
		throw new Error(
			`No Chrome page target at ${config.httpUrl} shows the tab ${tab.url} ` +
				`(page targets: ${pages.length ? pages.slice(0, 5).join(', ') : 'none'}). ` +
				'Open the app in the Chrome started with --remote-debugging-port.'
		);
	}
	const wsUrl = picked.target.webSocketDebuggerUrl!;
	let parsed: URL;
	try {
		parsed = new URL(wsUrl);
	} catch {
		throw new Error(`Invalid webSocketDebuggerUrl "${wsUrl}" from ${config.httpUrl}`);
	}
	if ((parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') || !isLoopbackHostname(parsed.hostname)) {
		throw new Error(`Refusing CDP WebSocket "${wsUrl}": only ws:// on 127.0.0.1, localhost or [::1] is allowed`);
	}
	const session = await CdpSession.connect(wsUrl, options);
	return { session, target: picked.target, ambiguous: picked.ambiguous };
}
