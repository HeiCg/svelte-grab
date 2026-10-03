import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import {
	injectAppSvelte,
	injectKitLayout,
	injectVitePlugin,
	lineDiff,
	mergeMcpJson,
	devKitMissingEnableMcp,
	VITE_PLUGIN_IMPORT,
	type McpServerName
} from './transforms.js';

/** Minimum Svelte version: `__svelte_meta.parent` (component stack) starts here. */
export const MIN_SVELTE_VERSION = '5.35.1';

/**
 * Parse the first `major[.minor[.patch]]` out of a version or range string
 * (`^5.35.1`, `~5.2`, `>=5.0.0`, `workspace:^5.40.0`). Returns null if none.
 */
export function parseSvelteVersion(range: string): [number, number, number] | null {
	const match = range.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
	if (!match) return null;
	return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/**
 * Classify a declared svelte version: `'error'` below 5, `'warn'` for
 * 5.x below {@link MIN_SVELTE_VERSION}, `'ok'` otherwise (including
 * unparseable specs like `latest` or `workspace:*`).
 */
export function checkSvelteVersion(range: string): 'ok' | 'warn' | 'error' {
	const version = parseSvelteVersion(range);
	if (!version) return 'ok';
	const [major, minor, patch] = version;
	if (major < 5) return 'error';
	const [minMajor, minMinor, minPatch] = parseSvelteVersion(MIN_SVELTE_VERSION)!;
	if (major > minMajor) return 'ok';
	if (minor !== minMinor) return minor > minMinor ? 'ok' : 'warn';
	return patch >= minPatch ? 'ok' : 'warn';
}

export interface InitOptions {
	/** Print what would change without writing. */
	dryRun?: boolean;
	/** Write/merge `.mcp.json` at the project root (default true). */
	mcpJson?: boolean;
	/** Add the official Svelte MCP (`@sveltejs/mcp`) to `.mcp.json` (default true). */
	svelteMcp?: boolean;
	/** Add Playwright MCP (`@playwright/mcp`) to `.mcp.json` (default false). */
	playwrightMcp?: boolean;
	/** Add `svelteGrab()` from `svelte-grab/vite` to the Vite config (default true). */
	vitePlugin?: boolean;
}

export interface InitResult {
	ok: boolean;
	/** Project-relative files written (empty in dry-run mode). */
	written: string[];
	/** `<SvelteDevKit enableMcp />` was (or would be) injected. */
	enableMcp: boolean;
	/** Servers added to `.mcp.json`. */
	mcpServersAdded: McpServerName[];
	vitePlugin: 'added' | 'already-present' | 'manual' | 'skipped' | 'missing';
	layout: 'created' | 'modified' | 'already-present' | 'manual';
}

/** Boolean flag: `--name` / `--name=true` -> true, `--name=false|no|0|off` -> false. */
function boolFlag(args: string[], name: string, fallback: boolean): boolean {
	for (const arg of args) {
		if (arg === `--${name}`) return true;
		if (arg.startsWith(`--${name}=`)) return !/^(false|no|0|off)$/i.test(arg.slice(name.length + 3));
	}
	return fallback;
}

/** Parse `svelte-grab init` flags. */
export function parseInitArgs(args: string[]): Required<InitOptions> {
	return {
		dryRun: args.includes('--dry-run'),
		mcpJson: !args.includes('--no-mcp-json'),
		svelteMcp: args.includes('--no-svelte-mcp') ? false : boolFlag(args, 'with-svelte-mcp', true),
		playwrightMcp: boolFlag(args, 'with-playwright-mcp', false),
		vitePlugin: !args.includes('--no-vite-plugin')
	};
}

const MCP_RUNTIME_DEPS = ['@modelcontextprotocol/sdk', 'zod'];

function installCommand(cwd: string, packages: string[]): string {
	const list = packages.join(' ');
	if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return `pnpm add -D ${list}`;
	if (existsSync(join(cwd, 'yarn.lock'))) return `yarn add -D ${list}`;
	if (existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) return `bun add -d ${list}`;
	return `npm install -D ${list}`;
}

function printDiff(before: string, after: string): void {
	for (const line of lineDiff(before, after)) {
		if (line.startsWith('+ ')) console.log(`  \x1b[32m${line}\x1b[0m`);
		else if (line.startsWith('- ')) console.log(`  \x1b[31m${line}\x1b[0m`);
		else console.log(`  ${line}`);
	}
}

/**
 * Detect the Svelte project and set it up for svelte-grab:
 *
 * 1. `.mcp.json`: merge the `svelte-grab` MCP server (plus `svelte` and,
 *    on request, `playwright`); existing entries are never replaced.
 * 2. `vite.config.(ts|js)`: add `svelteGrab()` from `svelte-grab/vite` when the
 *    config has a recognisable `plugins: [...]` array, else print how.
 * 3. Root layout (`src/routes/+layout.svelte`) or `src/App.svelte`: inject
 *    `<SvelteDevKit />`, with `enableMcp` only when `.mcp.json` declares the
 *    `svelte-grab` server after this run (added now or already there).
 *
 * Never exits the process: returns `ok: false` on fatal problems.
 */
export function init(cwd: string = process.cwd(), options: InitOptions = {}): InitResult {
	const { dryRun = false, mcpJson = true, svelteMcp = true, playwrightMcp = false, vitePlugin = true } = options;
	const result: InitResult = {
		ok: false,
		written: [],
		enableMcp: false,
		mcpServersAdded: [],
		vitePlugin: 'skipped',
		layout: 'manual'
	};

	if (dryRun) console.log('[svelte-grab] Dry run mode - no files will be written\n');
	console.log('[svelte-grab] Initializing...');

	const packageJsonPath = join(cwd, 'package.json');
	if (!existsSync(packageJsonPath)) {
		console.error('[svelte-grab] No package.json found. Run this from your project root.');
		return result;
	}

	let packageJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
	try {
		packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
	} catch {
		console.error('[svelte-grab] package.json is not valid JSON.');
		return result;
	}
	const deps: Record<string, string> = { ...packageJson.devDependencies, ...packageJson.dependencies };

	const isSvelteKit = !!deps['@sveltejs/kit'];
	const svelteVersion = deps['svelte'];
	if (!svelteVersion) {
		console.error('[svelte-grab] This does not appear to be a Svelte project (no svelte dependency found).');
		return result;
	}

	// Requires 5.35.1+ for the __svelte_meta.parent chain
	const status = checkSvelteVersion(svelteVersion);
	if (status === 'error') {
		console.error(`[svelte-grab] svelte-grab requires Svelte ${MIN_SVELTE_VERSION}+. Found: ${svelteVersion}`);
		return result;
	}
	if (status === 'warn') {
		console.warn(
			`[svelte-grab] Svelte ${MIN_SVELTE_VERSION}+ is required for component stacks. Found: ${svelteVersion}. ` +
				'Upgrade svelte or component names/parents will be missing.'
		);
	}

	const save = (rel: string, content: string) => {
		const path = join(cwd, rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, 'utf-8');
		result.written.push(rel);
	};

	// 1. .mcp.json
	if (mcpJson) {
		const mcpPath = join(cwd, '.mcp.json');
		const before = existsSync(mcpPath) ? readFileSync(mcpPath, 'utf-8') : null;
		const merged = mergeMcpJson(before, { svelteMcp, playwrightMcp });
		if (merged.error) {
			console.error(`[svelte-grab] ${merged.error}. Skipping .mcp.json.`);
		} else {
			result.mcpServersAdded = merged.added;
			result.enableMcp = merged.added.includes('svelte-grab') || merged.kept.includes('svelte-grab');
			if (merged.kept.length) {
				console.log(`[svelte-grab] .mcp.json already declares: ${merged.kept.join(', ')} (left unchanged)`);
			}
			if (merged.changed) {
				console.log(`[svelte-grab] ${dryRun ? 'Would write' : 'Writing'} .mcp.json (adds ${merged.added.join(', ')}):`);
				printDiff(before ?? '', merged.content);
				if (!dryRun) save('.mcp.json', merged.content);
			}
		}
	}

	// 2. Vite plugin
	if (vitePlugin) {
		const viteRel = ['vite.config.ts', 'vite.config.js'].find((f) => existsSync(join(cwd, f)));
		if (!viteRel) {
			result.vitePlugin = 'missing';
			console.log('[svelte-grab] No vite.config.ts/js found. To add the optional Vite plugin:');
			printVitePluginHowTo(isSvelteKit);
		} else {
			const before = readFileSync(join(cwd, viteRel), 'utf-8');
			const injected = injectVitePlugin(before);
			result.vitePlugin = injected.status;
			if (injected.status === 'added') {
				console.log(`[svelte-grab] ${dryRun ? 'Would add' : 'Adding'} svelteGrab() to ${viteRel}:`);
				printDiff(before, injected.content);
				if (!dryRun) save(viteRel, injected.content);
			} else if (injected.status === 'already-present') {
				console.log(`[svelte-grab] ${viteRel} already uses svelte-grab/vite.`);
			} else {
				console.log(`[svelte-grab] Could not edit ${viteRel} safely. Add the Vite plugin yourself:`);
				printVitePluginHowTo(isSvelteKit);
			}
		}
	}

	// 3. Layout / App.svelte
	const layoutOptions = { enableMcp: result.enableMcp };
	if (isSvelteKit) {
		const rel = 'src/routes/+layout.svelte';
		const path = join(cwd, rel);
		const before = existsSync(path) ? readFileSync(path, 'utf-8') : null;
		const injected = injectKitLayout(before, layoutOptions);
		applyLayout(rel, before, injected.content, injected.changed);
	} else {
		const hasViteConfig = existsSync(join(cwd, 'vite.config.ts')) || existsSync(join(cwd, 'vite.config.js'));
		const rel = 'src/App.svelte';
		const path = join(cwd, rel);
		if (hasViteConfig && existsSync(path)) {
			const before = readFileSync(path, 'utf-8');
			const injected = injectAppSvelte(before, layoutOptions);
			applyLayout(rel, before, injected.content, injected.changed);
		} else {
			result.layout = 'manual';
			console.log('[svelte-grab] Non-SvelteKit Svelte project detected.');
			console.log('Add <SvelteDevKit /> to your root component manually:');
			console.log('');
			console.log("  import { SvelteDevKit } from 'svelte-grab';");
			console.log('');
			console.log(`Then add ${result.enableMcp ? '<SvelteDevKit enableMcp />' : '<SvelteDevKit />'} at the end of your root component template.`);
		}
	}

	function applyLayout(rel: string, before: string | null, after: string, changed: boolean) {
		if (!changed) {
			result.layout = 'already-present';
			console.log(`[svelte-grab] svelte-grab is already in ${rel}. Nothing to do there.`);
			if (result.enableMcp && before && devKitMissingEnableMcp(before)) {
				console.log(`[svelte-grab] Tip: add enableMcp to <SvelteDevKit /> in ${rel} so the page connects to the MCP server.`);
			}
			return;
		}
		result.layout = before ? 'modified' : 'created';
		const verb = before ? 'modify' : 'create';
		if (dryRun) {
			console.log(`[svelte-grab] Would ${verb} ${rel}:`);
			printDiff(before ?? '', after);
		} else {
			save(rel, after);
			console.log(`[svelte-grab] ${before ? 'Added SvelteDevKit to' : 'Created'} ${rel}`);
		}
	}

	// Next steps
	const needed = ['svelte-grab', ...(result.enableMcp ? MCP_RUNTIME_DEPS : [])];
	const missing = needed.filter((pkg) => !deps[pkg]);
	console.log('');
	if (missing.length) {
		console.log('[svelte-grab] Install the missing dev dependencies:');
		console.log(`  ${installCommand(cwd, missing)}`);
	}
	if (result.enableMcp) {
		console.log('[svelte-grab] Next: start your dev server, open the app, and let your agent call ui_snapshot.');
		console.log('  Claude Code picks up .mcp.json on start (approve the project servers when asked).');
	}

	result.ok = true;
	return result;
}

function printVitePluginHowTo(isSvelteKit: boolean): void {
	console.log('');
	console.log(`  ${VITE_PLUGIN_IMPORT}`);
	console.log(`  // plugins: [${isSvelteKit ? 'sveltekit()' : 'svelte()'}, svelteGrab()]`);
	console.log('');
}
