/**
 * Network capture + `ui_network` (docs/agent-runtime-spec.md, Phase 9a).
 *
 * While retained, wraps `fetch`, `XMLHttpRequest` (open / setRequestHeader /
 * send on the prototype), `navigator.sendBeacon`, `WebSocket` and
 * `EventSource` (Proxy constructors, so statics, `instanceof` and subclassing
 * keep working), and observes `PerformanceObserver('resource')` (buffered, so
 * everything since navigation start is seen: scripts, CSS, images, fonts and
 * requests made before the wrappers were installed). Resource entries for
 * fetch/XHR/beacon are merged into the wrapper entry with the same URL and a
 * close start time (sizes, full duration, status).
 *
 * Wrappers are transparent: same arguments (`arguments` forwarded as is),
 * same return values, errors propagate (the fetch wrapper returns a promise
 * that rejects with the very same error, so an unhandled rejection stays
 * unhandled), bodies are never read unless body capture is on, and every
 * piece of bookkeeping is in try/catch. On the last `release()` the originals
 * are restored (a wrapper someone else wrapped after us is left in their
 * chain, inert).
 *
 * Body capture (`includeBodies`) is off by default: when on, same-origin JSON
 * responses up to 64 KB are read from a `clone()` (fetch) or `responseText`
 * (XHR). Request bodies that are strings / URLSearchParams are kept (up to
 * 4 KB) for `ui_security_scan` (credentials sent to third parties) and are
 * never returned unredacted.
 *
 * Start as early as possible: `installNetworkCapture()` is called by
 * SvelteGrab at module evaluation in dev, so the initial load is captured;
 * the runtime retains the capture when it starts and SvelteGrab then drops
 * the early hold (`releaseEarlyNetworkCapture()`).
 *
 * Initiator: `new Error().stack` at call time, parsed with
 * `utils/error-parser.ts`; the first app frame (not this module, not
 * node_modules / Vite internals) is the source, and the nearest `.svelte`
 * frame names the component. Chrome does not source-map `Error.stack`: the
 * line is the one of the module as served (compiled `.svelte` output).
 *
 * svelte-grab's own traffic (the MCP server on loopback: /health, /events,
 * /context, /runtime/*, /mcp; same-origin /__svelte-grab/* and
 * /__open-in-editor) is never recorded.
 */
import {
	extractComponentFromFrame,
	filterFrames,
	findSvelteFrame,
	parseStackTrace,
	shortenFramePath
} from '../utils/error-parser.js';
import {
	detectSecret,
	isMeaningfulSecretValue,
	redact,
	redactText,
	redactUrl,
	sensitiveKeyKind,
	utf8Length
} from '../security/secret-rules.js';
import { optionalBoolean, optionalInt } from './args.js';
import type { RuntimeToolResult } from './types.js';

export const NETWORK_BUFFER_SIZE = 500;
/** sessionStorage flag: capture bodies from the next page load on (set before a reload). */
export const NETWORK_BODIES_FLAG = 'svelte-grab-network-bodies';
/** Request bodies kept (internal, for the security scan). */
export const MAX_REQUEST_BODY_KEPT = 4_096;
/** Largest response body read when body capture is on. */
export const MAX_RESPONSE_BODY_READ = 65_536;
/** Body excerpt returned by `ui_network({ includeBodies: true })`. */
export const BODY_EXCERPT_LENGTH = 2_048;
/** Per-request lines in the text output. */
export const MAX_TEXT_REQUESTS = 120;
/** Requests listed in `data.requests`. */
const MAX_DATA_REQUESTS = 300;
/** Default/max `waitMs` (the page waits before reporting). Must match src/mcp/runtime/network-tool.ts. */
export const DEFAULT_NETWORK_WAIT_MS = 2_000;
export const MAX_NETWORK_WAIT_MS = 30_000;
/** Wrapper start vs resource-timing start tolerance when merging (ms). */
const MERGE_WINDOW_MS = 1_500;
/** A request that starts within this long after another one ended is chained to it. */
const CHAIN_GAP_MS = 50;

export type NetworkType =
	| 'document'
	| 'fetch'
	| 'xhr'
	| 'beacon'
	| 'websocket'
	| 'eventsource'
	| 'script'
	| 'stylesheet'
	| 'image'
	| 'font'
	| 'media'
	| 'other';

export const NETWORK_TYPES: readonly NetworkType[] = [
	'document',
	'fetch',
	'xhr',
	'beacon',
	'websocket',
	'eventsource',
	'script',
	'stylesheet',
	'image',
	'font',
	'media',
	'other'
];

export interface NetworkInitiator {
	/** Shortened path (`src/lib/api.ts`). */
	file: string;
	line: number;
	column: number;
	/** Component of the nearest `.svelte` frame, when any. */
	component: string | null;
}

export interface NetworkEntry {
	id: number;
	type: NetworkType;
	/** Seen by a wrapper (true) or only by resource timing (false). */
	wrapped: boolean;
	method: string;
	/** Absolute URL. Internal: output always goes through `redactUrl`. */
	url: string;
	/** `performance.now()` scale (ms since navigation start). */
	start: number;
	end: number | null;
	/** HTTP status; 0 = network error / opaque; null = unknown or pending. */
	status: number | null;
	error: string | null;
	/** Bytes over the wire (resource timing; 0 = cache or cross-origin without TAO). */
	transferSize: number | null;
	/** Body bytes (decoded size, else content-length). */
	bodySize: number | null;
	contentType: string | null;
	initiator: NetworkInitiator | null;
	/** Resource timing initiatorType, when seen there. */
	initiatorType: string | null;
	/** `sveltekit-data`, `sveltekit-route`, `remote-function`, `vite-dev`. */
	tags: string[];
	/** Request header names (lowercase) -> values. Internal. */
	requestHeaders: Record<string, string>;
	/** String request body, truncated. Internal. */
	requestBody: string | null;
	requestBodySize: number | null;
	/** Response body (body capture on only). Internal. */
	responseBody: string | null;
	/** WebSocket / EventSource traffic. */
	messages?: { sent: number; received: number; bytesSent: number; bytesReceived: number };
	/** Merged with its resource timing entry. */
	timed: boolean;
}

export interface NetworkCaptureOptions {
	/** Window whose network APIs are wrapped. Defaults to `window`. */
	target?: Window | null;
	size?: number;
}

type FetchFn = typeof fetch;
type AnyFn = (...args: unknown[]) => unknown;

/** Frames of this module never count as the initiator. */
const OWN_FRAME = /runtime\/network\.(?:ts|js)/;
const NO_FILE_FRAME = /<anonymous>|^:|\), /;
const MCP_PATHS = new Set(['/health', '/events', '/context', '/mcp']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function nowMs(target: Window | null): number {
	const perf =
		(target as { performance?: Performance } | null)?.performance ?? globalThis.performance;
	return perf && typeof perf.now === 'function' ? perf.now() : Date.now();
}

function timeOrigin(target: Window | null): number {
	const perf =
		(target as { performance?: Performance } | null)?.performance ?? globalThis.performance;
	return perf && typeof perf.timeOrigin === 'number' ? perf.timeOrigin : 0;
}

function pageHref(target: Window | null): string {
	try {
		return (target as { location?: Location } | null)?.location?.href ?? 'http://localhost/';
	} catch {
		return 'http://localhost/';
	}
}

/** Absolute URL for `input` relative to the page, or the input as a string. */
export function absoluteUrl(input: unknown, base: string): string {
	try {
		return new URL(String(input), base).href;
	} catch {
		return String(input);
	}
}

/** Tags for SvelteKit / Vite URLs (Kit 3: `__data.json`, `__route.js`, `/_app/remote/<id>`). */
export function urlTags(url: string): string[] {
	let path: string;
	try {
		path = new URL(url).pathname;
	} catch {
		path = url.replace(/[?#].*$/, '');
	}
	const tags: string[] = [];
	if (path.endsWith('/__data.json') || path.endsWith('.html__data.json'))
		tags.push('sveltekit-data');
	if (path.endsWith('/__route.js') || path.endsWith('.html__route.js'))
		tags.push('sveltekit-route');
	// Kit 3 remote functions: `${base}/${appDir}/remote/<id>[/<payload>]`, appDir `_app` by default.
	if (/\/_app\/remote\//.test(path)) tags.push('remote-function');
	if (/^\/(?:@vite\/|@fs\/|@id\/|node_modules\/\.vite\/)/.test(path)) tags.push('vite-dev');
	return tags;
}

/**
 * svelte-grab's own traffic: the MCP server (another loopback origin; its
 * endpoints) and the Vite plugin / editor endpoints on the page origin.
 */
export function isOwnTraffic(url: string, pageUrl: string): boolean {
	try {
		const u = new URL(url, pageUrl);
		const page = new URL(pageUrl);
		if (u.origin === page.origin) {
			return u.pathname.startsWith('/__svelte-grab/') || u.pathname.startsWith('/__open-in-editor');
		}
		if (!LOOPBACK.has(u.hostname)) return false;
		return MCP_PATHS.has(u.pathname) || u.pathname.startsWith('/runtime/');
	} catch {
		return false;
	}
}

/** First app frame of a stack (+ component of the nearest .svelte frame). */
export function initiatorFromStack(stack: string | undefined): NetworkInitiator | null {
	if (!stack) return null;
	const frames = filterFrames(parseStackTrace(stack)).filter(
		(f) => !OWN_FRAME.test(f.file) && !NO_FILE_FRAME.test(f.file)
	);
	const frame = frames[0];
	if (!frame) return null;
	const svelteFrame = findSvelteFrame(frames);
	return {
		file: shortenFramePath(frame.file),
		line: frame.line,
		column: frame.column,
		component: svelteFrame ? extractComponentFromFrame(svelteFrame) : null
	};
}

/** Resource timing initiatorType + URL -> our type. */
export function typeFromResource(initiatorType: string, url: string): NetworkType {
	const path = url.replace(/[?#].*$/, '').toLowerCase();
	switch (initiatorType) {
		case 'fetch':
			return 'fetch';
		case 'xmlhttprequest':
			return 'xhr';
		case 'beacon':
			return 'beacon';
		case 'navigation':
			return 'document';
		case 'script':
			return 'script';
		case 'img':
		case 'image':
		case 'input':
			return 'image';
		case 'audio':
		case 'video':
		case 'track':
			return 'media';
		case 'iframe':
		case 'frame':
			return 'document';
		default:
			break;
	}
	if (/\.(?:woff2?|ttf|otf|eot)$/.test(path)) return 'font';
	if (/\.css$/.test(path)) return 'stylesheet';
	if (/\.(?:png|jpe?g|gif|webp|avif|svg|ico)$/.test(path)) return 'image';
	if (/\.(?:m?js|ts|svelte|jsx|tsx)$/.test(path)) return 'script';
	if (initiatorType === 'link' || initiatorType === 'css') return 'stylesheet';
	return 'other';
}

function headersToRecord(headers: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (!headers) return out;
	try {
		if (typeof (headers as Headers).forEach === 'function' && !Array.isArray(headers)) {
			(headers as Headers).forEach((value, key) => {
				out[key.toLowerCase()] = String(value);
			});
			return out;
		}
		const pairs = Array.isArray(headers)
			? headers
			: Object.entries(headers as Record<string, unknown>);
		for (const pair of pairs as [unknown, unknown][]) {
			if (Array.isArray(pair) && pair.length >= 2)
				out[String(pair[0]).toLowerCase()] = String(pair[1]);
		}
	} catch {
		// unreadable headers: record none
	}
	return out;
}

/** Size + kept text of a request body, without consuming streams. */
function describeBody(body: unknown): { size: number | null; text: string | null } {
	if (body === undefined || body === null) return { size: null, text: null };
	try {
		if (typeof body === 'string')
			return { size: utf8Length(body), text: body.slice(0, MAX_REQUEST_BODY_KEPT) };
		if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
			const s = body.toString();
			return { size: utf8Length(s), text: s.slice(0, MAX_REQUEST_BODY_KEPT) };
		}
		if (typeof Blob !== 'undefined' && body instanceof Blob) return { size: body.size, text: null };
		if (body instanceof ArrayBuffer) return { size: body.byteLength, text: null };
		if (ArrayBuffer.isView(body)) return { size: body.byteLength, text: null };
	} catch {
		// unknown body type
	}
	return { size: null, text: null };
}

function errorText(err: unknown): string {
	if (err && typeof err === 'object' && 'name' in err) {
		const e = err as { name?: unknown; message?: unknown };
		if (e.name === 'AbortError') return 'aborted';
		return `${String(e.name)}: ${String(e.message ?? '')}`.slice(0, 200);
	}
	return String(err).slice(0, 200);
}

function sameOrigin(url: string, pageUrl: string): boolean {
	try {
		return new URL(url).origin === new URL(pageUrl).origin;
	} catch {
		return false;
	}
}

function readFlag(target: Window | null): boolean {
	try {
		const storage = (target as { sessionStorage?: Storage } | null)?.sessionStorage;
		if (!storage) return false;
		const on = storage.getItem(NETWORK_BODIES_FLAG) === '1';
		if (on) storage.removeItem(NETWORK_BODIES_FLAG);
		return on;
	} catch {
		return false;
	}
}

export class NetworkCapture {
	private buffer: NetworkEntry[] = [];
	private nextId = 1;
	private retainCount = 0;
	private earlyHeld = false;
	private cleanup: (() => void)[] = [];
	private readonly opts: NetworkCaptureOptions;
	/** URLs of our own requests (security-scan HEAD) to drop from resource timing. */
	private ownUrls = new Map<string, number>();
	private original: { fetch?: FetchFn } = {};
	private seenResources = new Set<string>();
	/** Read same-origin JSON response bodies (includeBodies). */
	bodies = false;

	constructor(options: NetworkCaptureOptions = {}) {
		this.opts = options;
	}

	private get target(): Window | null {
		if (this.opts.target !== undefined) return this.opts.target;
		return typeof window === 'undefined' ? null : window;
	}

	get active(): boolean {
		return this.retainCount > 0;
	}

	/** `performance.timeOrigin` of the page (epoch ms of navigation start). */
	get timeOrigin(): number {
		return timeOrigin(this.target);
	}

	retain(): void {
		this.retainCount++;
		if (this.retainCount === 1) this.install();
	}

	release(): void {
		if (this.retainCount === 0) return;
		this.retainCount--;
		if (this.retainCount === 0) this.uninstall();
	}

	/** Early hold taken at module evaluation (idempotent). */
	holdEarly(): void {
		if (this.earlyHeld) return;
		this.earlyHeld = true;
		this.retain();
	}

	/** Drop the early hold (idempotent): uninstalls unless the runtime retained. */
	releaseEarly(): void {
		if (!this.earlyHeld) return;
		this.earlyHeld = false;
		this.release();
	}

	/** Snapshot of the buffer, oldest first (resource entries flushed first). */
	entries(): NetworkEntry[] {
		this.flushResources();
		return this.buffer.map((e) => ({
			...e,
			tags: [...e.tags],
			requestHeaders: { ...e.requestHeaders },
			initiator: e.initiator ? { ...e.initiator } : null,
			messages: e.messages ? { ...e.messages } : undefined
		}));
	}

	clear(): void {
		this.buffer = [];
	}

	/**
	 * `fetch` that is never recorded (svelte-grab's own requests, e.g. the
	 * security scan's HEAD), also dropped from resource timing.
	 */
	ownFetch(input: string, init?: RequestInit): Promise<Response> {
		const target = this.target;
		const f =
			this.original.fetch ?? (target as { fetch?: FetchFn } | null)?.fetch ?? globalThis.fetch;
		const url = absoluteUrl(input, pageHref(target));
		this.ownUrls.set(url, (this.ownUrls.get(url) ?? 0) + 1);
		return f.call(target ?? globalThis, input, init);
	}

	/** Add an entry (wrappers call this; also a test seam). */
	record(partial: Partial<NetworkEntry> & Pick<NetworkEntry, 'type' | 'url'>): NetworkEntry {
		const entry: NetworkEntry = {
			id: this.nextId++,
			wrapped: true,
			method: 'GET',
			start: nowMs(this.target),
			end: null,
			status: null,
			error: null,
			transferSize: null,
			bodySize: null,
			contentType: null,
			initiator: null,
			initiatorType: null,
			tags: urlTags(partial.url),
			requestHeaders: {},
			requestBody: null,
			requestBodySize: null,
			responseBody: null,
			timed: false,
			...partial
		};
		this.buffer.push(entry);
		const size = this.opts.size ?? NETWORK_BUFFER_SIZE;
		if (this.buffer.length > size) this.buffer.splice(0, this.buffer.length - size);
		return entry;
	}

	private shouldSkip(url: string): boolean {
		return isOwnTraffic(url, pageHref(this.target));
	}

	/** Merge or add one resource timing entry. */
	ingestResource(e: PerformanceResourceTiming): void {
		if (!e) return;
		const seenKey = `${e.name}|${e.startTime}|${e.initiatorType}`;
		if (this.seenResources.has(seenKey)) return;
		this.seenResources.add(seenKey);
		const url = e.name;
		if (this.shouldSkip(url)) return;
		const own = this.ownUrls.get(url);
		if (own) {
			if (own <= 1) this.ownUrls.delete(url);
			else this.ownUrls.set(url, own - 1);
			return;
		}
		const type = typeFromResource(e.initiatorType, url);
		const status =
			typeof (e as { responseStatus?: number }).responseStatus === 'number' &&
			(e as { responseStatus?: number }).responseStatus! > 0
				? (e as { responseStatus?: number }).responseStatus!
				: null;
		const bodySize = e.decodedBodySize || e.encodedBodySize || null;
		const end = e.responseEnd > 0 ? e.responseEnd : e.startTime + e.duration;

		if (type === 'fetch' || type === 'xhr' || type === 'beacon' || type === 'other') {
			// `other`: EventSource streams show up with that initiatorType.
			const match = this.buffer.find(
				(x) =>
					x.wrapped &&
					!x.timed &&
					x.url === url &&
					(x.type === type || (type === 'other' && x.type === 'eventsource')) &&
					Math.abs(e.startTime - x.start) <= MERGE_WINDOW_MS
			);
			if (match) {
				match.timed = true;
				match.transferSize = e.transferSize ?? null;
				match.bodySize = bodySize ?? match.bodySize;
				match.initiatorType = e.initiatorType;
				if (end > (match.end ?? 0)) match.end = end;
				if (match.status === null && status !== null) match.status = status;
				return;
			}
		}
		this.record({
			type,
			url,
			wrapped: false,
			method: 'GET',
			start: e.startTime,
			end,
			status,
			transferSize: e.transferSize ?? null,
			bodySize,
			initiatorType: e.initiatorType,
			timed: true
		});
	}

	/** Pull resource entries the observer has not delivered yet. */
	flushResources(): void {
		const perf = (this.target as { performance?: Performance } | null)?.performance;
		if (!perf || typeof perf.getEntriesByType !== 'function') return;
		try {
			for (const e of perf.getEntriesByType('resource') as PerformanceResourceTiming[])
				this.ingestResource(e);
		} catch {
			// best effort
		}
	}

	private install(): void {
		const target = this.target;
		if (!target) return;
		if (readFlag(target)) this.bodies = true;
		this.recordNavigation(target);
		this.wrapFetch(target);
		this.wrapXhr(target);
		this.wrapBeacon(target);
		this.wrapSocket(target, 'WebSocket');
		this.wrapSocket(target, 'EventSource');
		this.observeResources(target);
	}

	private uninstall(): void {
		for (const fn of this.cleanup.splice(0).reverse()) {
			try {
				fn();
			} catch {
				// best effort
			}
		}
		this.original = {};
	}

	private recordNavigation(target: Window): void {
		try {
			const perf = (target as { performance?: Performance }).performance;
			if (!perf || typeof perf.getEntriesByType !== 'function') return;
			const nav = perf.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
			if (!nav || this.buffer.some((e) => e.type === 'document' && e.start === 0)) return;
			this.record({
				type: 'document',
				url: nav.name,
				wrapped: false,
				method: 'GET',
				start: 0,
				end: nav.responseEnd || null,
				status: (nav as { responseStatus?: number }).responseStatus || null,
				transferSize: nav.transferSize ?? null,
				bodySize: nav.decodedBodySize || nav.encodedBodySize || null,
				initiatorType: 'navigation',
				timed: true
			});
		} catch {
			// no navigation timing
		}
	}

	private observeResources(target: Window): void {
		const PO = (target as unknown as { PerformanceObserver?: typeof PerformanceObserver })
			.PerformanceObserver;
		this.flushResources();
		if (typeof PO !== 'function') return;
		try {
			const po = new PO((list) => {
				try {
					for (const e of list.getEntries() as PerformanceResourceTiming[]) this.ingestResource(e);
				} catch {
					// never break the page
				}
			});
			po.observe({ type: 'resource', buffered: true });
			this.cleanup.push(() => po.disconnect());
		} catch {
			// unsupported: flushResources() on read still covers it
		}
	}

	private wrapFetch(target: Window): void {
		const t = target as unknown as { fetch?: FetchFn };
		const original = t.fetch;
		if (typeof original !== 'function') return;
		this.original.fetch = original;
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const capture = this;
		let enabled = true;
		const wrapped = function fetch(this: unknown, ...args: unknown[]): Promise<Response> {
			if (!enabled) return original.apply(this, args as Parameters<FetchFn>);
			let entry: NetworkEntry | null = null;
			try {
				entry = capture.startFetch(args[0], args[1] as RequestInit | undefined, new Error().stack);
			} catch {
				entry = null;
			}
			// Synchronous throws (bad arguments) propagate untouched.
			const promise = original.apply(this, args as Parameters<FetchFn>);
			if (!entry) return promise;
			const e = entry;
			return promise.then(
				(res) => {
					try {
						capture.finishFetch(e, res);
					} catch {
						// never break the page
					}
					return res;
				},
				(err: unknown) => {
					try {
						e.end = nowMs(capture.target);
						e.status = 0;
						e.error = errorText(err);
					} catch {
						// never break the page
					}
					throw err;
				}
			);
		};
		t.fetch = wrapped as FetchFn;
		this.cleanup.push(() => {
			enabled = false;
			if (t.fetch === (wrapped as FetchFn)) t.fetch = original;
		});
	}

	private startFetch(
		input: unknown,
		init: RequestInit | undefined,
		stack: string | undefined
	): NetworkEntry | null {
		const page = pageHref(this.target);
		const isRequest = typeof Request !== 'undefined' && input instanceof Request;
		const url = absoluteUrl(
			isRequest ? (input as Request).url : input instanceof URL ? input.href : input,
			page
		);
		if (this.shouldSkip(url)) return null;
		const method = String(
			init?.method ?? (isRequest ? (input as Request).method : 'GET')
		).toUpperCase();
		const headers =
			init?.headers !== undefined
				? headersToRecord(init.headers)
				: isRequest
					? headersToRecord((input as Request).headers)
					: {};
		const body = describeBody(init?.body);
		return this.record({
			type: 'fetch',
			url,
			method,
			requestHeaders: headers,
			requestBody: body.text,
			requestBodySize: body.size,
			initiator: initiatorFromStack(stack)
		});
	}

	private finishFetch(entry: NetworkEntry, res: Response): void {
		entry.end = Math.max(entry.end ?? 0, nowMs(this.target));
		entry.status = res.type === 'opaque' || res.type === 'opaqueredirect' ? 0 : res.status;
		const ct = res.headers?.get?.('content-type') ?? null;
		entry.contentType = ct;
		const len = Number(res.headers?.get?.('content-length'));
		if (
			entry.bodySize === null &&
			Number.isFinite(len) &&
			len >= 0 &&
			res.headers?.get?.('content-length') !== null
		) {
			entry.bodySize = len;
		}
		if (
			this.bodies &&
			ct &&
			/json/i.test(ct) &&
			sameOrigin(entry.url, pageHref(this.target)) &&
			!(Number.isFinite(len) && len > MAX_RESPONSE_BODY_READ) &&
			typeof res.clone === 'function'
		) {
			res
				.clone()
				.text()
				.then(
					(text) => {
						entry.responseBody = text.slice(0, MAX_RESPONSE_BODY_READ);
						if (entry.bodySize === null) entry.bodySize = utf8Length(text);
					},
					() => {}
				);
		}
	}

	private wrapXhr(target: Window): void {
		const XHR = (target as unknown as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest;
		const proto = XHR?.prototype as (XMLHttpRequest & Record<string, AnyFn>) | undefined;
		if (!proto || typeof proto.open !== 'function' || typeof proto.send !== 'function') return;
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const capture = this;
		const state = new WeakMap<
			XMLHttpRequest,
			{ method: string; url: string; headers: Record<string, string> }
		>();
		let enabled = true;
		const origOpen = proto.open as AnyFn;
		const origSend = proto.send as AnyFn;
		const origSetHeader = proto.setRequestHeader as AnyFn;

		const open = function open(this: XMLHttpRequest, ...args: unknown[]) {
			if (enabled) {
				try {
					state.set(this, {
						method: String(args[0] ?? 'GET').toUpperCase(),
						url: absoluteUrl(args[1], pageHref(capture.target)),
						headers: {}
					});
				} catch {
					// never break the page
				}
			}
			return origOpen.apply(this, args);
		};
		const setRequestHeader = function setRequestHeader(this: XMLHttpRequest, ...args: unknown[]) {
			if (enabled) {
				try {
					const s = state.get(this);
					if (s) s.headers[String(args[0]).toLowerCase()] = String(args[1]);
				} catch {
					// never break the page
				}
			}
			return origSetHeader.apply(this, args);
		};
		const send = function send(this: XMLHttpRequest, ...args: unknown[]) {
			if (enabled) {
				try {
					capture.startXhr(this, state.get(this), args[0], new Error().stack);
				} catch {
					// never break the page
				}
			}
			return origSend.apply(this, args);
		};
		proto.open = open as XMLHttpRequest['open'];
		proto.setRequestHeader = setRequestHeader as XMLHttpRequest['setRequestHeader'];
		proto.send = send as XMLHttpRequest['send'];
		this.cleanup.push(() => {
			enabled = false;
			if (proto.open === (open as unknown)) proto.open = origOpen as XMLHttpRequest['open'];
			if (proto.setRequestHeader === (setRequestHeader as unknown)) {
				proto.setRequestHeader = origSetHeader as XMLHttpRequest['setRequestHeader'];
			}
			if (proto.send === (send as unknown)) proto.send = origSend as XMLHttpRequest['send'];
		});
	}

	private startXhr(
		xhr: XMLHttpRequest,
		s: { method: string; url: string; headers: Record<string, string> } | undefined,
		body: unknown,
		stack: string | undefined
	): void {
		if (!s || this.shouldSkip(s.url)) return;
		const b = describeBody(body);
		const entry = this.record({
			type: 'xhr',
			url: s.url,
			method: s.method,
			requestHeaders: { ...s.headers },
			requestBody: b.text,
			requestBodySize: b.size,
			initiator: initiatorFromStack(stack)
		});
		xhr.addEventListener('loadend', () => {
			try {
				entry.end = Math.max(entry.end ?? 0, nowMs(this.target));
				entry.status = xhr.status;
				if (xhr.status === 0) entry.error = entry.error ?? 'network error or aborted';
				const ct = xhr.getResponseHeader('content-type');
				entry.contentType = ct;
				const len = Number(xhr.getResponseHeader('content-length'));
				if (
					entry.bodySize === null &&
					Number.isFinite(len) &&
					xhr.getResponseHeader('content-length') !== null
				) {
					entry.bodySize = len;
				}
				if (
					this.bodies &&
					ct &&
					/json/i.test(ct) &&
					(xhr.responseType === '' || xhr.responseType === 'text') &&
					sameOrigin(entry.url, pageHref(this.target))
				) {
					entry.responseBody = String(xhr.responseText ?? '').slice(0, MAX_RESPONSE_BODY_READ);
				}
			} catch {
				// never break the page
			}
		});
	}

	private wrapBeacon(target: Window): void {
		const nav = (target as unknown as { navigator?: Navigator }).navigator;
		if (!nav || typeof nav.sendBeacon !== 'function') return;
		const original = nav.sendBeacon as AnyFn;
		const hadOwn = Object.prototype.hasOwnProperty.call(nav, 'sendBeacon');
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const capture = this;
		let enabled = true;
		const wrapped = function sendBeacon(this: Navigator, ...args: unknown[]) {
			let entry: NetworkEntry | null = null;
			if (enabled) {
				try {
					const url = absoluteUrl(args[0], pageHref(capture.target));
					if (!capture.shouldSkip(url)) {
						const b = describeBody(args[1]);
						entry = capture.record({
							type: 'beacon',
							url,
							method: 'POST',
							requestBody: b.text,
							requestBodySize: b.size,
							initiator: initiatorFromStack(new Error().stack)
						});
					}
				} catch {
					entry = null;
				}
			}
			const queued = original.apply(this, args);
			if (entry && queued === false) {
				entry.status = 0;
				entry.error = 'not queued by the browser';
			}
			return queued;
		};
		try {
			Object.defineProperty(nav, 'sendBeacon', {
				value: wrapped,
				configurable: true,
				writable: true
			});
		} catch {
			return;
		}
		this.cleanup.push(() => {
			enabled = false;
			if ((nav as unknown as { sendBeacon: unknown }).sendBeacon !== wrapped) return;
			if (hadOwn)
				Object.defineProperty(nav, 'sendBeacon', {
					value: original,
					configurable: true,
					writable: true
				});
			else delete (nav as unknown as { sendBeacon?: unknown }).sendBeacon;
		});
	}

	private wrapSocket(target: Window, name: 'WebSocket' | 'EventSource'): void {
		const t = target as unknown as Record<string, unknown>;
		const Original = t[name] as (new (...args: unknown[]) => EventTarget) | undefined;
		if (typeof Original !== 'function') return;
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const capture = this;
		let enabled = true;
		const type: NetworkType = name === 'WebSocket' ? 'websocket' : 'eventsource';
		const proxy: typeof Original = new Proxy(Original, {
			construct(ctor, args, newTarget) {
				const instance = Reflect.construct(
					ctor,
					args,
					newTarget === proxy ? ctor : newTarget
				) as EventTarget;
				if (enabled) {
					try {
						capture.trackSocket(instance, type, args[0], new Error().stack);
					} catch {
						// never break the page
					}
				}
				return instance;
			}
		});
		t[name] = proxy;

		let restoreSend: (() => void) | null = null;
		if (name === 'WebSocket') {
			const proto = Original.prototype as { send?: AnyFn };
			const origSend = proto.send;
			if (typeof origSend === 'function') {
				const send = function send(this: WebSocket, ...args: unknown[]) {
					if (enabled) {
						try {
							capture.countSent(this, args[0]);
						} catch {
							// never break the page
						}
					}
					return origSend.apply(this, args);
				};
				proto.send = send;
				restoreSend = () => {
					if (proto.send === send) proto.send = origSend;
				};
			}
		}
		this.cleanup.push(() => {
			enabled = false;
			if (t[name] === proxy) t[name] = Original;
			restoreSend?.();
		});
	}

	private sockets = new WeakMap<object, NetworkEntry>();

	private trackSocket(
		instance: EventTarget,
		type: NetworkType,
		url: unknown,
		stack: string | undefined
	): void {
		const abs = absoluteUrl(url, pageHref(this.target));
		if (this.shouldSkip(abs)) return;
		const entry = this.record({
			type,
			url: abs,
			method: type === 'websocket' ? 'WS' : 'GET',
			initiator: initiatorFromStack(stack),
			messages: { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0 }
		});
		this.sockets.set(instance, entry);
		instance.addEventListener('open', () => {
			entry.status = type === 'websocket' ? 101 : 200;
		});
		instance.addEventListener('message', (event) => {
			try {
				const data = (event as MessageEvent).data;
				entry.messages!.received++;
				entry.messages!.bytesReceived += messageSize(data);
			} catch {
				// never break the page
			}
		});
		instance.addEventListener('error', () => {
			entry.error = entry.error ?? 'connection error';
		});
		instance.addEventListener('close', () => {
			entry.end = nowMs(this.target);
		});
	}

	private countSent(ws: WebSocket, data: unknown): void {
		const entry = this.sockets.get(ws);
		if (!entry?.messages) return;
		entry.messages.sent++;
		entry.messages.bytesSent += messageSize(data);
	}
}

function messageSize(data: unknown): number {
	if (typeof data === 'string') return utf8Length(data);
	if (data instanceof ArrayBuffer) return data.byteLength;
	if (ArrayBuffer.isView(data)) return data.byteLength;
	if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size;
	return 0;
}

/** The tab's capture. `startAgentRuntime` retains it while the runtime runs. */
export const networkCapture = new NetworkCapture();

/** True when this module was served by the Vite dev server (it injects `import.meta.hot`). */
export function isViteDev(): boolean {
	try {
		// Must stay the literal `import.meta.hot` (see runtime/hmr.ts): Vite only
		// injects the hot context into modules whose source contains it. Used
		// instead of Vite's env DEV flag, which the packaged library avoids
		// (svelte-package warns: it only works when bundled by Vite).
		// @ts-expect-error -- `hot` is Vite's ImportMeta augmentation (vite/client types).
		return Boolean(import.meta.hot);
	} catch {
		return false;
	}
}

/**
 * Start capturing right away (module evaluation, before the app's first
 * requests). SvelteGrab calls it at module evaluation; it only starts in the
 * Vite dev server (`import.meta.hot` present) unless `dev` says otherwise.
 * Idempotent; undo with {@link releaseEarlyNetworkCapture}.
 */
export function installNetworkCapture(
	options: { capture?: NetworkCapture; dev?: boolean } = {}
): void {
	if (typeof window === 'undefined') return;
	if (!(options.dev ?? isViteDev())) return;
	try {
		(options.capture ?? networkCapture).holdEarly();
	} catch {
		// never break the page
	}
}

/** Drop the early hold: the capture stays only while the runtime retains it. */
export function releaseEarlyNetworkCapture(capture: NetworkCapture = networkCapture): void {
	try {
		capture.releaseEarly();
	} catch {
		// best effort
	}
}

// ------------------------------------------------------------------ ui_network

export interface NetworkFilter {
	/** `first-party`, `third-party`, or an origin / host substring. */
	origin?: string;
	type?: NetworkType | NetworkType[];
	/** A status code, `failed` (0 / >= 400 / error), `ok` (2xx/3xx), or `4xx` / `5xx`. */
	status?: number | string;
}

export interface NetworkOptions {
	capture?: NetworkCapture;
	/** Page URL (test seam). Defaults to `location.href`. */
	pageUrl?: string;
	sleep?: (ms: number) => Promise<void>;
}

function parseSinceArg(args: Record<string, unknown>): number | 'navigation' | undefined {
	const v = args.since;
	if (v === undefined || v === null) return undefined;
	if (v === 'navigation') return 'navigation';
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	throw new Error('"since" must be an epoch ms number or "navigation"');
}

function parseFilter(args: Record<string, unknown>): NetworkFilter {
	const f = args.filter;
	if (f === undefined || f === null) return {};
	if (typeof f !== 'object' || Array.isArray(f))
		throw new Error('"filter" must be an object { origin?, type?, status? }');
	const raw = f as Record<string, unknown>;
	const out: NetworkFilter = {};
	if (raw.origin !== undefined) {
		if (typeof raw.origin !== 'string') throw new Error('"filter.origin" must be a string');
		out.origin = raw.origin;
	}
	if (raw.type !== undefined) {
		const types = Array.isArray(raw.type) ? raw.type : [raw.type];
		for (const t of types) {
			if (typeof t !== 'string' || !(NETWORK_TYPES as readonly string[]).includes(t)) {
				throw new Error(
					`Unknown filter.type ${JSON.stringify(t)}: use any of ${NETWORK_TYPES.join(', ')}`
				);
			}
		}
		out.type = types as NetworkType[];
	}
	if (raw.status !== undefined) {
		if (typeof raw.status !== 'number' && typeof raw.status !== 'string') {
			throw new Error('"filter.status" must be a number or "failed" / "ok" / "4xx" / "5xx"');
		}
		out.status = raw.status;
	}
	return out;
}

export function isFailed(e: NetworkEntry): boolean {
	return e.error !== null || e.status === 0 || (e.status !== null && e.status >= 400);
}

function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return '';
	}
}

export function isThirdParty(url: string, pageUrl: string): boolean {
	const o = originOf(url);
	if (!o || o === 'null') return false;
	const page = originOf(pageUrl);
	// ws(s):// on the page host counts as first party.
	const wsAsHttp = o.replace(/^ws(s?):/, 'http$1:');
	return o !== page && wsAsHttp !== page;
}

function matchesFilter(e: NetworkEntry, f: NetworkFilter, pageUrl: string): boolean {
	if (f.type && !(f.type as NetworkType[]).includes(e.type)) return false;
	if (f.origin) {
		const third = isThirdParty(e.url, pageUrl);
		if (f.origin === 'first-party' && third) return false;
		else if (f.origin === 'third-party' && !third) return false;
		else if (
			f.origin !== 'first-party' &&
			f.origin !== 'third-party' &&
			!originOf(e.url).includes(f.origin)
		)
			return false;
	}
	if (f.status !== undefined) {
		const s = f.status;
		if (typeof s === 'number') return e.status === s;
		if (s === 'failed') return isFailed(e);
		if (s === 'ok') return !isFailed(e) && e.status !== null;
		const m = /^([1-5])xx$/.exec(s);
		if (m) return e.status !== null && Math.floor(e.status / 100) === Number(m[1]);
		const n = Number(s);
		if (Number.isFinite(n)) return e.status === n;
		throw new Error(`Unknown filter.status ${JSON.stringify(s)}`);
	}
	return true;
}

export function formatBytes(n: number | null): string {
	if (n === null || !Number.isFinite(n)) return '?';
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

function durationOf(e: NetworkEntry): number | null {
	return e.end !== null ? Math.max(0, Math.round(e.end - e.start)) : null;
}

/** Bytes counted for totals: transfer size when known and non-zero, else body size. */
function bytesOf(e: NetworkEntry): number {
	if (e.transferSize) return e.transferSize;
	return e.bodySize ?? 0;
}

/** Sequential chains of fetch/XHR: B started within 50ms after A finished. */
export function longestChain(entries: NetworkEntry[]): NetworkEntry[] {
	const calls = entries
		.filter((e) => (e.type === 'fetch' || e.type === 'xhr') && e.end !== null)
		.sort((a, b) => a.start - b.start);
	const best: { len: number; prev: number }[] = calls.map(() => ({ len: 1, prev: -1 }));
	let top = -1;
	for (let i = 0; i < calls.length; i++) {
		for (let j = 0; j < i; j++) {
			const gap = calls[i].start - (calls[j].end as number);
			if (gap >= 0 && gap <= CHAIN_GAP_MS && best[j].len + 1 > best[i].len)
				best[i] = { len: best[j].len + 1, prev: j };
		}
		if (top === -1 || best[i].len > best[top].len) top = i;
	}
	const chain: NetworkEntry[] = [];
	for (let i = top; i !== -1; i = best[i].prev) chain.unshift(calls[i]);
	return chain.length > 1 ? chain : [];
}

function initiatorText(i: NetworkInitiator | null): string {
	if (!i) return '';
	return `${i.file}:${i.line}${i.component ? ` (${i.component})` : ''}`;
}

/** Same-origin JSON body excerpt: secrets and values under sensitive keys redacted, 2 KB. */
export function redactedBodyExcerpt(body: string): string {
	let text: string;
	try {
		const replace = (v: unknown, key: string | null, depth: number): unknown => {
			if (typeof v === 'string') {
				const keyKind = key !== null ? sensitiveKeyKind(key) : null;
				if (keyKind && isMeaningfulSecretValue(v) && !detectSecret(v)) return redact(v, keyKind);
				return redactText(v);
			}
			if (depth > 20 || !v || typeof v !== 'object') return v;
			if (Array.isArray(v)) return v.map((x) => replace(x, key, depth + 1));
			const out: Record<string, unknown> = {};
			for (const [k, x] of Object.entries(v as Record<string, unknown>))
				out[k] = replace(x, k, depth + 1);
			return out;
		};
		text = JSON.stringify(replace(JSON.parse(body), null, 0));
	} catch {
		text = redactText(body);
	}
	return text.length > BODY_EXCERPT_LENGTH ? text.slice(0, BODY_EXCERPT_LENGTH - 1) + '…' : text;
}

export interface NetworkRequestView extends Record<string, unknown> {
	id: number;
	type: NetworkType;
	method: string;
	/** Redacted URL. */
	url: string;
	status: number | null;
	error: string | null;
	thirdParty: boolean;
	startMs: number;
	durationMs: number | null;
	transferSize: number | null;
	bodySize: number | null;
	contentType: string | null;
	initiator: NetworkInitiator | null;
	tags: string[];
	messages?: NetworkEntry['messages'];
	body?: string;
}

/** Summarize entries (already filtered). */
export function summarizeNetwork(
	entries: NetworkEntry[],
	pageUrl: string,
	options: { includeBodies?: boolean; bodiesCaptured?: boolean; header?: string } = {}
): RuntimeToolResult {
	const views: NetworkRequestView[] = entries.map((e) => {
		const v: NetworkRequestView = {
			id: e.id,
			type: e.type,
			method: e.method,
			url: redactUrl(e.url).redacted,
			status: e.status,
			error: e.error,
			thirdParty: isThirdParty(e.url, pageUrl),
			startMs: Math.round(e.start),
			durationMs: durationOf(e),
			transferSize: e.transferSize,
			bodySize: e.bodySize,
			contentType: e.contentType,
			initiator: e.initiator,
			tags: e.tags
		};
		if (e.messages) v.messages = e.messages;
		if (options.includeBodies && e.responseBody) v.body = redactedBodyExcerpt(e.responseBody);
		return v;
	});

	const byType: Record<string, { count: number; bytes: number }> = {};
	const byOrigin: Record<string, { count: number; bytes: number; thirdParty: boolean }> = {};
	let bytes = 0;
	let third = 0;
	entries.forEach((e, i) => {
		const b = bytesOf(e);
		bytes += b;
		(byType[e.type] ??= { count: 0, bytes: 0 }).count++;
		byType[e.type].bytes += b;
		const o = originOf(e.url) || '(none)';
		(byOrigin[o] ??= { count: 0, bytes: 0, thirdParty: views[i].thirdParty }).count++;
		byOrigin[o].bytes += b;
		if (views[i].thirdParty) third++;
	});

	const groups = new Map<string, NetworkRequestView[]>();
	for (const v of views) {
		if (v.type === 'document') continue;
		const key = `${v.method} ${v.url}`;
		const list = groups.get(key) ?? [];
		list.push(v);
		groups.set(key, list);
	}
	const duplicates = [...groups.entries()]
		.filter(([, list]) => list.length > 1)
		.map(([key, list]) => ({
			request: key,
			count: list.length,
			ids: list.map((v) => v.id),
			initiators: [...new Set(list.map((v) => initiatorText(v.initiator)).filter(Boolean))]
		}))
		.sort((a, b) => b.count - a.count);

	const slowest = views
		.filter((v) => v.durationMs !== null && v.type !== 'websocket' && v.type !== 'eventsource')
		.sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
		.slice(0, 5);
	const failed = views.filter((v, i) => isFailed(entries[i]));
	const chain = longestChain(entries);

	const lines: string[] = [];
	if (options.header) lines.push(options.header);
	const typeSummary = Object.entries(byType)
		.sort((a, b) => b[1].count - a[1].count)
		.map(([t, s]) => `${t} ${s.count}`)
		.join(', ');
	lines.push(
		`NETWORK ${entries.length} requests, ${formatBytes(bytes)} transferred, ${entries.length - third} first-party / ${third} third-party` +
			(typeSummary ? ` (${typeSummary})` : '')
	);
	const origins = Object.entries(byOrigin).sort((a, b) => b[1].count - a[1].count);
	if (origins.length > 0) {
		lines.push('ORIGINS');
		for (const [o, s] of origins.slice(0, 10)) {
			lines.push(
				`  ${s.thirdParty ? 'third-party' : 'first-party'} ${o} ${s.count} req ${formatBytes(s.bytes)}`
			);
		}
	}
	if (duplicates.length > 0) {
		lines.push(`DUPLICATES ${duplicates.length}`);
		for (const d of duplicates.slice(0, 10)) {
			lines.push(
				`  x${d.count} ${d.request}${d.initiators.length ? ` <- ${d.initiators.join(', ')}` : ''}`
			);
		}
	}
	if (slowest.length > 0) {
		lines.push('SLOWEST');
		for (const v of slowest) lines.push(`  #${v.id} ${v.durationMs}ms ${v.method} ${v.url}`);
	}
	if (chain.length > 1) {
		lines.push(
			`WATERFALL sequential chain of ${chain.length} (each started right after the previous finished)`
		);
		for (const e of chain) lines.push(`  #${e.id} ${e.method} ${redactUrl(e.url).redacted}`);
	}
	if (failed.length > 0) {
		lines.push(`FAILED ${failed.length}`);
		for (const v of failed.slice(0, 20)) {
			lines.push(
				`  #${v.id} ${v.status ?? '-'} ${v.method} ${v.url}${v.error ? ` (${v.error})` : ''}`
			);
		}
	}
	lines.push('REQUESTS (#id method status type size duration url <- initiator [tags])');
	for (const v of views.slice(-MAX_TEXT_REQUESTS)) {
		const parts = [
			`#${v.id}`,
			v.method,
			v.status === null ? (v.error ? 'ERR' : '...') : String(v.status),
			v.type,
			formatBytes(v.transferSize || v.bodySize),
			v.durationMs === null ? '-' : `${v.durationMs}ms`,
			v.url
		];
		let line = `  ${parts.join(' ')}`;
		if (v.thirdParty) line += ' (third-party)';
		if (v.messages) line += ` msgs ${v.messages.sent} sent/${v.messages.received} received`;
		if (v.initiator) line += ` <- ${initiatorText(v.initiator)}`;
		const tags = v.tags.filter((t) => t !== 'vite-dev');
		if (tags.length) line += ` [${tags.join(', ')}]`;
		lines.push(line);
		if (v.body) lines.push(`    body: ${v.body}`);
	}
	if (views.length > MAX_TEXT_REQUESTS)
		lines.push(`  (${views.length - MAX_TEXT_REQUESTS} older requests omitted; use filter)`);
	if (options.includeBodies && !options.bodiesCaptured) {
		lines.push(
			'# Bodies are captured from now on (same-origin JSON, <= 64KB). For the page load, call ui_network({ reload: true, includeBodies: true }).'
		);
	}

	return {
		text: lines.join('\n'),
		data: {
			totals: {
				count: entries.length,
				bytes,
				firstParty: entries.length - third,
				thirdParty: third
			},
			byType,
			byOrigin,
			duplicates,
			slowest: slowest.map((v) => ({ id: v.id, durationMs: v.durationMs, url: v.url })),
			chain: chain.map((e) => e.id),
			failed: failed.map((v) => v.id),
			requests: views.slice(-MAX_DATA_REQUESTS)
		}
	};
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `ui_network({ since?, waitMs?, filter?, includeBodies? })`. `reload` is
 * orchestrated by the MCP server (`ui_network_reload` + re-hello + this call
 * with `since: 'navigation'`), so the page refuses it here.
 */
export async function uiNetwork(
	args: Record<string, unknown>,
	options: NetworkOptions = {}
): Promise<RuntimeToolResult> {
	const capture = options.capture ?? networkCapture;
	if (args.reload === true) {
		throw new Error(
			'reload is orchestrated by the MCP server: call the ui_network MCP tool with reload: true'
		);
	}
	const since = parseSinceArg(args);
	const filter = parseFilter(args);
	const includeBodies = optionalBoolean(args, 'includeBodies') === true;
	const waitMs = optionalInt(args, 'waitMs', 0, 0, MAX_NETWORK_WAIT_MS);
	const after = args.afterTimeOrigin;
	if (typeof after === 'number' && Number.isFinite(after) && capture.timeOrigin <= after) {
		throw new Error('page has not reloaded yet');
	}
	const bodiesCaptured = capture.bodies;
	if (includeBodies) capture.bodies = true;
	if (waitMs > 0) await (options.sleep ?? defaultSleep)(waitMs);

	const pageUrl =
		options.pageUrl ?? (typeof location !== 'undefined' ? location.href : 'http://localhost/');
	const origin = capture.timeOrigin;
	let entries = capture.entries();
	if (typeof since === 'number') entries = entries.filter((e) => origin + e.start >= since);
	entries = entries.filter((e) => matchesFilter(e, filter, pageUrl));
	const result = summarizeNetwork(entries, pageUrl, {
		includeBodies,
		bodiesCaptured,
		header: `# page ${redactUrl(pageUrl).redacted} loaded ${new Date(origin || Date.now()).toISOString()}`
	});
	result.data = { ...result.data, timeOrigin: origin, bodies: capture.bodies };
	return result;
}

/**
 * `ui_network_reload` (server-orchestrated part of `ui_network({ reload })`):
 * persist the body-capture flag, schedule `location.reload()` after the reply
 * had time to leave, and answer with the current `timeOrigin` so the server
 * can tell the reloaded page from this one.
 */
export function uiNetworkReload(
	args: Record<string, unknown>,
	options: { capture?: NetworkCapture; reload?: () => void; delayMs?: number } = {}
): RuntimeToolResult {
	const capture = options.capture ?? networkCapture;
	if (optionalBoolean(args, 'includeBodies') === true) {
		try {
			sessionStorage.setItem(NETWORK_BODIES_FLAG, '1');
		} catch {
			// no storage: bodies are not captured across the reload
		}
	}
	const reload = options.reload ?? (() => location.reload());
	setTimeout(reload, options.delayMs ?? 150);
	return { text: 'reloading', data: { reloading: true, timeOrigin: capture.timeOrigin } };
}
