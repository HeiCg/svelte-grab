/**
 * Page side of the runtime channel (wire contract v1, docs/agent-runtime-spec.md).
 *
 * - Listens on the MCP server's SSE `GET /events` for `runtime-command` events
 *   and handles only those whose `targetTabId` is this tab's id.
 * - Replies with `POST /runtime/result` `{id, tabId, ok, result | error}`.
 * - Announces the tab with `POST /runtime/hello` `{tabId, url, title, focused}`
 *   on connect, on focus/blur/visibilitychange and every 15s.
 * - Reconnects with exponential backoff.
 *
 * No-op during SSR, without EventSource/fetch, or when Svelte dev metadata is
 * absent (production builds) unless `forceEnable`.
 */
import { detectDevMode } from '../utils/shared.js';
import { dispatchRuntimeCommand } from './commands.js';
import type { RuntimeCommandOutcome, RuntimeHello, RuntimeResultMessage } from './types.js';

export const RUNTIME_TAB_ID_KEY = 'svelte-grab-tab-id';
export const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_MIN_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
/** Recent command ids kept to drop duplicate deliveries. */
const SEEN_IDS_CAP = 200;
const TOKEN_HEADER = 'x-svelte-grab-token';

type EventSourceCtor = new (url: string) => EventSource;
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface AgentRuntimeOptions {
	/** MCP server base URL, e.g. `http://localhost:4723` (no trailing slash needed). */
	serverUrl: string;
	/** Optional bearer token (`SVELTE_GRAB_TOKEN`): `?token=` on SSE, header on POSTs. */
	token?: string;
	/** Run even without Svelte dev metadata (mirrors the components' `forceEnable`). */
	forceEnable?: boolean;
	/** Heartbeat hello interval. Default 15000. */
	heartbeatMs?: number;
	/** Reconnect backoff bounds. Defaults 1000 / 30000. */
	minBackoffMs?: number;
	maxBackoffMs?: number;
	/** Tool dispatcher. Defaults to the built-in `ui_snapshot` / `ui_find` table. */
	dispatch?: (tool: string, args: unknown) => Promise<RuntimeCommandOutcome>;
	/** Test seams. Default to the globals. */
	EventSource?: EventSourceCtor;
	fetch?: FetchFn;
}

export interface AgentRuntimeHandle {
	/** `false` when the runtime decided to stay off (SSR / production / no EventSource). */
	readonly active: boolean;
	/** This tab's id, or `null` when inactive. */
	readonly tabId: string | null;
	/** Close the SSE connection and remove every listener/timer. Idempotent. */
	stop(): void;
}

const INACTIVE: AgentRuntimeHandle = Object.freeze({ active: false, tabId: null, stop() {} });

let memoryTabId: string | null = null;

function randomId(): string {
	const c = (globalThis as { crypto?: Crypto }).crypto;
	if (c && typeof c.randomUUID === 'function') return c.randomUUID();
	return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * This tab's id: read from `sessionStorage` (so reloads keep it), generated on
 * first use; falls back to an in-memory id when storage is unavailable.
 */
export function getRuntimeTabId(): string {
	try {
		const stored = sessionStorage.getItem(RUNTIME_TAB_ID_KEY);
		if (stored) return stored;
		const id = memoryTabId ?? randomId();
		sessionStorage.setItem(RUNTIME_TAB_ID_KEY, id);
		memoryTabId = id;
		return id;
	} catch {
		memoryTabId ??= randomId();
		return memoryTabId;
	}
}

/** Test helper: forget the in-memory tab id. */
export function resetRuntimeTabIdForTests(): void {
	memoryTabId = null;
}

function withToken(url: string, token: string | undefined): string {
	if (!token) return url;
	return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/**
 * Start the in-page agent runtime. Returns a handle whose `stop()` must be
 * called on unmount.
 */
export function startAgentRuntime(options: AgentRuntimeOptions): AgentRuntimeHandle {
	if (typeof window === 'undefined' || typeof document === 'undefined') return INACTIVE;
	const ES = options.EventSource ?? (globalThis as { EventSource?: EventSourceCtor }).EventSource;
	const doFetch: FetchFn | undefined =
		options.fetch ?? (typeof fetch === 'function' ? (i, init) => fetch(i, init) : undefined);
	if (!ES || !doFetch) return INACTIVE;
	if (!detectDevMode(options.forceEnable ?? false)) return INACTIVE;

	const base = options.serverUrl.replace(/\/+$/, '');
	const token = options.token || undefined;
	const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
	const minBackoff = options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
	const maxBackoff = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
	const dispatch = options.dispatch ?? dispatchRuntimeCommand;
	const tabId = getRuntimeTabId();

	let source: EventSource | null = null;
	let connected = false;
	let stopped = false;
	let backoff = minBackoff;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	const seenIds: string[] = [];

	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (token) headers[TOKEN_HEADER] = token;

	const post = (path: string, body: unknown): void => {
		doFetch(`${base}${path}`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body)
		}).catch(() => {
			// Server gone or rejected: the SSE error path handles reconnecting.
		});
	};

	const sendHello = (): void => {
		if (!connected || stopped) return;
		const hello: RuntimeHello = {
			tabId,
			url: location.href,
			title: document.title,
			focused: document.visibilityState !== 'hidden' && document.hasFocus()
		};
		post('/runtime/hello', hello);
	};

	const sendResult = (message: RuntimeResultMessage): void => {
		if (stopped) return;
		post('/runtime/result', message);
	};

	const onCommand = (event: MessageEvent): void => {
		let data: { id?: unknown; targetTabId?: unknown; tool?: unknown; args?: unknown };
		try {
			data = JSON.parse(String(event.data));
		} catch {
			return;
		}
		if (!data || data.targetTabId !== tabId || typeof data.id !== 'string') return;
		const id = data.id;
		if (seenIds.includes(id)) return;
		seenIds.push(id);
		if (seenIds.length > SEEN_IDS_CAP) seenIds.shift();

		void dispatch(String(data.tool), data.args).then(
			(outcome) =>
				sendResult(
					outcome.ok
						? { id, tabId, ok: true, result: outcome.result }
						: { id, tabId, ok: false, error: outcome.error }
				),
			(err: unknown) =>
				sendResult({
					id,
					tabId,
					ok: false,
					error: err instanceof Error ? err.message : String(err)
				})
		);
	};

	const scheduleReconnect = (): void => {
		if (stopped || reconnectTimer) return;
		const delay = backoff;
		backoff = Math.min(backoff * 2, maxBackoff);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, delay);
	};

	const connect = (): void => {
		if (stopped) return;
		let es: EventSource;
		try {
			es = new ES(withToken(`${base}/events`, token));
		} catch {
			scheduleReconnect();
			return;
		}
		source = es;
		es.addEventListener('open', () => {
			if (source !== es) return;
			connected = true;
			backoff = minBackoff;
			sendHello();
		});
		es.addEventListener('runtime-command', onCommand as EventListener);
		es.addEventListener('error', () => {
			if (source !== es) return;
			// Take over reconnection from the browser so backoff is bounded and
			// a permanently failed connection (CORS/401) is retried too.
			connected = false;
			es.close();
			source = null;
			scheduleReconnect();
		});
	};

	const onFocusChange = (): void => sendHello();
	window.addEventListener('focus', onFocusChange);
	window.addEventListener('blur', onFocusChange);
	document.addEventListener('visibilitychange', onFocusChange);
	const heartbeat = setInterval(sendHello, heartbeatMs);

	connect();

	return {
		active: true,
		tabId,
		stop() {
			if (stopped) return;
			stopped = true;
			connected = false;
			clearInterval(heartbeat);
			if (reconnectTimer) clearTimeout(reconnectTimer);
			reconnectTimer = null;
			window.removeEventListener('focus', onFocusChange);
			window.removeEventListener('blur', onFocusChange);
			document.removeEventListener('visibilitychange', onFocusChange);
			source?.close();
			source = null;
		}
	};
}
