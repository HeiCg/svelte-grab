import type { SvelteMeta, ThemeConfig } from '../types.js';

/**
 * Element with possible Svelte metadata
 */
export type SvelteElement = HTMLElement & { __svelte_meta?: SvelteMeta };

/**
 * Dark theme preset
 */
export const DARK_THEME: ThemeConfig = {
	background: '#1a1a2e',
	border: '#4a4a6a',
	text: '#e0e0e0',
	accent: '#ff6b35'
};

/**
 * Light theme preset
 */
export const LIGHT_THEME: ThemeConfig = {
	background: '#ffffff',
	border: '#e0e0e0',
	text: '#1a1a2e',
	accent: '#e85d04'
};

/**
 * Resolve theme from props
 */
export function resolveTheme(lightTheme: boolean, overrides: ThemeConfig): Required<ThemeConfig> {
	const base = lightTheme ? LIGHT_THEME : DARK_THEME;
	return {
		background: overrides.background ?? base.background!,
		border: overrides.border ?? base.border!,
		text: overrides.text ?? base.text!,
		accent: overrides.accent ?? base.accent!
	};
}

/**
 * Check if a file path should be excluded (generated/internal files)
 */
export function isExcludedPath(filePath: string): boolean {
	return (
		filePath.includes('.svelte-kit/') ||
		filePath.includes('node_modules/') ||
		filePath.includes('generated/') ||
		filePath.startsWith('/@') ||
		filePath.includes('__vite')
	);
}

/**
 * Shorten a file path for display
 */
export function shortenPath(fullPath: string): string {
	const srcMatch = fullPath.match(/\/src\/(.*)/);
	if (srcMatch) return `src/${srcMatch[1]}`;

	const libMatch = fullPath.match(/\/lib\/(.*)/);
	if (libMatch) return `lib/${libMatch[1]}`;

	if (fullPath.startsWith('/src/') || fullPath.startsWith('/lib/')) {
		return fullPath.slice(1);
	}

	return fullPath;
}

/**
 * Extract component name from file path
 */
export function extractComponentName(filePath: string): string | null {
	const match = filePath.match(/\/([^/]+)\.svelte$/);
	return match ? match[1] : null;
}

/**
 * Find the closest element with __svelte_meta
 */
export function findSvelteElement(target: HTMLElement): SvelteElement | null {
	let current: HTMLElement | null = target;
	while (current) {
		const meta = (current as SvelteElement).__svelte_meta;
		if (meta?.loc) return current as SvelteElement;
		current = current.parentElement;
	}
	return null;
}

/**
 * Detect Svelte dev mode
 */
export function detectDevMode(forceEnable: boolean): boolean {
	if (forceEnable) return true;

	if ((document.body as SvelteElement).__svelte_meta) return true;

	const selectors = ['#app', '#root', 'main', '[data-sveltekit-hydrate]', '[data-svelte]'];
	for (const selector of selectors) {
		const el = document.querySelector(selector);
		if (el && (el as SvelteElement).__svelte_meta) return true;
	}

	const bodyChildren = document.body.children;
	const maxCheck = Math.min(bodyChildren.length, 10);
	for (let i = 0; i < maxCheck; i++) {
		if ((bodyChildren[i] as SvelteElement).__svelte_meta) return true;
	}

	const allEls = document.querySelectorAll('*');
	const maxBroad = Math.min(allEls.length, 50);
	for (let i = 0; i < maxBroad; i++) {
		if ((allEls[i] as SvelteElement).__svelte_meta) return true;
	}

	return false;
}

/**
 * Copy text to clipboard
 */
export async function copyToClipboard(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		console.error('[SvelteDevKit] Failed to copy to clipboard');
		return false;
	}
}

/**
 * Check modifier key from event
 */
export function checkModifier(event: MouseEvent | KeyboardEvent, modifier: string): boolean {
	switch (modifier) {
		case 'alt': return event.altKey;
		case 'ctrl': return event.ctrlKey;
		case 'meta': return event.metaKey;
		case 'shift': return event.shiftKey;
		default: return event.altKey;
	}
}

/**
 * Map modifier name to KeyboardEvent.key value
 */
export function modifierKeyName(modifier: string): string {
	const map: Record<string, string> = {
		alt: 'Alt',
		ctrl: 'Control',
		meta: 'Meta',
		shift: 'Shift'
	};
	return map[modifier] ?? 'Alt';
}

/**
 * Get an abbreviated HTML preview of an element
 */
export function getElementPreview(element: HTMLElement, maxLen = 80): string {
	const tag = element.tagName.toLowerCase();
	const cls = element.className
		? ` class="${String(element.className).slice(0, 40)}"`
		: '';
	const id = element.id ? ` id="${element.id}"` : '';
	const text = element.textContent?.trim().slice(0, 30) || '';
	const inner = text ? `${text}` : '';
	const preview = `<${tag}${id}${cls}>${inner}</${tag}>`;
	return preview.length > maxLen ? preview.slice(0, maxLen - 3) + '...' : preview;
}
