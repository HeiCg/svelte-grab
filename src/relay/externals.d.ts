// Ambient types for the optional peers, loaded with dynamic import(). Only the
// members the relay actually uses are declared.

declare module 'ws' {
	/** Request info handed to `verifyClient`. */
	export interface VerifyClientInfo {
		origin?: string;
		req?: { url?: string; headers?: Record<string, string | string[] | undefined> };
	}

	export interface WebSocketServerOptions {
		host?: string;
		port: number;
		maxPayload?: number;
		verifyClient?: (
			info: VerifyClientInfo,
			cb: (ok: boolean, code?: number, msg?: string) => void
		) => void;
	}

	/** A socket: the relay's client connection, or one accepted by the server. */
	export class WebSocket {
		constructor(url: string);
		/** 1 = OPEN. */
		readonly readyState: number;
		send(data: string): void;
		close(): void;
		on(event: 'open' | 'close', listener: () => void): void;
		on(event: 'message', listener: (data: { toString(): string }) => void): void;
		on(event: 'error', listener: (err: { message?: string }) => void): void;
		static WebSocketServer: typeof WebSocketServer;
	}

	export class WebSocketServer {
		constructor(options: WebSocketServerOptions);
		on(event: 'connection', listener: (socket: WebSocket) => void): void;
		close(): void;
	}

	export default WebSocket;
}

declare module '@anthropic-ai/claude-agent-sdk' {
	// Minimal shape used by providers/claude-code.ts: query() returns an async
	// generator of SDK messages (system init, assistant, result, ...).
	export function query(params: {
		prompt: string;
		options?: {
			abortController?: AbortController;
			cwd?: string;
			resume?: string;
			permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
		};
	}): AsyncIterable<{
		type: string;
		subtype?: string;
		session_id?: string;
		result?: string;
		errors?: string[];
		message?: { content?: Array<{ type: string; text?: string }> };
	}>;
}
