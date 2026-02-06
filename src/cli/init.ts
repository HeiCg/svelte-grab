import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Detect SvelteKit project and inject SvelteGrab into the root layout.
 */
export function init(cwd: string = process.cwd()): void {
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

	if (isSvelteKit) {
		injectSvelteKit(cwd);
	} else {
		console.log('[svelte-grab] Non-SvelteKit Svelte project detected.');
		console.log('Add <SvelteGrab /> to your root component manually:');
		console.log('');
		console.log('  import { SvelteGrab } from \'svelte-grab\';');
		console.log('');
		console.log('Then add <SvelteGrab /> at the end of your root component template.');
	}
}

function injectSvelteKit(cwd: string): void {
	const layoutPath = join(cwd, 'src', 'routes', '+layout.svelte');

	if (!existsSync(layoutPath)) {
		// Create a basic layout
		mkdirSync(join(cwd, 'src', 'routes'), { recursive: true });
		const content = `<script>
	import { SvelteGrab } from 'svelte-grab';
</script>

<slot />

<SvelteGrab />
`;
		writeFileSync(layoutPath, content, 'utf-8');
		console.log('[svelte-grab] Created src/routes/+layout.svelte with SvelteGrab');
		return;
	}

	// Layout exists, check if already has SvelteGrab
	let content = readFileSync(layoutPath, 'utf-8');

	if (content.includes('SvelteGrab')) {
		console.log('[svelte-grab] SvelteGrab is already in your layout. Nothing to do!');
		return;
	}

	// Add import
	if (content.includes('<script')) {
		// Add import after opening script tag
		content = content.replace(
			/(<script[^>]*>)/,
			`$1\n\timport { SvelteGrab } from 'svelte-grab';`
		);
	} else {
		// No script tag, add one
		content = `<script>\n\timport { SvelteGrab } from 'svelte-grab';\n</script>\n\n` + content;
	}

	// Add component at the end
	content = content.trimEnd() + '\n\n<SvelteGrab />\n';

	writeFileSync(layoutPath, content, 'utf-8');
	console.log('[svelte-grab] Added SvelteGrab to src/routes/+layout.svelte');
}
