/**
 * Browser-side WebSocket client for agent relay communication.
 */

import type { AgentHistoryEntry } from '../types.js';

interface AgentRequest {
	type: 'agent-request';
	agentId: string;
	sessionId: string;
	context: {
		content: string[];
		prompt: string;
		selectedCount: number;
	};
}

interface AgentAbort {
	type: 'agent-abort';
	sessionId: string;
}

interface AgentUndo {
	type: 'agent-undo';
	sessionId: string;
}

interface AgentRedo {
	type: 'agent-redo';
	sessionId: string;
}

interface AgentResume {
	type: 'agent-resume';
	sessionId: string;
	prompt: string;
}

interface AgentRetry {
	type: 'agent-retry';
	sessionId: string;
}

interface AgentStatus {
	type: 'agent-status';
	sessionId: string;
	message: string;
}

interface AgentDone {
	type: 'agent-done';
	sessionId: string;
	result: string;
}

interface AgentError {
	type: 'agent-error';
	sessionId: string;
	error: string;
}

interface AgentHandlers {
	type: 'handlers';
	agents: string[];
}

type ServerMessage = AgentStatus | AgentDone | AgentError | AgentHandlers;

export class AgentClient {
	private ws: WebSocket | null = null;
	private url: string = '';
	private sessionId: string = '';
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private shouldReconnect = false;
	private _requestHistory: AgentHistoryEntry[] = [];
	private _pendingEntry: AgentHistoryEntry | null = null;

	/** Called when agent sends a status update */
	onStatus: ((message: string) => void) | null = null;
	/** Called when agent completes */
	onDone: ((result: string) => void) | null = null;
	/** Called on agent error */
	onError: ((error: string) => void) | null = null;
	/** Called when server reports available handlers */
	onHandlers: ((agents: string[]) => void) | null = null;
	/** Called when connection state changes */
	onConnectionChange: ((connected: boolean) => void) | null = null;

	/**
	 * Connect to the relay server.
	 */
	connect(url: string): void {
		this.url = url;
		this.shouldReconnect = true;
		this.sessionId = crypto.randomUUID();
		this.doConnect();
	}

	private doConnect(): void {
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}

		try {
			this.ws = new WebSocket(this.url);

			this.ws.onopen = () => {
				this.onConnectionChange?.(true);
				// Send health check
				this.ws?.send(JSON.stringify({ type: 'health' }));
			};

			this.ws.onmessage = (event) => {
				try {
					const msg: ServerMessage = JSON.parse(event.data);
					switch (msg.type) {
						case 'agent-status':
							this.onStatus?.(msg.message);
							break;
						case 'agent-done':
							if (this._pendingEntry) {
								this._pendingEntry.result = msg.result;
								this._requestHistory.push(this._pendingEntry);
								this._pendingEntry = null;
							}
							this.onDone?.(msg.result);
							break;
						case 'agent-error':
							if (this._pendingEntry) {
								this._pendingEntry.error = msg.error;
								this._requestHistory.push(this._pendingEntry);
								this._pendingEntry = null;
							}
							this.onError?.(msg.error);
							break;
						case 'handlers':
							this.onHandlers?.(msg.agents);
							break;
					}
				} catch {
					console.error('[SvelteGrab] Failed to parse relay message');
				}
			};

			this.ws.onclose = () => {
				this.onConnectionChange?.(false);
				this.scheduleReconnect();
			};

			this.ws.onerror = () => {
				// onclose will fire after this
			};
		} catch {
			this.scheduleReconnect();
		}
	}

	private scheduleReconnect(): void {
		if (!this.shouldReconnect) return;
		if (this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (this.shouldReconnect) {
				this.doConnect();
			}
		}, 3000);
	}

	/**
	 * Send a request to an agent via the relay.
	 */
	sendRequest(agentId: string, context: { content: string[]; prompt: string; selectedCount: number }): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			this.onError?.('Not connected to relay server');
			return;
		}

		this._pendingEntry = {
			prompt: context.prompt,
			content: context.content,
			timestamp: Date.now()
		};

		const msg: AgentRequest = {
			type: 'agent-request',
			agentId,
			sessionId: this.sessionId,
			context
		};

		this.ws.send(JSON.stringify(msg));
	}

	/**
	 * Abort the current agent request.
	 */
	abort(): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

		const msg: AgentAbort = {
			type: 'agent-abort',
			sessionId: this.sessionId
		};

		this.ws.send(JSON.stringify(msg));
	}

	/**
	 * Request the agent to undo its last change.
	 */
	undo(): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			this.onError?.('Not connected to relay server');
			return;
		}

		this._pendingEntry = {
			prompt: 'Undo the last change',
			content: [],
			timestamp: Date.now()
		};

		const msg: AgentUndo = {
			type: 'agent-undo',
			sessionId: this.sessionId
		};

		this.ws.send(JSON.stringify(msg));
	}

	/**
	 * Request the agent to redo the last undone change.
	 */
	redo(): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			this.onError?.('Not connected to relay server');
			return;
		}

		this._pendingEntry = {
			prompt: 'Redo the last change',
			content: [],
			timestamp: Date.now()
		};

		const msg: AgentRedo = {
			type: 'agent-redo',
			sessionId: this.sessionId
		};

		this.ws.send(JSON.stringify(msg));
	}

	/**
	 * Resume the session with a follow-up prompt.
	 */
	resume(prompt: string): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			this.onError?.('Not connected to relay server');
			return;
		}

		this._pendingEntry = {
			prompt,
			content: [],
			timestamp: Date.now()
		};

		const msg: AgentResume = {
			type: 'agent-resume',
			sessionId: this.sessionId,
			prompt
		};

		this.ws.send(JSON.stringify(msg));
	}

	/**
	 * Retry the last failed request.
	 */
	retry(): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			this.onError?.('Not connected to relay server');
			return;
		}

		// Re-use the last history entry info for the pending entry
		const lastEntry = this._requestHistory[this._requestHistory.length - 1];
		this._pendingEntry = {
			prompt: lastEntry?.prompt || 'Retry',
			content: lastEntry?.content || [],
			timestamp: Date.now()
		};

		const msg: AgentRetry = {
			type: 'agent-retry',
			sessionId: this.sessionId
		};

		this.ws.send(JSON.stringify(msg));
	}

	/**
	 * Get the request history for this session.
	 */
	getHistory(): AgentHistoryEntry[] {
		return [...this._requestHistory];
	}

	/**
	 * Check if currently connected.
	 */
	get connected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	/**
	 * Disconnect from the relay server.
	 */
	disconnect(): void {
		this.shouldReconnect = false;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}
}
