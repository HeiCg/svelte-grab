/**
 * Start the agent relay server from CLI.
 */
export async function startRelay(options: { port?: number; provider?: string } = {}): Promise<void> {
	const port = options.port || 4722;
	const providerName = options.provider || 'claude-code';

	console.log(`[svelte-grab] Starting relay server on port ${port}...`);

	try {
		const { createRelayServer } = await import('../relay/index.js');
		const providers = [];

		if (providerName === 'claude-code') {
			try {
				const { ClaudeCodeProvider } = await import('../relay/providers/claude-code.js');
				providers.push(new ClaudeCodeProvider());
			} catch {
				console.warn('[svelte-grab] Claude Code SDK not available. Relay will run without agent providers.');
				console.warn('Install: npm install @anthropic-ai/claude-agent-sdk');
			}
		}

		const server = await createRelayServer({ port, providers });

		// Handle graceful shutdown
		process.on('SIGINT', () => {
			console.log('\n[svelte-grab] Shutting down relay server...');
			server.close();
			process.exit(0);
		});

		process.on('SIGTERM', () => {
			server.close();
			process.exit(0);
		});
	} catch (err: any) {
		console.error(`[svelte-grab] Failed to start relay: ${err.message}`);
		process.exit(1);
	}
}
