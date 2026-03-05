/**
 * Shared CLI configuration utilities.
 *
 * Handles reading/writing svelte-grab.config.json for
 * persistent project-level settings.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

// ============================================================
// Types
// ============================================================

export interface SvelteGrabConfig {
	activationKey?: string;
	editor?: string;
	relayPort?: number;
	mcpPort?: number;
	theme?: 'dark' | 'light';
	providers?: Array<{ name: string; port?: number }>;
}

// ============================================================
// Constants
// ============================================================

const CONFIG_FILENAMES = ['svelte-grab.config.json', '.svelte-grab.json'];

// ============================================================
// Config Operations
// ============================================================

/**
 * Find and load the config file from the given directory.
 */
export function loadConfig(cwd: string = process.cwd()): SvelteGrabConfig | null {
	for (const filename of CONFIG_FILENAMES) {
		const filepath = join(cwd, filename);
		if (existsSync(filepath)) {
			try {
				return JSON.parse(readFileSync(filepath, 'utf-8'));
			} catch {
				return null;
			}
		}
	}
	return null;
}

/**
 * Save config to svelte-grab.config.json.
 */
export function saveConfig(config: SvelteGrabConfig, cwd: string = process.cwd()): void {
	const filepath = join(cwd, CONFIG_FILENAMES[0]);
	writeFileSync(filepath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Display a simple diff between two JSON strings.
 */
export function showDiff(before: string, after: string): void {
	const beforeLines = before.split('\n');
	const afterLines = after.split('\n');

	const maxLen = Math.max(beforeLines.length, afterLines.length);
	let hasDiff = false;

	for (let i = 0; i < maxLen; i++) {
		const bLine = beforeLines[i] ?? '';
		const aLine = afterLines[i] ?? '';
		if (bLine !== aLine) {
			hasDiff = true;
			if (bLine) console.log(`  \x1b[31m- ${bLine}\x1b[0m`);
			if (aLine) console.log(`  \x1b[32m+ ${aLine}\x1b[0m`);
		}
	}

	if (!hasDiff) {
		console.log('  (no changes)');
	}
}
