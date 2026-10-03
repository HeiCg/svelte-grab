/**
 * Page side of the runtime channel (wire contract v1, docs/agent-runtime-spec.md).
 *
 * - Listens on the MCP server's SSE `GET /events` for `runtime-command` events
 *   and handles only those whose `targetTabId` is this tab's id.
 * - Replies with `POST /runtime/result` `{id, tabId, ok, result | error}`.
 * - Announces the tab with `POST /runtime/hello` `{tabId, url, title, focused}`
 *   on connect, on focus/blur/visibilitychange and every 15s.
 * - Reconnects with exponential backoff.
 * - Duplicated tabs: the browser copies sessionStorage (and so the tab id) into
 *   a duplicated tab. On start the page pings the other tabs over a
 *   BroadcastChannel; if a live tab answers with the same id, this tab takes a
 *   fresh one and re-announces itself.
 *
 * No-op during SSR, without EventSource/fetch, or when Svelte dev metadata is
 * absent (production builds) unless `forceEnable`.
 */
import { detectDevMode } from '../utils/shared.js';
import { dispatchRuntimeCommand } from './commands.js';
import { consoleCapture } from './console-capture.js';
import { hmrTracker } from './hmr.js';
import { networkCapture } from './network.js';
import type { RuntimeCommandOutcome, RuntimeHello, RuntimeResultMessage } from './types.js';

export const RUNTIME_TAB_ID_KEY = 'svelte-grab-tab-id';
/** BroadcastChannel used to detect a duplicated tab carrying a copied tab id. */
export const RUNTIME_TAB_CHANNEL = 'svelte-grab-runtime-tabs';
export const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_MIN_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
/** Recent command ids kept to drop duplicate deliveries. */
const SEEN_IDS_CAP = 200;
/**
 * Header the MCP server reads the token from (`TOKEN_HEADER` in
 * src/utils/security.ts); `?token=` works too and is what EventSource uses.
 */
export const MCP_TOKEN_HEADER = 'x-svelte-grab-token';

type EventSourceCtor = new (url: string) => EventSource;
type BroadcastChannelCtor = new (name: string) => BroadcastChannel;
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
	/** Tool dispatcher. Defaults to the built-in tool table (`runtimeTools`). */
	dispatch?: (tool: string, args: unknown) => Promise<RuntimeCommandOutcome>;
	/** Test seams. Default to the globals. */
	EventSource?: EventSourceCtor;
	fetch?: FetchFn;
	/** `null` skips duplicate-tab detection. */
	BroadcastChannel?: BroadcastChannelCtor | null;
	/**
	 * Track Vite HMR events while running (ring buffer for `ui_wait_for_hmr`
	 * `since`, console errors since the last update). Default true.
	 */
	trackHmr?: boolean;
}

/** Messages on RUNTIME_TAB_CHANNEL. `from` / `to` are per-runtime instance ids. */
type TabChannelMessage =
	| { type: 'ping'; tabId: string; from: string }
	| { type: 'pong'; tabId: string; to: string };

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

/** Replace this tab's id (duplicate detected) and persist the new one. */
function regenerateRuntimeTabId(): string {
	const id = randomId();
	memoryTabId = id;
	try {
		sessionStorage.setItem(RUNTIME_TAB_ID_KEY, id);
	} catch {
		// memory fallback already holds it
	}
	return id;
}

/** Test helper: forget the in-memory tab id. */
export function resetRuntimeTabIdForTests(): void {
	memoryTabId = null;
}

/** Append `?token=` (or `&token=`) when a token is set: EventSource cannot send headers. */
export function withToken(url: string, token: string | undefined): string {
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
	let tabId = getRuntimeTabId();

	let source: EventSource | null = null;
	let connected = false;
	let stopped = false;
	let backoff = minBackoff;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	const seenIds: string[] = [];

	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (token) headers[MCP_TOKEN_HEADER] = token;

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

	// Duplicate-tab check: ask the other tabs whether one already uses this id.
	const BC =
		options.BroadcastChannel === undefined
			? (globalThis as { BroadcastChannel?: BroadcastChannelCtor }).BroadcastChannel
			: options.BroadcastChannel;
	const instanceId = randomId();
	let tabChannel: BroadcastChannel | null = null;
	if (BC) {
		try {
			tabChannel = new BC(RUNTIME_TAB_CHANNEL);
			tabChannel.addEventListener('message', (event: MessageEvent) => {
				const msg = event.data as TabChannelMessage | null;
				if (stopped || !msg || msg.tabId !== tabId) return;
				if (msg.type === 'ping' && msg.from !== instanceId) {
					// Someone started with our id: tell them, they regenerate.
					tabChannel?.postMessage({ type: 'pong', tabId, to: msg.from } satisfies TabChannelMessage);
				} else if (msg.type === 'pong' && msg.to === instanceId) {
					tabId = regenerateRuntimeTabId();
					sendHello();
				}
			});
			tabChannel.postMessage({ type: 'ping', tabId, from: instanceId } satisfies TabChannelMessage);
		} catch {
			tabChannel = null;
		}
	}

	const onFocusChange = (): void => sendHello();
	window.addEventListener('focus', onFocusChange);
	window.addEventListener('blur', onFocusChange);
	document.addEventListener('visibilitychange', onFocusChange);
	const heartbeat = setInterval(sendHello, heartbeatMs);

	// Console errors/warnings are captured for as long as the runtime runs
	// (ui_verify `console` check); the console is restored on stop().
	consoleCapture.retain();
	// Network requests too (ui_network / ui_security_scan); restored on stop().
	networkCapture.retain();
	const trackHmr = options.trackHmr !== false;
	if (trackHmr) hmrTracker.retain();

	connect();

	return {
		active: true,
		get tabId() {
			return tabId;
		},
		stop() {
			if (stopped) return;
			stopped = true;
			connected = false;
			clearInterval(heartbeat);
			if (trackHmr) hmrTracker.release();
			consoleCapture.release();
			networkCapture.release();
			if (reconnectTimer) clearTimeout(reconnectTimer);
			reconnectTimer = null;
			window.removeEventListener('focus', onFocusChange);
			window.removeEventListener('blur', onFocusChange);
			document.removeEventListener('visibilitychange', onFocusChange);
			source?.close();
			source = null;
			tabChannel?.close();
			tabChannel = null;
		}
	};
}
