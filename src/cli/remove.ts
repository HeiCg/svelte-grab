/**
 * CLI command: svelte-grab remove <provider>
 *
 * Removes an agent provider from the project configuration.
 */

import { loadConfig, saveConfig, showDiff } from './config.js';

export interface RemoveOptions {
	dryRun?: boolean;
}

export function remove(providerName?: string, options: RemoveOptions = {}): void {
	if (!providerName) {
		console.log('Usage: svelte-grab remove <provider>');
		console.log('  e.g. svelte-grab remove cursor\n');
		return;
	}

	const config = loadConfig();
	if (!config || !config.providers?.length) {
		console.log('No providers configured.');
		return;
	}

	const existing = config.providers.find(p => p.name === providerName);
	if (!existing) {
		console.log(`Provider "${providerName}" is not configured.`);
		console.log('Current providers: ' + config.providers.map(p => p.name).join(', '));
		return;
	}

	const beforeJson = JSON.stringify(config, null, 2);

	config.providers = config.providers.filter(p => p.name !== providerName);

	const afterJson = JSON.stringify(config, null, 2);

	console.log('\nChanges to svelte-grab.config.json:');
	showDiff(beforeJson, afterJson);

	if (options.dryRun) {
		console.log('\n(dry run — no files written)\n');
		return;
	}

	saveConfig(config);
	console.log(`\n\x1b[32mRemoved provider "${providerName}".\x1b[0m\n`);
}
