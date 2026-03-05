import type { AgentProvider, AgentProviderCallbacks } from './base.js';

/**
 * OpenAI Codex agent provider using @openai/codex-sdk.
 * Lazy-loads the SDK and uses thread-based streaming for responses.
 */
interface SessionHistory {
	prompts: string[];
	results: string[];
	threadId?: string;
}

export class CodexProvider implements AgentProvider {
	readonly name = 'codex';
	private activeSessions = new Map<string, AbortController>();
	private sessionHistory = new Map<string, SessionHistory>();
	private sdk: any = null;

	/**
	 * Lazy-load the Codex SDK.
	 */
	private async loadSDK(): Promise<any> {
		if (this.sdk) return this.sdk;

		try {
			// Use variable to prevent TypeScript from resolving the optional peer dependency at compile time
			const moduleName = '@openai/codex-sdk';
			this.sdk = await import(/* @vite-ignore */ moduleName);
			return this.sdk;
		} catch {
			throw new Error(
				'@openai/codex-sdk not installed. Run: npm install @openai/codex-sdk'
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

			callbacks.onStatus('Connecting to Codex...');

			// Build the prompt with context
			const contextBlock = context.content.length > 0
				? `\n\nHere is the Svelte component context from the browser:\n\n${context.content.join('\n\n')}\n\n`
				: '';

			const fullPrompt = `${contextBlock}${context.prompt}`;

			// Save prompt to session history
			if (!this.sessionHistory.has(sessionId)) {
				this.sessionHistory.set(sessionId, { prompts: [], results: [] });
			}
			const history = this.sessionHistory.get(sessionId)!;
			history.prompts.push(fullPrompt);

			callbacks.onStatus('Processing...');

			// Start or resume a thread
			let thread: any;
			if (history.threadId) {
				thread = await sdk.resumeThread(history.threadId);
			} else {
				thread = await sdk.startThread();
				history.threadId = thread.id;
			}

			// Run the prompt with streaming
			const stream = thread.runStreamed(fullPrompt, {
				signal: controller.signal
			});

			let lastResult = '';

			// Process streamed events
			for await (const event of stream.events) {
				if (controller.signal.aborted) return;

				switch (event.type) {
					case 'item.completed': {
						const content = event.item?.content || event.item?.text || '';
						const statusText = typeof content === 'string'
							? content.slice(0, 500)
							: JSON.stringify(content).slice(0, 500);
						if (statusText) {
							callbacks.onStatus(statusText);
							lastResult = statusText;
						}
						break;
					}
					case 'item.streaming':
					case 'item.started': {
						const text = event.item?.text || event.item?.content || '';
						if (text) {
							callbacks.onStatus(typeof text === 'string' ? text.slice(0, 200) : 'Working...');
						}
						break;
					}
					case 'error': {
						const errMsg = event.error?.message || event.message || 'Codex stream error';
						callbacks.onError(errMsg);
						this.activeSessions.delete(sessionId);
						return;
					}
					default:
						// Other event types (e.g., thread.started, thread.completed)
						break;
				}
			}

			if (controller.signal.aborted) return;

			const result = lastResult || 'Codex completed';
			history.results.push(result);

			this.activeSessions.delete(sessionId);
			callbacks.onDone(result);
		} catch (err: any) {
			this.activeSessions.delete(sessionId);

			if (err?.name === 'AbortError') return;

			callbacks.onError(err?.message || 'Unknown error from Codex');
		}
	}

	abort(sessionId: string): void {
		const controller = this.activeSessions.get(sessionId);
		if (controller) {
			controller.abort();
			this.activeSessions.delete(sessionId);
		}
	}

	async undo(sessionId: string, callbacks: AgentProviderCallbacks): Promise<void> {
		const history = this.sessionHistory.get(sessionId);
		const contextHint = history && history.prompts.length > 0
			? `\n\nPrevious prompt was: ${history.prompts[history.prompts.length - 1]}`
			: '';

		await this.handleRequest(sessionId, {
			content: [],
			prompt: `Undo the last change you made.${contextHint}`,
			selectedCount: 0
		}, callbacks);
	}

	async redo(sessionId: string, callbacks: AgentProviderCallbacks): Promise<void> {
		await this.handleRequest(sessionId, {
			content: [],
			prompt: 'Redo the change you just undid.',
			selectedCount: 0
		}, callbacks);
	}

	async resume(sessionId: string, prompt: string, callbacks: AgentProviderCallbacks): Promise<void> {
		const history = this.sessionHistory.get(sessionId);
		const contextBlock = history && history.results.length > 0
			? `\n\nPrevious interaction result: ${history.results[history.results.length - 1]}`
			: '';

		await this.handleRequest(sessionId, {
			content: [],
			prompt: `${prompt}${contextBlock}`,
			selectedCount: 0
		}, callbacks);
	}
}
