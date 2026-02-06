declare module 'ws' {
	export class WebSocketServer {
		constructor(options: { port: number });
		on(event: string, listener: (...args: any[]) => void): void;
		close(): void;
	}
	export default { WebSocketServer: typeof WebSocketServer };
}

declare module '@anthropic-ai/claude-agent-sdk' {
	export function query(options: { prompt: string; signal?: AbortSignal }): Promise<string>;
}
