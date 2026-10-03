import type { AgentProvider } from './providers/base.js';
import type {
	ClientMessage,
	AgentStatusMessage,
	AgentDoneMessage,
	AgentErrorMessage,
	HandlersMessage,
	HealthResponseMessage
} from './protocol.js';
import { validateClientMessage } from './protocol.js';
import { findAvailablePort } from '../utils/port.js';
import {
	LOOPBACK_HOST,
	resolveSecurityConfig,
	isOriginAllowed,
	isTokenValid,
	extractToken,
	logSecurityBanner,
	type SecurityOptions
} from '../utils/security.js';

/** Max WebSocket message size (2 MB) — bounds untrusted browser input. */
const MAX_PAYLOAD = 2 * 1024 * 1024;
/** Max retained sessions in the retry store (oldest evicted past this). */
const MAX_SESSIONS = 200;

export interface RelayServerOptions extends SecurityOptions {
	port?: number;
	providers?: AgentProvider[];
}

/**
 * Create and start a WebSocket relay server.
 * Bridges browser clients to agent providers.
 */
interface SessionEntry {
	agentId: string;
	lastContext: { content: string[]; prompt: string; selectedCount: number };
}

export async function createRelayServer(options: RelayServerOptions = {}): Promise<{ close: () => void }> {
	const { port: preferredPort = 4722, providers = [] } = options;

	// Lazy-load ws
	let WebSocketServer: any;
	try {
		const ws = await import('ws');
		WebSocketServer = ws.WebSocketServer || ws.default?.WebSocketServer;
	} catch {
		throw new Error('ws package not installed. Run: npm install ws');
	}

	// Resolve security config (origin allowlist + optional token).
	const security = resolveSecurityConfig(options);

	const providerMap = new Map<string, AgentProvider>();
	for (const p of providers) {
		providerMap.set(p.name, p);
	}

	// Session store for retry support (bounded — see addSession below).
	const sessionStore = new Map<string, SessionEntry>();

	/** Insert/update a session, evicting the oldest entry if over the cap. */
	function addSession(sessionId: string, entry: SessionEntry): void {
		sessionStore.delete(sessionId); // re-insert to keep recency order
		sessionStore.set(sessionId, entry);
		if (sessionStore.size > MAX_SESSIONS) {
			const oldest = sessionStore.keys().next().value;
			if (oldest !== undefined) sessionStore.delete(oldest);
		}
	}

	// Find available port (auto-increment if preferred port is in use)
	let port: number;
	try {
		port = await findAvailablePort(preferredPort);
	} catch {
		throw new Error(`Could not find available port starting from ${preferredPort}`);
	}

	// Bind to loopback only, cap payload size, and reject browser connections
	// from disallowed Origins (and bad tokens, when token auth is enabled).
	const wss = new WebSocketServer({
		host: LOOPBACK_HOST,
		port,
		maxPayload: MAX_PAYLOAD,
		verifyClient: (info: { origin?: string; req: any }, cb: (ok: boolean, code?: number, msg?: string) => void) => {
			if (!isOriginAllowed(info.origin, security)) {
				cb(false, 403, 'Origin not allowed');
				return;
			}
			const token = extractToken(info.req?.url, info.req?.headers || {});
			if (!isTokenValid(token, security)) {
				cb(false, 401, 'Invalid or missing token');
				return;
			}
			cb(true);
		}
	});

	if (port !== preferredPort) {
		console.log(`[svelte-grab relay] Port ${preferredPort} was in use, using ${port} instead`);
	}
	console.log(`[svelte-grab relay] Listening on ws://localhost:${port}`);
	console.log(`[svelte-grab relay] Registered agents: ${providers.map(p => p.name).join(', ') || 'none'}`);
	logSecurityBanner('relay', security);

	wss.on('connection', (ws: any) => {
		console.log('[svelte-grab relay] Client connected');

		// Send available handlers
		const handlersMsg: HandlersMessage = {
			type: 'handlers',
			agents: [...providerMap.keys()]
		};
		ws.send(JSON.stringify(handlersMsg));

		ws.on('message', async (data: any) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(data.toString());
			} catch {
				return;
			}

			// Validate message shape before acting (drives a local agent).
			const validation = validateClientMessage(parsed, new Set(providerMap.keys()));
			if (!validation.ok) {
				if (validation.sessionId) {
					const errMsg: AgentErrorMessage = {
						type: 'agent-error',
						sessionId: validation.sessionId,
						error: `Rejected: ${validation.error}`
					};
					if (ws.readyState === 1) ws.send(JSON.stringify(errMsg));
				}
				return;
			}
			const msg: ClientMessage = validation.message;

			// Helper to create callbacks for a session
			function createCallbacks(sessionId: string) {
				return {
					onStatus: (message: string) => {
						const statusMsg: AgentStatusMessage = {
							type: 'agent-status',
							sessionId,
							message
						};
						if (ws.readyState === 1) ws.send(JSON.stringify(statusMsg));
					},
					onDone: (result: string) => {
						const doneMsg: AgentDoneMessage = {
							type: 'agent-done',
							sessionId,
							result
						};
						if (ws.readyState === 1) ws.send(JSON.stringify(doneMsg));
					},
					onError: (error: string) => {
						const errMsg: AgentErrorMessage = {
							type: 'agent-error',
							sessionId,
							error
						};
						if (ws.readyState === 1) ws.send(JSON.stringify(errMsg));
					}
				};
			}

			switch (msg.type) {
				case 'health': {
					const resp: HealthResponseMessage = {
						type: 'health',
						status: 'ok',
						agents: [...providerMap.keys()]
					};
					ws.send(JSON.stringify(resp));
					break;
				}

				case 'agent-request': {
					const provider = providerMap.get(msg.agentId);
					if (!provider) {
						const errMsg: AgentErrorMessage = {
							type: 'agent-error',
							sessionId: msg.sessionId,
							error: `Unknown agent: ${msg.agentId}. Available: ${[...providerMap.keys()].join(', ')}`
						};
						ws.send(JSON.stringify(errMsg));
						return;
					}

					// Save session for retry (bounded store)
					addSession(msg.sessionId, {
						agentId: msg.agentId,
						lastContext: msg.context
					});

					await provider.handleRequest(msg.sessionId, msg.context, createCallbacks(msg.sessionId));
					break;
				}

				case 'agent-abort': {
					for (const provider of providerMap.values()) {
						provider.abort(msg.sessionId);
					}
					break;
				}

				case 'agent-undo': {
					const session = sessionStore.get(msg.sessionId);
					const provider = session ? providerMap.get(session.agentId) : providerMap.values().next().value;
					if (provider) {
						await provider.undo(msg.sessionId, createCallbacks(msg.sessionId));
					}
					break;
				}

				case 'agent-redo': {
					const session = sessionStore.get(msg.sessionId);
					const provider = session ? providerMap.get(session.agentId) : providerMap.values().next().value;
					if (provider) {
						await provider.redo(msg.sessionId, createCallbacks(msg.sessionId));
					}
					break;
				}

				case 'agent-resume': {
					const session = sessionStore.get(msg.sessionId);
					const provider = session ? providerMap.get(session.agentId) : providerMap.values().next().value;
					if (provider) {
						await provider.resume(msg.sessionId, msg.prompt, createCallbacks(msg.sessionId));
					}
					break;
				}

				case 'agent-retry': {
					const session = sessionStore.get(msg.sessionId);
					if (!session) {
						const errMsg: AgentErrorMessage = {
							type: 'agent-error',
							sessionId: msg.sessionId,
							error: 'No previous request to retry for this session'
						};
						ws.send(JSON.stringify(errMsg));
						break;
					}

					const provider = providerMap.get(session.agentId);
					if (provider) {
						await provider.handleRequest(msg.sessionId, session.lastContext, createCallbacks(msg.sessionId));
					}
					break;
				}
			}
		});

		ws.on('close', () => {
			console.log('[svelte-grab relay] Client disconnected');
		});
	});

	return {
		close: () => {
			wss.close();
		}
	};
}
