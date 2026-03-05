import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentProvider, AgentProviderCallbacks } from './base.js';

/**
 * Cursor agent provider using the cursor-agent CLI.
 * Spawns cursor-agent with streaming JSON output and parses events from stdout.
 */
interface SessionHistory {
	prompts: string[];
	results: string[];
	chatId?: string;
}

interface CursorEvent {
	type: 'system' | 'user' | 'thinking' | 'assistant' | 'result';
	content?: string;
	success?: boolean;
	error?: string;
	chatId?: string;
}

export class CursorProvider implements AgentProvider {
	readonly name = 'cursor';
	private activeSessions = new Map<string, { process: ChildProcess; controller: AbortController }>();
	private sessionHistory = new Map<string, SessionHistory>();

	async handleRequest(
		sessionId: string,
		context: { content: string[]; prompt: string; selectedCount: number },
		callbacks: AgentProviderCallbacks
	): Promise<void> {
		try {
			const controller = new AbortController();

			callbacks.onStatus('Starting Cursor agent...');

			// Build the prompt with context
			const contextBlock = context.content.length > 0
				? `\n\nHere is the Svelte component context from the browser:\n\n${context.content.join('\n\n')}\n\n`
				: '';

			const fullPrompt = `${contextBlock}${context.prompt}`;

			// Save prompt to session history
			if (!this.sessionHistory.has(sessionId)) {
				this.sessionHistory.set(sessionId, { prompts: [], results: [] });
			}
			this.sessionHistory.get(sessionId)!.prompts.push(fullPrompt);

			// Build args
			const args = ['--print', '--output-format', 'stream-json', '--force'];

			// Support resume via chatId when session history exists
			const history = this.sessionHistory.get(sessionId)!;
			if (history.chatId) {
				args.push('--resume', history.chatId);
			}

			// Add prompt
			args.push(fullPrompt);

			const child = spawn('cursor-agent', args, {
				stdio: ['ignore', 'pipe', 'pipe'],
				signal: controller.signal
			});

			this.activeSessions.set(sessionId, { process: child, controller });

			callbacks.onStatus('Processing...');

			let resultBuffer = '';
			let lastResult = '';

			child.stdout!.on('data', (chunk: Buffer) => {
				resultBuffer += chunk.toString();

				// Parse line-delimited JSON events
				const lines = resultBuffer.split('\n');
				resultBuffer = lines.pop()!; // Keep incomplete line in buffer

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;

					try {
						const event: CursorEvent = JSON.parse(trimmed);

						// Track chatId for resume support
						if (event.chatId) {
							history.chatId = event.chatId;
						}

						switch (event.type) {
							case 'thinking':
								callbacks.onStatus(`Thinking: ${event.content?.slice(0, 200) || '...'}`);
								break;
							case 'assistant':
								callbacks.onStatus(event.content || 'Working...');
								if (event.content) lastResult = event.content;
								break;
							case 'result':
								if (event.success) {
									const result = event.content || lastResult || 'Done';
									history.results.push(result);
									// Don't call onDone here — wait for process exit
									lastResult = result;
								} else if (event.error) {
									callbacks.onError(event.error);
								}
								break;
							case 'system':
							case 'user':
								// Informational; no action needed
								break;
						}
					} catch {
						// Not valid JSON; treat as plain status text
						if (trimmed) {
							callbacks.onStatus(trimmed);
						}
					}
				}
			});

			let stderrOutput = '';
			child.stderr!.on('data', (chunk: Buffer) => {
				stderrOutput += chunk.toString();
			});

			await new Promise<void>((resolve, reject) => {
				child.on('close', (code) => {
					this.activeSessions.delete(sessionId);

					if (controller.signal.aborted) {
						resolve();
						return;
					}

					if (code === 0) {
						callbacks.onDone(lastResult || 'Cursor agent completed');
						resolve();
					} else {
						const errMsg = stderrOutput.trim() || `Cursor agent exited with code ${code}`;
						callbacks.onError(errMsg);
						reject(new Error(errMsg));
					}
				});

				child.on('error', (err: NodeJS.ErrnoException) => {
					this.activeSessions.delete(sessionId);

					if (err.code === 'ENOENT') {
						callbacks.onError(
							'cursor-agent CLI not found. Make sure Cursor is installed and cursor-agent is in your PATH.'
						);
					} else if (err.name === 'AbortError') {
						resolve();
						return;
					} else {
						callbacks.onError(err.message || 'Unknown error from Cursor agent');
					}
					reject(err);
				});
			});
		} catch (err: any) {
			this.activeSessions.delete(sessionId);

			if (err?.name === 'AbortError') return;

			// Error already reported via callbacks in most cases
		}
	}

	abort(sessionId: string): void {
		const session = this.activeSessions.get(sessionId);
		if (session) {
			session.controller.abort();
			session.process.kill('SIGTERM');
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
