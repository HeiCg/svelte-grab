import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentProvider, AgentProviderCallbacks } from './base.js';

/**
 * GitHub Copilot agent provider using the copilot CLI.
 * Spawns the copilot CLI with --silent and --allow-all flags,
 * reading stdout chunks as status messages.
 */
interface SessionHistory {
	prompts: string[];
	results: string[];
	sessionId?: string;
}

export class CopilotProvider implements AgentProvider {
	readonly name = 'copilot';
	private activeSessions = new Map<string, { process: ChildProcess; controller: AbortController }>();
	private sessionHistory = new Map<string, SessionHistory>();

	async handleRequest(
		sessionId: string,
		context: { content: string[]; prompt: string; selectedCount: number },
		callbacks: AgentProviderCallbacks
	): Promise<void> {
		try {
			const controller = new AbortController();

			callbacks.onStatus('Starting Copilot agent...');

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
			const args = ['-p', fullPrompt, '--silent', '--allow-all', '--no-color'];

			// Support resume via sessionId
			const history = this.sessionHistory.get(sessionId)!;
			if (history.sessionId) {
				args.push('--resume', history.sessionId);
			}

			const child = spawn('copilot', args, {
				stdio: ['ignore', 'pipe', 'pipe'],
				signal: controller.signal
			});

			this.activeSessions.set(sessionId, { process: child, controller });

			callbacks.onStatus('Processing...');

			let outputBuffer = '';

			child.stdout!.on('data', (chunk: Buffer) => {
				const text = chunk.toString();
				outputBuffer += text;

				// Report each chunk as a status update
				const lines = text.split('\n').filter((l: string) => l.trim());
				for (const line of lines) {
					callbacks.onStatus(line.trim());
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
						const result = outputBuffer.trim() || 'Copilot agent completed';
						history.results.push(result);
						// Store sessionId for resume (use the svelte-grab sessionId)
						history.sessionId = sessionId;
						callbacks.onDone(result);
						resolve();
					} else {
						const errMsg = stderrOutput.trim() || `Copilot agent exited with code ${code}`;
						callbacks.onError(errMsg);
						reject(new Error(errMsg));
					}
				});

				child.on('error', (err: NodeJS.ErrnoException) => {
					this.activeSessions.delete(sessionId);

					if (err.code === 'ENOENT') {
						callbacks.onError(
							'copilot CLI not found. Install GitHub Copilot CLI: https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line'
						);
					} else if (err.name === 'AbortError') {
						resolve();
						return;
					} else {
						callbacks.onError(err.message || 'Unknown error from Copilot agent');
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
