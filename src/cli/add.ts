/**
 * CLI command: svelte-grab add <provider>
 *
 * Adds an agent provider to the project configuration.
 */

import { loadConfig, saveConfig, showDiff, type SvelteGrabConfig } from './config.js';

const KNOWN_PROVIDERS: Record<string, { name: string; description: string; peerDep?: string }> = {
	'claude-code': {
		name: 'claude-code',
		description: 'Claude Code via @anthropic-ai/claude-agent-sdk',
		peerDep: '@anthropic-ai/claude-agent-sdk'
	},
	'cursor': {
		name: 'cursor',
		description: 'Cursor via cursor-agent CLI',
	},
	'copilot': {
		name: 'copilot',
		description: 'GitHub Copilot via copilot CLI',
	},
	'codex': {
		name: 'codex',
		description: 'OpenAI Codex via @openai/codex-sdk',
		peerDep: '@openai/codex-sdk'
	}
};

export interface AddOptions {
	dryRun?: boolean;
	port?: number;
}

export function add(providerName?: string, options: AddOptions = {}): void {
	if (!providerName) {
		console.log('\nAvailable providers:');
		for (const [id, info] of Object.entries(KNOWN_PROVIDERS)) {
			console.log(`  ${id.padEnd(15)} ${info.description}`);
		}
		console.log('\nUsage: svelte-grab add <provider>');
		console.log('  e.g. svelte-grab add cursor\n');
		return;
	}

	const provider = KNOWN_PROVIDERS[providerName];
	if (!provider) {
		console.error(`\x1b[31mUnknown provider: ${providerName}\x1b[0m`);
		console.log('Known providers: ' + Object.keys(KNOWN_PROVIDERS).join(', '));
		process.exit(1);
	}

	const config: SvelteGrabConfig = loadConfig() || {};
	const beforeJson = JSON.stringify(config, null, 2);

	// Check if already added
	const existing = config.providers?.find(p => p.name === providerName);
	if (existing) {
		console.log(`Provider "${providerName}" is already configured.`);
		return;
	}

	// Add provider
	if (!config.providers) {
		config.providers = [];
	}
	const entry: { name: string; port?: number } = { name: providerName };
	if (options.port) {
		entry.port = options.port;
	}
	config.providers.push(entry);

	const afterJson = JSON.stringify(config, null, 2);

	console.log('\nChanges to svelte-grab.config.json:');
	showDiff(beforeJson, afterJson);

	if (options.dryRun) {
		console.log('\n(dry run — no files written)\n');
		return;
	}

	saveConfig(config);
	console.log(`\n\x1b[32mAdded provider "${providerName}".\x1b[0m`);

	if (provider.peerDep) {
		console.log(`\nInstall the required dependency:`);
		console.log(`  npm install ${provider.peerDep}\n`);
	}

	console.log('Start the relay with:');
	console.log(`  npx svelte-grab relay --provider=${providerName}\n`);
}
