import type { AgentProvider, AgentProviderCallbacks } from './base.js';

/**
 * Claude Code agent provider using @anthropic-ai/claude-agent-sdk.
 * This provider streams responses from Claude Code via the SDK's query() API.
 */
export class ClaudeCodeProvider implements AgentProvider {
	readonly name = 'claude-code';
	private activeSessions = new Map<string, AbortController>();
	private sdk: any = null;

	/**
	 * Lazy-load the Claude Agent SDK.
	 */
	private async loadSDK(): Promise<any> {
		if (this.sdk) return this.sdk;

		try {
			this.sdk = await import('@anthropic-ai/claude-agent-sdk');
			return this.sdk;
		} catch {
			throw new Error(
				'@anthropic-ai/claude-agent-sdk not installed. Run: npm install @anthropic-ai/claude-agent-sdk'
			);
		}
	}

	async handleRequest(
		sessionId: string,
		context: { content: string[]; prompt: string; selectedCount: number },
		callbacks: AgentProviderCallbacks
	): Promise<void> {
		try {
			const sdk = await this.loadSDK();
			const controller = new AbortController();
			this.activeSessions.set(sessionId, controller);

			callbacks.onStatus('Connecting to Claude Code...');

			// Build the prompt with context
			const contextBlock = context.content.length > 0
				? `\n\nHere is the Svelte component context from the browser:\n\n${context.content.join('\n\n')}\n\n`
				: '';

			const fullPrompt = `${contextBlock}${context.prompt}`;

			callbacks.onStatus('Processing...');

			// Use the SDK's query function
			const result = await sdk.query({
				prompt: fullPrompt,
				signal: controller.signal
			});

			if (controller.signal.aborted) return;

			this.activeSessions.delete(sessionId);
			callbacks.onDone(typeof result === 'string' ? result : JSON.stringify(result));
		} catch (err: any) {
			this.activeSessions.delete(sessionId);

			if (err?.name === 'AbortError') return;

			callbacks.onError(err?.message || 'Unknown error from Claude Code');
		}
	}

	abort(sessionId: string): void {
		const controller = this.activeSessions.get(sessionId);
		if (controller) {
			controller.abort();
			this.activeSessions.delete(sessionId);
		}
	}
}
