import type { AgentProvider, AgentProviderCallbacks } from './base.js';
import { setBoundedSession } from './base.js';

/**
 * Claude Code agent provider using @anthropic-ai/claude-agent-sdk.
 * `query()` returns an async generator of SDK messages; this provider streams
 * assistant text as status updates and finishes on the `result` message.
 */
interface SessionHistory {
	prompts: string[];
	results: string[];
	/** Claude Code session id, so follow-up prompts resume the same conversation. */
	claudeSessionId?: string;
}

/** The subset of SDK messages this provider reads. */
export interface ClaudeSdkMessage {
	type: string;
	subtype?: string;
	session_id?: string;
	result?: string;
	errors?: string[];
	message?: { content?: Array<{ type: string; text?: string }> };
}

/** The part of @anthropic-ai/claude-agent-sdk this provider calls. */
export interface ClaudeAgentSDK {
	query(params: {
		prompt: string;
		options?: {
			abortController?: AbortController;
			cwd?: string;
			resume?: string;
			permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
		};
	}): AsyncIterable<ClaudeSdkMessage>;
}

export class ClaudeCodeProvider implements AgentProvider {
	readonly name = 'claude-code';
	private activeSessions = new Map<string, AbortController>();
	private sessionHistory = new Map<string, SessionHistory>();
	private sdk: ClaudeAgentSDK | null;

	/** @param sdk - Injected SDK (tests); loaded lazily from the optional peer otherwise. */
	constructor(sdk?: ClaudeAgentSDK) {
		this.sdk = sdk ?? null;
	}

	/**
	 * Lazy-load the Claude Agent SDK.
	 */
	private async loadSDK(): Promise<ClaudeAgentSDK> {
		if (this.sdk) return this.sdk;

		try {
			const sdk: ClaudeAgentSDK = await import('@anthropic-ai/claude-agent-sdk');
			this.sdk = sdk;
			return sdk;
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
			const contextBlock =
				context.content.length > 0
					? `\n\nHere is the Svelte component context from the browser:\n\n${context.content.join('\n\n')}\n\n`
					: '';

			const fullPrompt = `${contextBlock}${context.prompt}`;

			// Save prompt to session history (bounded — evicts oldest session)
			if (!this.sessionHistory.has(sessionId)) {
				setBoundedSession(this.sessionHistory, sessionId, { prompts: [], results: [] });
			}
			this.sessionHistory.get(sessionId)!.prompts.push(fullPrompt);

			callbacks.onStatus('Processing...');

			const history = this.sessionHistory.get(sessionId)!;
			// acceptEdits: the relay exists so the agent can change files; shell
			// commands still need approval (and are denied without a prompt handler).
			const stream = sdk.query({
				prompt: fullPrompt,
				options: {
					abortController: controller,
					cwd: process.cwd(),
					permissionMode: 'acceptEdits',
					...(history.claudeSessionId ? { resume: history.claudeSessionId } : {})
				}
			});

			let resultStr = '';
			let failure: string | null = null;
			for await (const msg of stream) {
				if (controller.signal.aborted) return;
				if (msg.session_id) history.claudeSessionId = msg.session_id;
				if (msg.type === 'assistant') {
					const text = (msg.message?.content ?? [])
						.filter((block) => block.type === 'text' && block.text)
						.map((block) => block.text)
						.join('\n')
						.trim();
					if (text) callbacks.onStatus(text.slice(0, 500));
				} else if (msg.type === 'result') {
					if (msg.subtype === 'success') {
						resultStr = msg.result ?? '';
					} else {
						failure = msg.errors?.join('; ') || `Claude Code stopped: ${msg.subtype ?? 'error'}`;
					}
				}
			}

			if (controller.signal.aborted) return;
			if (failure) {
				this.activeSessions.delete(sessionId);
				callbacks.onError(failure);
				return;
			}
			resultStr = resultStr || 'Claude Code completed';

			// Save result to session history
			history.results.push(resultStr);

			this.activeSessions.delete(sessionId);
			callbacks.onDone(resultStr);
		} catch (caught: unknown) {
			const err = caught as { name?: string; message?: string } | null | undefined;
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

	async undo(sessionId: string, callbacks: AgentProviderCallbacks): Promise<void> {
		const history = this.sessionHistory.get(sessionId);
		const contextHint =
			history && history.prompts.length > 0
				? `\n\nPrevious prompt was: ${history.prompts[history.prompts.length - 1]}`
				: '';

		await this.handleRequest(
			sessionId,
			{
				content: [],
				prompt: `Undo the last change you made.${contextHint}`,
				selectedCount: 0
			},
			callbacks
		);
	}

	async redo(sessionId: string, callbacks: AgentProviderCallbacks): Promise<void> {
		await this.handleRequest(
			sessionId,
			{
				content: [],
				prompt: 'Redo the change you just undid.',
				selectedCount: 0
			},
			callbacks
		);
	}

	async resume(
		sessionId: string,
		prompt: string,
		callbacks: AgentProviderCallbacks
	): Promise<void> {
		const history = this.sessionHistory.get(sessionId);
		const contextBlock =
			history && history.results.length > 0
				? `\n\nPrevious interaction result: ${history.results[history.results.length - 1]}`
				: '';

		await this.handleRequest(
			sessionId,
			{
				content: [],
				prompt: `${prompt}${contextBlock}`,
				selectedCount: 0
			},
			callbacks
		);
	}
}
