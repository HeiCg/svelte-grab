import type { AgentProvider } from './providers/base.js';
import type {
	ClientMessage,
	AgentStatusMessage,
	AgentDoneMessage,
	AgentErrorMessage,
	HandlersMessage,
	HealthResponseMessage
} from './protocol.js';

export interface RelayServerOptions {
	port?: number;
	providers?: AgentProvider[];
}

/**
 * Create and start a WebSocket relay server.
 * Bridges browser clients to agent providers.
 */
export async function createRelayServer(options: RelayServerOptions = {}): Promise<{ close: () => void }> {
	const { port = 4722, providers = [] } = options;

	// Lazy-load ws
	let WebSocketServer: any;
	try {
		const ws = await import('ws');
		WebSocketServer = ws.WebSocketServer || ws.default?.WebSocketServer;
	} catch {
		throw new Error('ws package not installed. Run: npm install ws');
	}

	const providerMap = new Map<string, AgentProvider>();
	for (const p of providers) {
		providerMap.set(p.name, p);
	}

	const wss = new WebSocketServer({ port });

	console.log(`[svelte-grab relay] Listening on ws://localhost:${port}`);
	console.log(`[svelte-grab relay] Registered agents: ${providers.map(p => p.name).join(', ') || 'none'}`);

	wss.on('connection', (ws: any) => {
		console.log('[svelte-grab relay] Client connected');

		// Send available handlers
		const handlersMsg: HandlersMessage = {
			type: 'handlers',
			agents: [...providerMap.keys()]
		};
		ws.send(JSON.stringify(handlersMsg));

		ws.on('message', async (data: any) => {
			let msg: ClientMessage;
			try {
				msg = JSON.parse(data.toString());
			} catch {
				return;
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

					await provider.handleRequest(msg.sessionId, msg.context, {
						onStatus: (message) => {
							const statusMsg: AgentStatusMessage = {
								type: 'agent-status',
								sessionId: msg.sessionId,
								message
							};
							if (ws.readyState === 1) ws.send(JSON.stringify(statusMsg));
						},
						onDone: (result) => {
							const doneMsg: AgentDoneMessage = {
								type: 'agent-done',
								sessionId: msg.sessionId,
								result
							};
							if (ws.readyState === 1) ws.send(JSON.stringify(doneMsg));
						},
						onError: (error) => {
							const errMsg: AgentErrorMessage = {
								type: 'agent-error',
								sessionId: msg.sessionId,
								error
							};
							if (ws.readyState === 1) ws.send(JSON.stringify(errMsg));
						}
					});
					break;
				}

				case 'agent-abort': {
					for (const provider of providerMap.values()) {
						provider.abort(msg.sessionId);
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
