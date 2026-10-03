/**
 * Find the svelte-grab MCP server when it fell back to another port.
 *
 * The server tries `port .. port + MCP_PORT_RANGE_SIZE - 1` when the requested
 * port is busy and reports itself on `GET /health` as
 * `{ service: 'svelte-grab-mcp', port, portFallback, ... }`. The page checks the
 * configured `mcpPort` first; when that fails or answers as another service, it
 * probes the rest of the range and uses the first port that is svelte-grab.
 *
 * Results are cached per page load (module scope). A miss is not cached, so a
 * later mount re-probes once the server is up.
 */
import { HEALTH_CHECK_TIMEOUT_MS, MCP_PORT_RANGE_SIZE, MCP_SERVICE_ID } from './mcp-constants.js';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ResolveMcpPortOptions {
	/** Host of the MCP server. Default `localhost`. */
	host?: string;
	/** Per-request `/health` timeout. Default HEALTH_CHECK_TIMEOUT_MS. */
	timeoutMs?: number;
	/** Where the "picked port N" notice goes. Default `console.log`. */
	log?: (message: string) => void;
	/** Test seam. Defaults to the global `fetch`. */
	fetch?: FetchFn;
}

const cache = new Map<string, Promise<number | null>>();

/** Test helper: forget the per-page-load cache. */
export function resetMcpPortCacheForTests(): void {
	cache.clear();
}

/** True when `GET http://host:port/health` answers as the svelte-grab MCP server. */
export async function isSvelteGrabMcp(
	host: string,
	port: number,
	doFetch: FetchFn,
	timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS
): Promise<boolean> {
	const controller = typeof AbortController === 'function' ? new AbortController() : null;
	const timer = setTimeout(() => controller?.abort(), timeoutMs);
	try {
		const res = await doFetch(`http://${host}:${port}/health`, {
			method: 'GET',
			signal: controller?.signal
		});
		if (!res.ok) return false;
		const body = (await res.json()) as { service?: unknown } | null;
		return !!body && body.service === MCP_SERVICE_ID;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

async function probe(host: string, port: number, options: ResolveMcpPortOptions, doFetch: FetchFn): Promise<number | null> {
	const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
	if (await isSvelteGrabMcp(host, port, doFetch, timeoutMs)) return port;

	const candidates: number[] = [];
	for (let p = port + 1; p < port + MCP_PORT_RANGE_SIZE && p <= 65535; p++) candidates.push(p);
	// In parallel so a hanging port costs one timeout, not one per port.
	const hits = await Promise.all(candidates.map((p) => isSvelteGrabMcp(host, p, doFetch, timeoutMs)));
	const index = hits.indexOf(true);
	if (index === -1) return null;

	const picked = candidates[index];
	(options.log ?? console.log)(
		`[SvelteGrab] MCP server not found on port ${port}; using port ${picked} (fallback found via /health).`
	);
	return picked;
}

/**
 * Port to use for the MCP server: `port` when it is svelte-grab, else the first
 * svelte-grab port in `port + 1 .. port + MCP_PORT_RANGE_SIZE - 1`, else `port`
 * (nothing found; callers keep retrying it as before).
 */
export async function resolveMcpPort(port: number, options: ResolveMcpPortOptions = {}): Promise<number> {
	const doFetch: FetchFn | undefined =
		options.fetch ?? (typeof fetch === 'function' ? (i, init) => fetch(i, init) : undefined);
	if (!doFetch) return port;
	const host = options.host ?? 'localhost';
	const key = `${host}:${port}`;

	let pending = cache.get(key);
	if (!pending) {
		pending = probe(host, port, options, doFetch);
		cache.set(key, pending);
		pending.then(
			(found) => {
				if (found === null && cache.get(key) === pending) cache.delete(key);
			},
			() => cache.delete(key)
		);
	}
	return (await pending) ?? port;
}
