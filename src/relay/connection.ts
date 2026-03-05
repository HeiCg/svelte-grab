/**
 * Helper for external providers to connect to the relay as remote handlers.
 * Allows an AgentProvider running in a separate process to register itself
 * with the relay server over WebSocket.
 */

import type { AgentProvider, AgentProviderCallbacks } from './providers/base.js';
import type {
	AgentStatusMessage,
	AgentDoneMessage,
	AgentErrorMessage
} from './protocol.js';

export interface ConnectRelayOptions {
	/** Port of the relay server. Default: 4722 */
	port?: number;
	/** Full WebSocket URL (overrides port if provided) */
	url?: string;
	/** Agent provider to register as a remote handler */
	provider: AgentProvider;
}

export interface RelayConnection {
	/** Disconnect from the relay server */
	disconnect: () => Promise<void>;
}

/**
 * Message sent to register this provider as a handler on the relay.
 */
interface RegisterHandlerMessage {
	type: 'register-handler';
	agentId: string;
}

/**
 * Message sent to unregister this provider from the relay.
 */
interface UnregisterHandlerMessage {
	type: 'unregister-handler';
	agentId: string;
}

/**
 * Message received from the relay to invoke a handler method.
 */
interface InvokeHandlerMessage {
	type: 'invoke-handler';
	method: 'run' | 'abort' | 'undo' | 'redo';
	sessionId: string;
	payload?: {
		content?: string[];
		prompt?: string;
		selectedCount?: number;
	};
}

/**
 * Connect an AgentProvider to the relay server as a remote handler.
 * The provider will receive forwarded requests from browser clients.
 */
export async function connectToRelay(options: ConnectRelayOptions): Promise<RelayConnection> {
	const { port = 4722, url, provider } = options;
	const wsUrl = url ?? `ws://localhost:${port}?handler=true&agentId=${encodeURIComponent(provider.name)}`;

	// Lazy-load ws
	let WebSocket: any;
	try {
		const ws = await import('ws');
		WebSocket = ws.default || ws;
	} catch {
		throw new Error('ws package not installed. Run: npm install ws');
	}

	return new Promise<RelayConnection>((resolve, reject) => {
		let socket: any;

		try {
			socket = new WebSocket(wsUrl);
		} catch (err) {
			reject(new Error(`Failed to create WebSocket connection: ${err}`));
			return;
		}

		const sendJson = (data: unknown) => {
			try {
				if (socket.readyState === 1) {
					socket.send(JSON.stringify(data));
				}
			} catch {
				// Socket may have closed between check and send
			}
		};

		/**
		 * Create callbacks that relay status/done/error messages
		 * back through the WebSocket to the relay server.
		 */
		function createCallbacks(sessionId: string): AgentProviderCallbacks {
			return {
				onStatus: (message: string) => {
					const msg: AgentStatusMessage = {
						type: 'agent-status',
						sessionId,
						message
					};
					sendJson(msg);
				},
				onDone: (result: string) => {
					const msg: AgentDoneMessage = {
						type: 'agent-done',
						sessionId,
						result
					};
					sendJson(msg);
				},
				onError: (error: string) => {
					const msg: AgentErrorMessage = {
						type: 'agent-error',
						sessionId,
						error
					};
					sendJson(msg);
				}
			};
		}

		socket.on('open', () => {
			// Register this provider as a handler
			const registerMsg: RegisterHandlerMessage = {
				type: 'register-handler',
				agentId: provider.name
			};
			sendJson(registerMsg);

			console.log(`[svelte-grab connection] Connected to relay at ${wsUrl}`);
			console.log(`[svelte-grab connection] Registered handler: ${provider.name}`);

			resolve({
				disconnect: async () => {
					try {
						const unregisterMsg: UnregisterHandlerMessage = {
							type: 'unregister-handler',
							agentId: provider.name
						};
						sendJson(unregisterMsg);
					} catch {
						// Best effort
					}

					try {
						socket.close();
					} catch {
						// Already closed
					}
				}
			});
		});

		socket.on('message', async (data: any) => {
			let msg: InvokeHandlerMessage;
			try {
				msg = JSON.parse(data.toString());
			} catch {
				return;
			}

			if (msg.type !== 'invoke-handler') return;

			const callbacks = createCallbacks(msg.sessionId);

			try {
				switch (msg.method) {
					case 'run': {
						const context = {
							content: msg.payload?.content ?? [],
							prompt: msg.payload?.prompt ?? '',
							selectedCount: msg.payload?.selectedCount ?? 0
						};
						await provider.handleRequest(msg.sessionId, context, callbacks);
						break;
					}
					case 'abort': {
						provider.abort(msg.sessionId);
						break;
					}
					case 'undo': {
						await provider.undo(msg.sessionId, callbacks);
						break;
					}
					case 'redo': {
						await provider.redo(msg.sessionId, callbacks);
						break;
					}
				}
			} catch (err) {
				callbacks.onError(`Handler error: ${err instanceof Error ? err.message : String(err)}`);
			}
		});

		socket.on('error', (err: any) => {
			console.error(`[svelte-grab connection] WebSocket error:`, err.message ?? err);
			reject(new Error(`WebSocket connection error: ${err.message ?? err}`));
		});

		socket.on('close', () => {
			console.log('[svelte-grab connection] Disconnected from relay');
		});
	});
}
