import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { DEFAULT_MCP_PORT, MCP_PORT_RANGE_SIZE, MCP_SERVICE_ID } from './constants.js';
import { findAvailablePort } from '../utils/port.js';
import {
	LOOPBACK_HOST,
	resolveSecurityConfig,
	isOriginAllowed,
	isTokenValid,
	extractToken,
	logSecurityBanner,
	type SecurityConfig,
	type SecurityOptions
} from '../utils/security.js';
import { TabRegistry } from './runtime/tab-registry.js';
import { CommandChannel, type RuntimeCommandMessage, type SendOptions } from './runtime/command-channel.js';
import { parseHelloPayload, parseResultPayload, isPlainObject, type RuntimeResultData } from './runtime/validate.js';
import { registerRuntimeTools, type McpToolServer, type ZodNamespace } from './runtime/tools.js';
import { resolveCdpConfig, type CdpConfig } from './cdp/client.js';
import { registerSkillPrompts, type McpPromptServer } from './prompts.js';

/** Max request body size (2 MB) for POST endpoints. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** How long / how much of an oversized body is discarded before the 413 is forced out. */
const OVERSIZED_DRAIN_MS = 5_000;
const OVERSIZED_DRAIN_BYTES = 64 * 1024 * 1024;
/** Cap on retained SSE clients and pending watchers (bounds memory). */
const MAX_SSE_CLIENTS = 100;
const MAX_WATCHERS = 100;

export interface McpServerOptions extends SecurityOptions {
	port?: number;
	stdio?: boolean;
	/**
	 * Opt-in CDP mode (`ui_perf_metrics`, `ui_leak_check`): the Chrome DevTools
	 * HTTP endpoint, e.g. `http://127.0.0.1:9222`. Loopback hosts only. Falls
	 * back to the SVELTE_GRAB_CDP env var; off when neither is set.
	 */
	cdp?: string;
}

/** Port actually bound vs. the one asked for (differs after a fallback). */
interface ListenInfo {
	port: number;
	preferredPort: number;
}

/**
 * svelte-grab version for `GET /health`. package.json sits two levels up from
 * both src/mcp/ (tests) and dist/mcp/ (published build).
 */
function readPackageVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
			name?: unknown;
			version?: unknown;
		};
		if (pkg.name === 'svelte-grab' && typeof pkg.version === 'string') return pkg.version;
	} catch {
		// fall through
	}
	return 'unknown';
}

const PACKAGE_VERSION = readPackageVersion();

// Module-level security config — resolved when the server starts.
// Defaults to "origin check on, token off" until startMcpServer overrides it.
let security: SecurityConfig = resolveSecurityConfig();

// CDP mode (Phase 8b) — null (off) unless --cdp / SVELTE_GRAB_CDP is set.
let cdpConfig: CdpConfig | null = null;

interface ContextPayload {
	content: string[];
	prompt?: string;
	toolName?: string;
}

// Stored context — last context sent by the browser
let storedContext: ContextPayload | null = null;

// Per-tool context storage
const toolContexts = new Map<string, { content: string; timestamp: number }>();

// Session history — list of contexts received
interface SessionHistoryEntry {
	id: string;
	content: string[];
	prompt?: string;
	result?: string;
	timestamp: number;
}

let sessionHistory: SessionHistoryEntry[] = [];
let sessionCounter = 0;

// ============================================================
// Watch queue — resolves pending watch_for_grab tool calls
// ============================================================
type WatchResolver = (ctx: ContextPayload) => void;
const watchQueue: WatchResolver[] = [];

// SSE clients — for browser real-time status
const sseClients = new Set<ServerResponse>();

// Track whether an agent is currently watching
let agentWatching = false;

/**
 * Notify all pending watchers that new context arrived.
 */
function notifyWatchers(ctx: ContextPayload): void {
	const waiters = watchQueue.splice(0);
	for (const resolve of waiters) {
		resolve(ctx);
	}
}

/**
 * Send an SSE event to all connected browsers.
 * Returns how many clients the event was written to.
 */
function broadcastSSE(event: string, data: unknown): number {
	const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	let delivered = 0;
	for (const client of sseClients) {
		if (client.destroyed || client.writableEnded) {
			sseClients.delete(client);
			continue;
		}
		try {
			client.write(payload);
			delivered++;
		} catch {
			sseClients.delete(client);
		}
	}
	return delivered;
}

// ============================================================
// Agent runtime channel (docs/agent-runtime-spec.md, wire contract v1)
// ============================================================
const tabRegistry = new TabRegistry();
const commandChannel = new CommandChannel({
	registry: tabRegistry,
	broadcast: (message: RuntimeCommandMessage) => broadcastSSE('runtime-command', message)
});

/**
 * Send a runtime command to a connected browser tab (explicit `tabId` or the
 * active tab) and wait for its `POST /runtime/result`. Rejects when no tab is
 * connected, on page error, or on timeout (default 10s, max 60s).
 */
export function sendRuntimeCommand(
	tool: string,
	args: Record<string, unknown>,
	options: SendOptions = {}
): Promise<RuntimeResultData> {
	return commandChannel.send(tool, args, options);
}

/**
 * Validate that the payload has the expected shape.
 */
function isValidContextPayload(data: unknown): data is ContextPayload {
	if (typeof data !== 'object' || data === null) return false;
	const obj = data as Record<string, unknown>;
	if (!Array.isArray(obj.content)) return false;
	for (const item of obj.content) {
		if (typeof item !== 'string') return false;
	}
	if (obj.prompt !== undefined && typeof obj.prompt !== 'string') return false;
	if (obj.toolName !== undefined && typeof obj.toolName !== 'string') return false;
	return true;
}

/**
 * Set CORS headers for browser requests.
 *
 * SECURITY: never use a wildcard ACAO. Reflect the request Origin ONLY when it
 * passes the allowlist; otherwise omit ACAO entirely so disallowed pages cannot
 * read responses. `Vary: Origin` keeps caches correct.
 */
function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
	const origin = req.headers.origin;
	res.setHeader('Vary', 'Origin');
	if (origin && isOriginAllowed(origin, security)) {
		res.setHeader('Access-Control-Allow-Origin', origin);
	}
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-svelte-grab-token');
}

/**
 * Enforce Origin allowlist + optional token on a request.
 * Returns true if the request is allowed; otherwise writes a 403/401 and
 * returns false (the caller should stop processing).
 */
function checkAccess(req: IncomingMessage, res: ServerResponse): boolean {
	if (!isOriginAllowed(req.headers.origin, security)) {
		sendJson(res, 403, { error: 'Origin not allowed' });
		return false;
	}
	const token = extractToken(req.url, req.headers as Record<string, string | string[] | undefined>);
	if (!isTokenValid(token, security)) {
		sendJson(res, 401, { error: 'Invalid or missing token' });
		return false;
	}
	return true;
}

class BodyTooLargeError extends Error {
	constructor() {
		super('Request body too large');
	}
}

/**
 * Read request body as string, rejecting with BodyTooLargeError when it
 * exceeds MAX_BODY_BYTES (declared Content-Length or bytes received). On
 * rejection nothing more is buffered and the request is left unread: the
 * caller answers with respondTooLarge().
 */
function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const declared = Number(req.headers['content-length']);
		if (declared > MAX_BODY_BYTES) {
			reject(new BodyTooLargeError());
			return;
		}
		let chunks: Buffer[] = [];
		let size = 0;
		const onData = (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				req.off('data', onData);
				req.off('end', onEnd);
				chunks = [];
				reject(new BodyTooLargeError());
				return;
			}
			chunks.push(chunk);
		};
		const onEnd = () => resolve(Buffer.concat(chunks).toString());
		req.on('data', onData);
		req.on('end', onEnd);
		// Stays attached after an overflow so a late socket error is never unhandled.
		req.on('error', reject);
	});
}

/**
 * Answer an oversized request with a 413 the client can actually read.
 *
 * Closing a socket that still has unread request bytes makes the kernel send
 * a RST, and the client gets a connection reset instead of the response. So
 * the rest of the body is read and discarded (never buffered) until the client
 * is done, then the 413 goes out with `Connection: close`. A client still
 * sending after OVERSIZED_DRAIN_MS or OVERSIZED_DRAIN_BYTES gets the 413
 * right away and the socket is closed behind it.
 */
function respondTooLarge(req: IncomingMessage, res: ServerResponse): void {
	let drained = 0;
	let done = false;
	const finish = (respond: boolean) => {
		if (done) return;
		done = true;
		clearTimeout(timer);
		req.off('data', onData);
		req.off('end', onEnd);
		req.off('close', onClose);
		// Keep discarding whatever still arrives until the socket closes.
		req.resume();
		if (!respond || res.headersSent) return;
		res.setHeader('Connection', 'close');
		sendJson(res, 413, { error: 'Request body too large' });
	};
	const onData = (chunk: Buffer) => {
		drained += chunk.length;
		if (drained > OVERSIZED_DRAIN_BYTES) finish(true);
	};
	const onEnd = () => finish(true);
	const onClose = () => finish(false);
	const timer = setTimeout(() => finish(true), OVERSIZED_DRAIN_MS);
	timer.unref();
	req.on('data', onData);
	req.on('end', onEnd);
	req.on('close', onClose);
	if (req.readableEnded) finish(true);
}

/**
 * Read and JSON-parse a POST body with the shared cap and error mapping
 * (413 too large, 400 invalid JSON). Returns `undefined` after writing the
 * error response.
 */
async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<{ data: unknown } | undefined> {
	let body: string;
	try {
		body = await readBody(req);
	} catch (err) {
		if (err instanceof BodyTooLargeError) respondTooLarge(req, res);
		else sendJson(res, 400, { error: 'Invalid JSON' });
		return undefined;
	}
	try {
		return { data: JSON.parse(body) };
	} catch {
		sendJson(res, 400, { error: 'Invalid JSON' });
		return undefined;
	}
}

/**
 * Send JSON response.
 */
function sendJson(res: ServerResponse, status: number, data: unknown): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(data));
}

/**
 * Process incoming context from the browser.
 * Stores it, saves to history, and notifies any waiting agents.
 */
function processIncomingContext(data: ContextPayload): void {
	storedContext = data;

	// Store per-tool context if toolName provided
	if (data.toolName) {
		toolContexts.set(data.toolName, {
			content: data.content.join('\n'),
			timestamp: Date.now()
		});
	}

	// Save to session history
	sessionCounter++;
	sessionHistory.push({
		id: `session-${sessionCounter}`,
		content: data.content,
		prompt: data.prompt,
		timestamp: Date.now()
	});

	// Keep last 50 entries
	if (sessionHistory.length > 50) {
		sessionHistory = sessionHistory.slice(-50);
	}

	// Notify waiting agents (watch_for_grab)
	notifyWatchers(data);

	// Notify browsers that context was received
	broadcastSSE('context-received', {
		id: `session-${sessionCounter}`,
		hasPrompt: !!data.prompt,
		agentWatching
	});
}

/**
 * Handle MCP protocol requests via StreamableHTTP transport.
 * Uses @modelcontextprotocol/sdk if available, otherwise returns 501.
 */
async function handleMcpProtocol(req: IncomingMessage, res: ServerResponse): Promise<void> {
	// Read the body here (same 2 MB cap as the other POST endpoints) and hand it
	// to the transport as `parsedBody`, so the SDK never buffers it unbounded.
	let parsedBody: unknown;
	try {
		parsedBody = JSON.parse(await readBody(req));
	} catch (err) {
		if (err instanceof BodyTooLargeError) {
			respondTooLarge(req, res);
		} else {
			// Same JSON-RPC parse error the SDK returns for a malformed body.
			sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: Invalid JSON' }, id: null });
		}
		return;
	}

	try {
		const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
		const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
		const { z } = await import('zod');

		const server = new McpServer({
			name: 'svelte-grab',
			version: '1.0.0'
		});

		registerMcpTools(server, z);

		// Stateless: a fresh server + transport per request, no session ids.
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		await server.connect(transport);
		await transport.handleRequest(req, res, parsedBody);
	} catch {
		if (!res.headersSent) sendJson(res, 501, { error: '@modelcontextprotocol/sdk not installed' });
	}
}

/**
 * Extract a tool-specific section from stored context.
 * Checks per-tool storage first, then falls back to parsing the unified export.
 */
function extractToolSection(toolName: string): string | null {
	const toolCtx = toolContexts.get(toolName);
	if (toolCtx) return toolCtx.content;

	if (!storedContext) return null;
	const fullText = storedContext.content.join('\n');
	const regex = new RegExp(`\\[${toolName}\\][\\s\\S]*?(?=\\n={30,}\\n\\[|$)`);
	const match = fullText.match(regex);
	return match ? match[0] : null;
}

/**
 * Register MCP tools (and the skill prompts) on a server instance.
 */
function registerMcpTools(server: McpToolServer & McpPromptServer, z: ZodNamespace): void {
	// ============================================================
	// watch_for_grab — blocks until the browser sends new context
	// ============================================================
	server.registerTool(
		'watch_for_grab',
		{
			title: 'Watch for browser grab',
			description:
				'Waits for the user to select a component in the browser and send context via svelte-grab. ' +
				'This tool BLOCKS until the user Alt+Clicks an element and submits their prompt. ' +
				'Returns the component context (file paths, component stack, HTML) plus the user\'s instruction. ' +
				'Call this in a loop to continuously receive instructions from the browser. ' +
				'The user selects a component, types what they want changed, and hits Enter — you receive everything here.'
		},
		async () => {
			agentWatching = true;
			broadcastSSE('agent-status', { status: 'watching', message: 'Claude Code is listening...' });

			// If there's already unread context, return it immediately
			if (storedContext) {
				const ctx = storedContext;
				storedContext = null;

				const parts: string[] = [...ctx.content];
				if (ctx.prompt) {
					parts.push(`\nUser instruction: ${ctx.prompt}`);
				}

				agentWatching = false;
				broadcastSSE('agent-status', { status: 'processing', message: 'Processing...' });

				return {
					content: [{ type: 'text', text: parts.join('\n') }]
				};
			}

			// Wait for the next context from the browser (cap pending watchers)
			const ctx = await new Promise<ContextPayload>((resolve) => {
				if (watchQueue.length >= MAX_WATCHERS) watchQueue.shift();
				watchQueue.push(resolve);
			});

			// Clear stored context since we're consuming it
			storedContext = null;

			const parts: string[] = [...ctx.content];
			if (ctx.prompt) {
				parts.push(`\nUser instruction: ${ctx.prompt}`);
			}

			agentWatching = false;
			broadcastSSE('agent-status', { status: 'processing', message: 'Processing...' });

			return {
				content: [{ type: 'text', text: parts.join('\n') }]
			};
		}
	);

	server.registerTool(
		'get_element_context',
		{
			title: 'Get last element context',
			description:
				'Returns the last element context captured by svelte-grab in the browser. Returns the grabbed component stack, HTML preview, and optional prompt. Context is cleared after reading.'
		},
		async () => {
			if (!storedContext) {
				return {
					content: [{ type: 'text', text: 'No context available. Alt+Click an element in the browser with svelte-grab active.' }]
				};
			}

			const ctx = storedContext;
			storedContext = null;

			const parts: string[] = [...ctx.content];
			if (ctx.prompt) {
				parts.push(`\nUser instruction: ${ctx.prompt}`);
			}

			return {
				content: [{ type: 'text', text: parts.join('\n') }]
			};
		}
	);

	server.registerTool(
		'undo_last_action',
		{
			title: 'Undo last action',
			description:
				'Returns an undo instruction with the original context from the last interaction. Use this to instruct the agent to undo its last change.'
		},
		async () => {
			if (sessionHistory.length === 0) {
				return {
					content: [{ type: 'text', text: 'No previous actions to undo. No session history available.' }]
				};
			}

			const lastEntry = sessionHistory[sessionHistory.length - 1];
			const contextInfo = lastEntry.content.length > 0
				? `\n\nOriginal context was:\n${lastEntry.content.join('\n')}`
				: '';
			const promptInfo = lastEntry.prompt
				? `\nOriginal instruction was: ${lastEntry.prompt}`
				: '';

			return {
				content: [{ type: 'text', text: `Undo the last change.${promptInfo}${contextInfo}` }]
			};
		}
	);

	server.registerTool(
		'get_session_history',
		{
			title: 'Get session history',
			description:
				'Returns the list of recent interactions (contexts sent by the browser). Each entry includes the content, prompt, and timestamp.'
		},
		async () => {
			if (sessionHistory.length === 0) {
				return {
					content: [{ type: 'text', text: 'No session history. No contexts have been sent yet.' }]
				};
			}

			const entries = sessionHistory.slice(-20).map((entry) => {
				const time = new Date(entry.timestamp).toLocaleTimeString();
				const prompt = entry.prompt ? `Prompt: ${entry.prompt}` : 'No prompt';
				const contentPreview = entry.content.length > 0
					? `Content: ${entry.content[0].slice(0, 100)}${entry.content[0].length > 100 ? '...' : ''}`
					: 'No content';
				return `[${time}] ${entry.id}\n  ${prompt}\n  ${contentPreview}`;
			});

			return {
				content: [{ type: 'text', text: `Session history (${sessionHistory.length} entries):\n\n${entries.join('\n\n')}` }]
			};
		}
	);

	server.registerTool(
		'get_a11y_report',
		{
			title: 'Get accessibility report',
			description:
				'Returns the last accessibility audit report captured by SvelteA11yReporter. Includes WCAG violations, scores, and fix suggestions.'
		},
		async () => {
			const section = extractToolSection('A11yReporter');
			if (!section) {
				return {
					content: [{ type: 'text', text: 'No a11y report available. Use Alt+RightClick or Alt+A in the browser to run an accessibility audit.' }]
				};
			}
			return { content: [{ type: 'text', text: section }] };
		}
	);

	server.registerTool(
		'get_style_context',
		{
			title: 'Get style context',
			description:
				'Returns the last CSS style analysis captured by SvelteStyleGrab. Includes computed styles, conflicts, and source attribution.'
		},
		async () => {
			const section = extractToolSection('StyleGrab');
			if (!section) {
				return {
					content: [{ type: 'text', text: 'No style context available. Use Alt+Ctrl+Click on an element in the browser to capture styles.' }]
				};
			}
			return { content: [{ type: 'text', text: section }] };
		}
	);

	server.registerTool(
		'get_error_context',
		{
			title: 'Get error context',
			description:
				'Returns captured console errors and warnings from SvelteErrorContext. Includes stack traces, component attribution, and error patterns.'
		},
		async () => {
			const section = extractToolSection('ErrorContext');
			if (!section) {
				return {
					content: [{ type: 'text', text: 'No error context available. Errors are captured automatically when SvelteErrorContext is active.' }]
				};
			}
			return { content: [{ type: 'text', text: section }] };
		}
	);

	server.registerTool(
		'get_profiler_report',
		{
			title: 'Get render profiler report',
			description:
				'Returns the last render profiler report from SvelteRenderProfiler. Includes hot components, render counts, and burst detection.'
		},
		async () => {
			const section = extractToolSection('RenderProfiler');
			if (!section) {
				return {
					content: [{ type: 'text', text: 'No profiler data available. Use Alt+P in the browser to start profiling.' }]
				};
			}
			return { content: [{ type: 'text', text: section }] };
		}
	);

	server.registerTool(
		'list_available_tools',
		{
			title: 'List available tool data',
			description: 'Lists which svelte-grab tools have data available and when it was last captured.'
		},
		async () => {
			const tools: string[] = [];

			if (storedContext) {
				tools.push('element_context: available (last grab)');
			}

			if (agentWatching) {
				tools.push('watch_for_grab: active (waiting for browser input)');
			}

			for (const [name, ctx] of toolContexts) {
				const age = Math.floor((Date.now() - ctx.timestamp) / 1000);
				const ageStr = age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`;
				tools.push(`${name}: available (captured ${ageStr})`);
			}

			if (tools.length === 0) {
				return {
					content: [{ type: 'text', text: 'No tool data available. Use svelte-grab tools in the browser to capture context.' }]
				};
			}

			return {
				content: [{ type: 'text', text: `Available tool data:\n\n${tools.join('\n')}` }]
			};
		}
	);

	// Agent runtime: ui_tabs (server-only), ui_snapshot / ui_find / ui_inspect (page round trip).
	registerRuntimeTools(server, z, { registry: tabRegistry, channel: commandChannel, cdp: () => cdpConfig });

	// Prompts: the packaged skills (svelte-grab-loop, security-audit, performance-audit).
	registerSkillPrompts(server, z);
}

/**
 * Create the HTTP request handler for the context bridge.
 * Used by both standalone HTTP mode and as a sidecar in stdio mode.
 */
function createHttpHandler(listen: ListenInfo) {
	return async (req: IncomingMessage, res: ServerResponse) => {
		setCorsHeaders(req, res);

		// Handle preflight. CORS headers (incl. allowlisted ACAO) already set.
		if (req.method === 'OPTIONS') {
			res.writeHead(204);
			res.end();
			return;
		}

		// Reject browser requests from disallowed Origins (and bad tokens).
		// /health is intentionally open (no sensitive data, used for probing).
		const rawUrl = req.url || '/';
		const path = rawUrl.split('?')[0];
		if (path !== '/health' && !checkAccess(req, res)) {
			return;
		}

		// Route on the path (query string may carry ?token=).
		// GET /health
		if (req.method === 'GET' && path === '/health') {
			sendJson(res, 200, {
				status: 'ok',
				// Identity: lets the page confirm it reached this server and not
				// something else on the port (the port may have fallen back).
				service: MCP_SERVICE_ID,
				version: PACKAGE_VERSION,
				port: listen.port,
				preferredPort: listen.preferredPort,
				portFallback: listen.port !== listen.preferredPort,
				hasContext: storedContext !== null,
				agentWatching,
				watcherCount: watchQueue.length,
				sseClients: sseClients.size
			});
			return;
		}

		// GET /events — SSE endpoint for browser real-time updates
		if (req.method === 'GET' && path === '/events') {
			// ACAO already set by setCorsHeaders (allowlisted reflection, not *).
			res.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive'
			});

			// Send current status immediately
			const statusPayload = JSON.stringify({
				status: agentWatching ? 'watching' : 'idle',
				message: agentWatching ? 'Claude Code is listening...' : 'No agent connected'
			});
			res.write(`event: agent-status\ndata: ${statusPayload}\n\n`);

			// Cap retained SSE clients to bound memory.
			if (sseClients.size >= MAX_SSE_CLIENTS) {
				const oldest = sseClients.values().next().value;
				if (oldest) {
					sseClients.delete(oldest);
					try { oldest.end(); } catch { /* ignore */ }
				}
			}
			sseClients.add(res);

			req.on('close', () => {
				sseClients.delete(res);
			});
			return;
		}

		// POST /context — browser sends grabbed context here
		if (req.method === 'POST' && path === '/context') {
			const body = await readJsonBody(req, res);
			if (!body) return;
			if (!isValidContextPayload(body.data)) {
				sendJson(res, 400, { error: 'Invalid payload. Expected { content: string[], prompt?: string }' });
				return;
			}
			processIncomingContext(body.data);
			sendJson(res, 200, { ok: true, agentWatching });
			return;
		}

		// POST /runtime/hello — page registers/heartbeats its tab (wire contract v1)
		if (req.method === 'POST' && path === '/runtime/hello') {
			const body = await readJsonBody(req, res);
			if (!body) return;
			const parsed = parseHelloPayload(body.data);
			if (!parsed.ok) {
				sendJson(res, 400, { error: `Invalid payload: ${parsed.error}` });
				return;
			}
			tabRegistry.hello(parsed.value);
			sendJson(res, 200, { ok: true });
			return;
		}

		// POST /runtime/result — page answers a runtime-command (wire contract v1)
		if (req.method === 'POST' && path === '/runtime/result') {
			const body = await readJsonBody(req, res);
			if (!body) return;
			const parsed = parseResultPayload(body.data);
			if (!parsed.ok) {
				// Fail the matching command now instead of letting the agent wait for the timeout.
				const id = isPlainObject(body.data) ? body.data.id : undefined;
				if (typeof id === 'string') {
					commandChannel.fail(id, new Error(`Browser tab sent an invalid result: ${parsed.error}`));
				}
				sendJson(res, 400, { error: `Invalid payload: ${parsed.error}` });
				return;
			}
			const outcome = commandChannel.settle(parsed.value);
			if (outcome === 'unknown-id') {
				sendJson(res, 404, { error: 'Unknown or expired command id' });
				return;
			}
			if (outcome === 'tab-mismatch') {
				sendJson(res, 404, { error: 'Command id was not sent to this tab' });
				return;
			}
			sendJson(res, 200, { ok: true });
			return;
		}

		// POST /mcp — MCP protocol endpoint (HTTP mode and the stdio sidecar)
		if (req.method === 'POST' && path === '/mcp') {
			await handleMcpProtocol(req, res);
			return;
		}

		// 404 for everything else
		sendJson(res, 404, { error: 'Not found' });
	};
}

/**
 * Start the HTTP server on the given port.
 */
async function startHttpListener(preferredPort: number): Promise<{ close: () => void; port: number }> {
	const lastPort = preferredPort + MCP_PORT_RANGE_SIZE - 1;
	let port: number;
	try {
		port = await findAvailablePort(preferredPort, MCP_PORT_RANGE_SIZE - 1);
	} catch {
		throw new Error(`Could not find an available port in ${preferredPort}-${lastPort}`);
	}

	if (port !== preferredPort) {
		// stderr: stdout belongs to the stdio transport in sidecar mode.
		console.error(
			`[svelte-grab mcp] Port ${preferredPort} was in use, using ${port} instead. ` +
				`The page finds it by probing GET /health on ${preferredPort}-${lastPort}; ` +
				`pass mcpPort=${port} (e.g. <SvelteGrab mcpPort={${port}} />) to skip the probe.`
		);
	}

	return new Promise((resolve, reject) => {
		const server = createServer(createHttpHandler({ port, preferredPort }));

		server.on('error', (err: NodeJS.ErrnoException) => {
			reject(err);
		});

		// Bind to loopback only — never expose this port to a network.
		server.listen(port, LOOPBACK_HOST, () => {
			resolve({ close: () => server.close(), port });
		});
	});
}

/**
 * Start the MCP server in HTTP mode.
 */
async function startHttpServer(preferredPort: number): Promise<{ close: () => void; port: number }> {
	const { close, port } = await startHttpListener(preferredPort);

	console.log(`[svelte-grab mcp] HTTP server listening on http://localhost:${port}`);
	console.log(`[svelte-grab mcp] Health check: http://localhost:${port}/health`);
	console.log(`[svelte-grab mcp] Context endpoint: POST http://localhost:${port}/context`);
	console.log(`[svelte-grab mcp] SSE events: http://localhost:${port}/events`);
	console.log(`[svelte-grab mcp] Runtime channel: POST http://localhost:${port}/runtime/hello, /runtime/result`);
	logSecurityBanner('mcp', security);

	return { close, port };
}

/**
 * Start the MCP server in stdio mode for direct Claude Code integration.
 * Also starts a sidecar HTTP server so the browser can POST context.
 */
async function startStdioServer(httpPort: number): Promise<void> {
	const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
	const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
	const { z } = await import('zod');

	const server = new McpServer({
		name: 'svelte-grab',
		version: '1.0.0'
	});

	// ui_* tools reach the page through the sidecar HTTP listener below (same
	// process, shared tab registry). If the sidecar cannot start, no tab can
	// connect and ui_* tools return the "No browser tab connected" error.
	registerMcpTools(server, z);

	// Start sidecar HTTP server for browser context bridge
	try {
		const { port } = await startHttpListener(httpPort);
		// Log to stderr since stdout is used by stdio transport.
		console.error(`[svelte-grab mcp] Sidecar HTTP on http://localhost:${port} (loopback only, Origin-checked).`);
		if (security.token) {
			console.error(`[svelte-grab mcp] Sidecar token: ${security.token} (present via ?token= or x-svelte-grab-token).`);
		}
	} catch {
		console.error(`[svelte-grab mcp] Warning: Could not start sidecar HTTP server on port ${httpPort}`);
	}

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

/**
 * Start the MCP server.
 * In stdio mode, connects via stdin/stdout for direct Claude Code integration
 * and starts a sidecar HTTP server for browser context.
 * In HTTP mode, starts an HTTP server with /health, /context, /events, and /mcp endpoints.
 */
export async function startMcpServer(options: McpServerOptions = {}): Promise<{ close: () => void; port: number } | void> {
	const { port = DEFAULT_MCP_PORT, stdio = false } = options;

	// Resolve security config (Origin allowlist + optional token) from
	// options/env before any request can be served.
	security = resolveSecurityConfig(options);
	// Throws on a non-loopback / invalid CDP URL: refuse to start rather than
	// silently ignore it.
	cdpConfig = resolveCdpConfig(options.cdp);
	if (cdpConfig) {
		console.error(
			`[svelte-grab mcp] CDP mode on: ${cdpConfig.httpUrl} (ui_perf_metrics, ui_leak_check). ` +
				'A CDP port gives full control of that browser: keep it on loopback, never expose it.'
		);
	}

	if (stdio) {
		await startStdioServer(port);
		return;
	}

	return startHttpServer(port);
}
