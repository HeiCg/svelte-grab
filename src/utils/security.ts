/**
 * Shared security helpers for the relay (WebSocket) and MCP (HTTP) servers.
 *
 * THREAT MODEL: both servers bridge a browser page -> server -> a local coding
 * agent that executes shell commands. Without these checks, ANY web page the dev
 * visits (or any host on the LAN) could drive arbitrary local code execution.
 *
 * Defenses (all dev-only; this tool must never be exposed to a network):
 *  - Bind to loopback only (handled at each server's listen call).
 *  - Origin allowlist: reject browser connections whose Origin is not localhost.
 *  - Optional bearer token: opt-in defense against non-browser local processes.
 */

import { randomUUID } from 'node:crypto';

export const LOOPBACK_HOST = '127.0.0.1';

/** Env var (comma-separated) to extend the default localhost Origin allowlist. */
export const ALLOWED_ORIGINS_ENV = 'SVELTE_GRAB_ALLOWED_ORIGINS';
/** Env var to enable/provide the optional bearer token. */
export const TOKEN_ENV = 'SVELTE_GRAB_TOKEN';
/** Header clients may use to present the token (alternative to ?token=). */
export const TOKEN_HEADER = 'x-svelte-grab-token';

export interface SecurityOptions {
	/**
	 * Extra allowed Origins (in addition to the always-allowed localhost set).
	 * Each entry should be a full origin like "https://example.com".
	 * Merged with the SVELTE_GRAB_ALLOWED_ORIGINS env var.
	 */
	allowedOrigins?: string[];
	/**
	 * Bearer token control:
	 *  - undefined/false (default): token auth DISABLED (origin check still on).
	 *  - true: enable with an auto-generated token (printed on startup).
	 *  - string: enable with this exact token.
	 * The SVELTE_GRAB_TOKEN env var, if set, enables token auth and takes
	 * precedence (its value is used as the token, unless it is "1"/"true").
	 */
	token?: boolean | string;
}

export interface SecurityConfig {
	/** Resolved extra allowlist (lowercased origins). */
	allowedOrigins: string[];
	/** Resolved token, or null if token auth is disabled. */
	token: string | null;
}

/**
 * Resolve the effective security configuration from options + environment.
 * Generates a token if token auth is enabled but no explicit value is given.
 */
export function resolveSecurityConfig(options: SecurityOptions = {}): SecurityConfig {
	// Merge explicit allowlist with the env var (comma-separated).
	const envOrigins = (process.env[ALLOWED_ORIGINS_ENV] || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const allowedOrigins = [...(options.allowedOrigins || []), ...envOrigins].map((o) =>
		o.toLowerCase().replace(/\/$/, '')
	);

	// Resolve token. Env var wins; "1"/"true" means "enabled, auto-generate".
	let token: string | null = null;
	const envToken = process.env[TOKEN_ENV];
	if (envToken !== undefined && envToken !== '' && envToken !== '0' && envToken !== 'false') {
		token = envToken === '1' || envToken === 'true' ? randomUUID() : envToken;
	} else if (options.token === true) {
		token = randomUUID();
	} else if (typeof options.token === 'string' && options.token) {
		token = options.token;
	}

	return { allowedOrigins, token };
}

/**
 * Returns true if the given Origin header value is allowed.
 *
 * Default allowlist = any localhost / 127.0.0.1 / [::1] / *.localhost origin on
 * any port (this is the local dev app). Extra origins may be configured.
 *
 * A missing/empty Origin (non-browser local tools like curl, MCP stdio clients)
 * is treated as allowed: browsers always send Origin, so absence implies a
 * non-browser caller, which the token (if enabled) is the real defense against.
 */
export function isOriginAllowed(
	origin: string | undefined | null,
	config: SecurityConfig
): boolean {
	if (!origin) return true; // no Origin -> non-browser local caller

	const normalized = origin.toLowerCase().replace(/\/$/, '');

	if (config.allowedOrigins.includes(normalized)) return true;

	try {
		const { hostname } = new URL(origin);
		const host = hostname.toLowerCase();
		// Strip IPv6 brackets if URL didn't (it usually does, but be safe).
		const bare = host.replace(/^\[|\]$/g, '');
		if (
			bare === 'localhost' ||
			bare.endsWith('.localhost') ||
			bare === '127.0.0.1' ||
			bare === '::1' ||
			bare === '0:0:0:0:0:0:0:1'
		) {
			return true;
		}
	} catch {
		// Unparseable Origin -> reject.
		return false;
	}

	return false;
}

/**
 * Validate a presented token against the configured one.
 * If token auth is disabled (config.token === null) this always passes.
 */
export function isTokenValid(
	presented: string | undefined | null,
	config: SecurityConfig
): boolean {
	if (config.token === null) return true; // token auth disabled
	return typeof presented === 'string' && presented === config.token;
}

/**
 * Print a concise startup banner describing the active security posture.
 * `label` is the server name, e.g. "relay" or "mcp".
 */
export function logSecurityBanner(label: string, config: SecurityConfig): void {
	console.log(
		`[svelte-grab ${label}] Bound to loopback (${LOOPBACK_HOST}) — do NOT expose this port to a network.`
	);
	console.log(
		`[svelte-grab ${label}] Origin check: ON (localhost origins allowed${config.allowedOrigins.length ? ` + ${config.allowedOrigins.length} configured` : ''}).`
	);
	if (config.token) {
		console.log(
			`[svelte-grab ${label}] Token auth: ON. Present it via ?token=<TOKEN> or ${TOKEN_HEADER} header.`
		);
		console.log(`[svelte-grab ${label}] TOKEN: ${config.token}`);
	} else {
		console.log(
			`[svelte-grab ${label}] Token auth: OFF (set ${TOKEN_ENV} to enable). Local non-browser processes are NOT blocked.`
		);
	}
}

/**
 * Extract a presented token from an HTTP/WS request URL (?token=) or headers.
 */
export function extractToken(
	url: string | undefined,
	headers: Record<string, string | string[] | undefined>
): string | undefined {
	// Query param ?token=
	if (url) {
		try {
			const u = new URL(url, 'http://localhost');
			const q = u.searchParams.get('token');
			if (q) return q;
		} catch {
			// ignore
		}
	}
	// Header x-svelte-grab-token
	const h = headers[TOKEN_HEADER];
	if (typeof h === 'string') return h;
	if (Array.isArray(h)) return h[0];
	return undefined;
}
