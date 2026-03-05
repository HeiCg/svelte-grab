/**
 * CLI command: svelte-grab configure
 *
 * Interactive configuration for svelte-grab project settings.
 */

import { createInterface } from 'readline';
import { loadConfig, saveConfig, showDiff, type SvelteGrabConfig } from './config.js';

export interface ConfigureOptions {
	dryRun?: boolean;
}

const EDITORS = ['vscode', 'cursor', 'webstorm', 'zed', 'sublime', 'idea', 'phpstorm', 'pycharm', 'none'];

async function prompt(question: string, defaultValue?: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const suffix = defaultValue ? ` (${defaultValue})` : '';
	return new Promise<string>((resolve) => {
		rl.question(`  ${question}${suffix}: `, (answer) => {
			rl.close();
			resolve(answer.trim() || defaultValue || '');
		});
	});
}

export async function configure(options: ConfigureOptions = {}): Promise<void> {
	const config: SvelteGrabConfig = loadConfig() || {};
	const beforeJson = JSON.stringify(config, null, 2);

	console.log('\nSvelteGrab Configuration\n');

	// Activation key
	const key = await prompt('Activation key', config.activationKey || 'alt');
	if (key) config.activationKey = key;

	// Editor
	const editorChoice = await prompt(`Editor [${EDITORS.join('/')}]`, config.editor || 'vscode');
	if (editorChoice && EDITORS.includes(editorChoice)) {
		config.editor = editorChoice;
	}

	// Relay port
	const relayPort = await prompt('Relay port', String(config.relayPort || 4722));
	if (relayPort) config.relayPort = parseInt(relayPort, 10);

	// MCP port
	const mcpPort = await prompt('MCP port', String(config.mcpPort || 4723));
	if (mcpPort) config.mcpPort = parseInt(mcpPort, 10);

	// Theme
	const themeChoice = await prompt('Theme [dark/light]', config.theme || 'dark');
	if (themeChoice === 'dark' || themeChoice === 'light') {
		config.theme = themeChoice;
	}

	const afterJson = JSON.stringify(config, null, 2);

	console.log('\nChanges to svelte-grab.config.json:');
	showDiff(beforeJson, afterJson);

	if (options.dryRun) {
		console.log('\n(dry run — no files written)\n');
		return;
	}

	saveConfig(config);
	console.log('\n\x1b[32mConfiguration saved.\x1b[0m\n');
}
