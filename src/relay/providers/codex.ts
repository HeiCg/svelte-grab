import type { AgentProvider, AgentProviderCallbacks } from './base.js';
import { setBoundedSession } from './base.js';

/**
 * OpenAI Codex agent provider using @openai/codex-sdk.
 * Lazy-loads the SDK and uses thread-based streaming for responses.
 */
interface SessionHistory {
	prompts: string[];
	results: string[];
	threadId?: string;
}

/** The parts of @openai/codex-sdk this provider calls (SDK >= 0.1: `new Codex()`). */
export interface CodexStreamEvent {
	type: string;
	thread_id?: string;
	item?: { type?: string; text?: string };
	error?: { message?: string };
	message?: string;
}

export interface CodexThread {
	/** Null until the thread has started (see the `thread.started` event). */
	readonly id: string | null;
	runStreamed(
		input: string,
		options?: { signal?: AbortSignal }
	): Promise<{ events: AsyncIterable<CodexStreamEvent> }>;
}

interface CodexThreadOptions {
	workingDirectory?: string;
	sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
	skipGitRepoCheck?: boolean;
}

export interface CodexClient {
	startThread(options?: CodexThreadOptions): CodexThread;
	resumeThread(id: string, options?: CodexThreadOptions): CodexThread;
}

export interface CodexSDK {
	Codex: new () => CodexClient;
}

export class CodexProvider implements AgentProvider {
	readonly name = 'codex';
	private activeSessions = new Map<string, AbortController>();
	private sessionHistory = new Map<string, SessionHistory>();
	private client: CodexClient | null;

	/** @param client - Injected client (tests); created lazily from the optional peer otherwise. */
	constructor(client?: CodexClient) {
		this.client = client ?? null;
	}

	/**
	 * Lazy-load the Codex SDK.
	 */
	private async loadSDK(): Promise<CodexClient> {
		if (this.client) return this.client;

		let sdk: CodexSDK;
		try {
			// Use variable to prevent TypeScript from resolving the optional peer dependency at compile time
			const moduleName = '@openai/codex-sdk';
			sdk = await import(/* @vite-ignore */ moduleName);
		} catch {
			throw new Error('@openai/codex-sdk not installed. Run: npm install @openai/codex-sdk');
		}
		try {
			// The constructor locates the Codex CLI binary and throws if it is missing.
			this.client = new sdk.Codex();
			return this.client;
		} catch (caught: unknown) {
			const reason = caught instanceof Error ? caught.message : String(caught);
			throw new Error(`Could not start the Codex SDK: ${reason}`);
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
			const contextBlock =
				context.content.length > 0
					? `\n\nHere is the Svelte component context from the browser:\n\n${context.content.join('\n\n')}\n\n`
					: '';

			const fullPrompt = `${contextBlock}${context.prompt}`;

			// Save prompt to session history (bounded — evicts oldest session)
			if (!this.sessionHistory.has(sessionId)) {
				setBoundedSession(this.sessionHistory, sessionId, { prompts: [], results: [] });
			}
			const history = this.sessionHistory.get(sessionId)!;
			history.prompts.push(fullPrompt);

			callbacks.onStatus('Processing...');

			// Start or resume a thread. workspace-write: the relay exists so the
			// agent can edit the project; nothing outside the workspace.
			const threadOptions: CodexThreadOptions = {
				workingDirectory: process.cwd(),
				sandboxMode: 'workspace-write'
			};
			const thread = history.threadId
				? sdk.resumeThread(history.threadId, threadOptions)
				: sdk.startThread(threadOptions);

			// Run the prompt with streaming
			const { events } = await thread.runStreamed(fullPrompt, { signal: controller.signal });

			let lastResult = '';

			for await (const event of events) {
				if (controller.signal.aborted) return;

				switch (event.type) {
					case 'thread.started':
						if (event.thread_id) history.threadId = event.thread_id;
						break;
					case 'item.started':
					case 'item.updated': {
						const text = event.item?.text;
						if (text) callbacks.onStatus(text.slice(0, 200));
						break;
					}
					case 'item.completed': {
						const text = event.item?.text;
						if (text) {
							callbacks.onStatus(text.slice(0, 500));
							if (event.item?.type === 'agent_message') lastResult = text;
						}
						break;
					}
					case 'turn.failed':
					case 'error': {
						const errMsg = event.error?.message || event.message || 'Codex stream error';
						this.activeSessions.delete(sessionId);
						callbacks.onError(errMsg);
						return;
					}
					default:
						// turn.started, turn.completed
						break;
				}
			}
			if (!history.threadId && thread.id) history.threadId = thread.id;

			if (controller.signal.aborted) return;

			const result = lastResult || 'Codex completed';
			history.results.push(result);

			this.activeSessions.delete(sessionId);
			callbacks.onDone(result);
		} catch (caught: unknown) {
			const err = caught as { name?: string; message?: string } | null | undefined;
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
