import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface InitOptions {
	dryRun?: boolean;
}

/**
 * Detect Svelte project type and inject SvelteGrab into the root layout/component.
 */
export function init(cwd: string = process.cwd(), options: InitOptions = {}): void {
	const { dryRun = false } = options;

	if (dryRun) console.log('[svelte-grab] Dry run mode - no files will be written\n');
	console.log('[svelte-grab] Initializing...');

	// Check for SvelteKit project
	const packageJsonPath = join(cwd, 'package.json');
	if (!existsSync(packageJsonPath)) {
		console.error('[svelte-grab] No package.json found. Run this from your project root.');
		process.exit(1);
	}

	const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
	const deps = {
		...packageJson.dependencies,
		...packageJson.devDependencies
	};

	const isSvelteKit = !!deps['@sveltejs/kit'];
	const isSvelte = !!deps['svelte'];

	if (!isSvelte) {
		console.error('[svelte-grab] This does not appear to be a Svelte project (no svelte dependency found).');
		process.exit(1);
	}

	// Check Svelte version (requires 5+)
	const allDeps = packageJson.dependencies || {};
	const allDevDeps = packageJson.devDependencies || {};
	const svelteVersion = allDeps['svelte'] || allDevDeps['svelte'];
	if (svelteVersion) {
		const majorVersion = parseInt(svelteVersion.replace(/[\^~>=<\s]/g, '') || '0');
		if (majorVersion > 0 && majorVersion < 5) {
			console.error(`[svelte-grab] svelte-grab requires Svelte 5+. Found: ${svelteVersion}`);
			process.exit(1);
		}
	}

	if (isSvelteKit) {
		injectSvelteKit(cwd, dryRun);
	} else {
		// Detect Vite + Svelte: look for vite.config + src/App.svelte
		const hasViteConfig = existsSync(join(cwd, 'vite.config.ts')) || existsSync(join(cwd, 'vite.config.js'));
		const appSveltePath = join(cwd, 'src', 'App.svelte');
		const hasAppSvelte = existsSync(appSveltePath);

		if (hasViteConfig && hasAppSvelte) {
			injectViteSvelte(cwd, dryRun);
		} else {
			console.log('[svelte-grab] Non-SvelteKit Svelte project detected.');
			console.log('Add <SvelteDevKit /> to your root component manually:');
			console.log('');
			console.log('  import { SvelteDevKit } from \'svelte-grab\';');
			console.log('');
			console.log('Then add <SvelteDevKit /> at the end of your root component template.');
		}
	}
}

function injectSvelteKit(cwd: string, dryRun: boolean): void {
	const layoutPath = join(cwd, 'src', 'routes', '+layout.svelte');

	if (!existsSync(layoutPath)) {
		const content = `<script>
	import { dev } from '$app/environment';
	import { SvelteDevKit } from 'svelte-grab';
	let { children } = $props();
</script>

{@render children?.()}

{#if dev}
	<SvelteDevKit />
{/if}
`;
		if (dryRun) {
			console.log(`[svelte-grab] Would create src/routes/+layout.svelte:\n${content}`);
		} else {
			mkdirSync(join(cwd, 'src', 'routes'), { recursive: true });
			writeFileSync(layoutPath, content, 'utf-8');
			console.log('[svelte-grab] Created src/routes/+layout.svelte with SvelteDevKit');
		}
		return;
	}

	// Layout exists, check if already has SvelteGrab
	let content = readFileSync(layoutPath, 'utf-8');

	if (content.includes("from 'svelte-grab'")) {
		console.log('[svelte-grab] svelte-grab is already in your layout. Nothing to do!');
		return;
	}

	// Detect lang="ts" on existing script tag
	const hasLangTs = /<script[^>]*lang=["']ts["']/.test(content);
	const scriptTag = hasLangTs ? '<script lang="ts">' : '<script>';

	// Add import (and children prop if missing)
	// Match <script> but NOT <script context="module">
	if (content.includes('<script')) {
		content = content.replace(
			/(<script(?![^>]*context\s*=)([^>]*)>)/,
			`$1\n\timport { dev } from '$app/environment';\n\timport { SvelteDevKit } from 'svelte-grab';`
		);
		// Add children prop if layout doesn't already destructure it
		if (!content.includes('children')) {
			content = content.replace(
				/import { SvelteDevKit } from 'svelte-grab';/,
				`import { SvelteDevKit } from 'svelte-grab';\n\tlet { children } = $props();`
			);
		}
	} else {
		// No script tag, add one
		content = `${scriptTag}\n\timport { dev } from '$app/environment';\n\timport { SvelteDevKit } from 'svelte-grab';\n\tlet { children } = $props();\n</script>\n\n` + content;
	}

	// Add component at the end with dev gating
	content = content.trimEnd() + '\n\n{#if dev}\n\t<SvelteDevKit />\n{/if}\n';

	if (dryRun) {
		console.log(`[svelte-grab] Would modify src/routes/+layout.svelte:\n${content}`);
	} else {
		writeFileSync(layoutPath, content, 'utf-8');
		console.log('[svelte-grab] Added SvelteDevKit to src/routes/+layout.svelte');
	}
}

function injectViteSvelte(cwd: string, dryRun: boolean): void {
	const appPath = join(cwd, 'src', 'App.svelte');
	let content = readFileSync(appPath, 'utf-8');

	if (content.includes("from 'svelte-grab'")) {
		console.log('[svelte-grab] svelte-grab is already in your App.svelte. Nothing to do!');
		return;
	}

	const hasLangTs = /<script[^>]*lang=["']ts["']/.test(content);
	const scriptTag = hasLangTs ? '<script lang="ts">' : '<script>';

	if (content.includes('<script')) {
		content = content.replace(
			/(<script([^>]*)>)/,
			`$1\n\timport { SvelteDevKit } from 'svelte-grab';`
		);
	} else {
		content = `${scriptTag}\n\timport { SvelteDevKit } from 'svelte-grab';\n</script>\n\n` + content;
	}

	content = content.trimEnd() + '\n\n<SvelteDevKit />\n';

	if (dryRun) {
		console.log(`[svelte-grab] Would modify src/App.svelte:\n${content}`);
	} else {
		writeFileSync(appPath, content, 'utf-8');
		console.log('[svelte-grab] Added SvelteDevKit to src/App.svelte');
	}
}
