/**
 * Browser-side WebSocket client for agent relay communication.
 */

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
							this.onDone?.(msg.result);
							break;
						case 'agent-error':
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
