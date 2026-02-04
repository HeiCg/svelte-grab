<script lang="ts">
	/**
	 * SvelteGrab - Click any element to get component stack with source locations
	 *
	 * Usage:
	 * 1. Add <SvelteGrab /> to your root layout (only works in dev mode)
	 * 2. Alt+Click (Option+Click on Mac) any element
	 * 3. Component stack is automatically copied to clipboard
	 * 4. Paste into your coding agent prompt for instant file location
	 */
	import { onMount, onDestroy } from 'svelte';

	interface SvelteMeta {
		loc?: {
			file: string;
			line: number;
			column: number;
		};
		parent?: DevStackEntry;
	}

	interface DevStackEntry {
		type?: string;
		file?: string;
		line?: number;
		column?: number;
		parent?: DevStackEntry;
	}

	interface StackEntry {
		type: string;
		file: string;
		line: number;
		column: number;
	}

	interface Props {
		/** Keyboard modifier to trigger grab. Default: 'alt' */
		modifier?: 'alt' | 'ctrl' | 'meta' | 'shift';
		/** Auto-copy format when element is grabbed */
		autoCopyFormat?: 'agent' | 'paths' | 'none';
		/** Show visual popup. Set to false for clipboard-only mode */
		showPopup?: boolean;
		/** Force enable even if dev detection fails */
		forceEnable?: boolean;
		/** Custom theme colors */
		theme?: {
			background?: string;
			border?: string;
			text?: string;
			accent?: string;
		};
	}

	let {
		modifier = 'alt',
		autoCopyFormat = 'agent',
		showPopup = true,
		forceEnable = false,
		theme = {}
	}: Props = $props();

	const defaultTheme = {
		background: '#1a1a2e',
		border: '#4a4a6a',
		text: '#e0e0e0',
		accent: '#ff6b35'
	};

	// Use $derived for reactive theme merging
	let colors = $derived({ ...defaultTheme, ...theme });

	let visible = $state(false);
	let stack = $state<StackEntry[]>([]);
	let position = $state({ x: 0, y: 0 });
	let copied = $state(false);
	let isDev = $state(false);

	// Selection mode state
	let selectionMode = $state(false);
	let hoveredElement = $state<HTMLElement | null>(null);
	let hoveredInfo = $state<{ file: string; line: number } | null>(null);
	let hoverPosition = $state({ x: 0, y: 0 });

	function getComponentStack(element: HTMLElement): StackEntry[] {
		const entries: StackEntry[] = [];
		const seen = new Set<string>();
		let current: HTMLElement | null = element;

		while (current) {
			const meta = (current as HTMLElement & { __svelte_meta?: SvelteMeta }).__svelte_meta;

			if (meta) {
				// Add element's own location
				if (meta.loc) {
					const key = `${meta.loc.file}:${meta.loc.line}`;
					if (!seen.has(key)) {
						seen.add(key);
						entries.push({
							type: 'element',
							file: meta.loc.file,
							line: meta.loc.line,
							column: meta.loc.column
						});
					}
				}

				// Walk up the component hierarchy via parent stack
				let parentEntry = meta.parent;
				while (parentEntry) {
					if (parentEntry.file && parentEntry.line) {
						const key = `${parentEntry.file}:${parentEntry.line}`;
						if (!seen.has(key)) {
							seen.add(key);
							entries.push({
								type: parentEntry.type || 'component',
								file: parentEntry.file,
								line: parentEntry.line,
								column: parentEntry.column || 0
							});
						}
					}
					parentEntry = parentEntry.parent;
				}
				break;
			}

			current = current.parentElement;
		}

		return entries;
	}

	function shortenPath(fullPath: string): string {
		// Try to get path relative to src/
		const srcMatch = fullPath.match(/\/src\/(.*)/);
		if (srcMatch) return `src/${srcMatch[1]}`;

		// Try to get just filename
		const parts = fullPath.split('/');
		return parts[parts.length - 1];
	}

	function formatForAgent(entries: StackEntry[]): string {
		if (entries.length === 0) return '';

		const lines = entries.map((entry) => {
			const shortPath = shortenPath(entry.file);
			return `in ${entry.type} at ${shortPath}:${entry.line}`;
		});

		return lines.join('\n');
	}

	function formatPaths(entries: StackEntry[]): string {
		if (entries.length === 0) return 'No Svelte component found';

		return entries
			.map((entry) => `${shortenPath(entry.file)}:${entry.line}:${entry.column}`)
			.join('\n');
	}

	async function copyToClipboard(text: string): Promise<boolean> {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			setTimeout(() => (copied = false), 1500);
			return true;
		} catch {
			console.error('[SvelteGrab] Failed to copy to clipboard');
			return false;
		}
	}

	function checkModifier(event: MouseEvent): boolean {
		switch (modifier) {
			case 'alt': return event.altKey;
			case 'ctrl': return event.ctrlKey;
			case 'meta': return event.metaKey;
			case 'shift': return event.shiftKey;
			default: return event.altKey;
		}
	}

	function handleClick(event: MouseEvent) {
		if (!checkModifier(event)) return;

		event.preventDefault();
		event.stopPropagation();

		const target = event.target as HTMLElement;
		stack = getComponentStack(target);

		if (stack.length === 0) {
			console.log('[SvelteGrab] No Svelte component found for this element');
			return;
		}

		// Auto-copy based on format preference
		if (autoCopyFormat === 'agent') {
			copyToClipboard(formatForAgent(stack));
		} else if (autoCopyFormat === 'paths') {
			copyToClipboard(formatPaths(stack));
		}

		// Clear selection mode when opening popup
		selectionMode = false;
		hoveredElement = null;
		hoveredInfo = null;

		if (showPopup) {
			position = getConstrainedPosition(event.clientX, event.clientY);
			visible = true;
		} else {
			// Console log for clipboard-only mode
			console.log('[SvelteGrab] Component stack copied:\n' + formatForAgent(stack));
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && visible) {
			visible = false;
		}

		// Enter selection mode when modifier key is pressed
		if (isModifierKey(event.key) && !visible) {
			selectionMode = true;
		}
	}

	function handleKeyup(event: KeyboardEvent) {
		// Exit selection mode when modifier key is released
		if (isModifierKey(event.key)) {
			selectionMode = false;
			hoveredElement = null;
			hoveredInfo = null;
		}
	}

	function isModifierKey(key: string): boolean {
		const keyMap: Record<string, string> = {
			alt: 'Alt',
			ctrl: 'Control',
			meta: 'Meta',
			shift: 'Shift'
		};
		return key === keyMap[modifier];
	}

	function handleMouseMove(event: MouseEvent) {
		if (!selectionMode) return;

		const target = event.target as HTMLElement;

		// Find the closest element with __svelte_meta
		let current: HTMLElement | null = target;
		while (current) {
			const meta = (current as HTMLElement & { __svelte_meta?: SvelteMeta }).__svelte_meta;
			if (meta?.loc) {
				if (hoveredElement !== current) {
					hoveredElement = current;
					hoveredInfo = {
						file: shortenPath(meta.loc.file),
						line: meta.loc.line
					};
				}
				hoverPosition = { x: event.clientX, y: event.clientY };
				return;
			}
			current = current.parentElement;
		}

		// No svelte element found
		hoveredElement = null;
		hoveredInfo = null;
	}

	function handleClickOutside() {
		visible = false;
	}

	function getConstrainedPosition(x: number, y: number): { x: number; y: number } {
		const popupWidth = 320; // min-width
		const popupHeight = 300; // approximate height
		const padding = 10;

		const maxX = window.innerWidth - popupWidth / 2 - padding;
		const minX = popupWidth / 2 + padding;
		const maxY = window.innerHeight - popupHeight - padding;
		const minY = padding;

		return {
			x: Math.max(minX, Math.min(maxX, x)),
			y: Math.max(minY, Math.min(maxY, y))
		};
	}

	let cleanup: (() => void) | null = null;

	/**
	 * Detect if Svelte is running in dev mode by checking for __svelte_meta on elements.
	 * This metadata is only attached in development builds.
	 */
	function detectDevMode(): boolean {
		if (forceEnable) return true;

		// Check if any element has __svelte_meta (only exists in dev mode)
		const testElements = document.querySelectorAll('*');
		const maxCheck = Math.min(testElements.length, 100);
		for (let i = 0; i < maxCheck; i++) {
			if ((testElements[i] as HTMLElement & { __svelte_meta?: unknown }).__svelte_meta) {
				return true;
			}
		}

		return false;
	}

	onMount(() => {
		// Small delay to ensure Svelte has attached metadata
		setTimeout(() => {
			isDev = detectDevMode();

			if (!isDev) {
				console.log('[SvelteGrab] Disabled - no Svelte dev metadata found. Use forceEnable={true} to override.');
				return;
			}

			console.log(`[SvelteGrab] Active! Use ${modifier.charAt(0).toUpperCase() + modifier.slice(1)}+Click to grab component info`);

			document.addEventListener('click', handleClick, true);
			document.addEventListener('keydown', handleKeydown);
			document.addEventListener('keyup', handleKeyup);
			document.addEventListener('mousemove', handleMouseMove);

			cleanup = () => {
				document.removeEventListener('click', handleClick, true);
				document.removeEventListener('keydown', handleKeydown);
				document.removeEventListener('keyup', handleKeyup);
				document.removeEventListener('mousemove', handleMouseMove);
			};
		}, 100);
	});

	onDestroy(() => {
		cleanup?.();
	});
</script>

{#if isDev && selectionMode && hoveredElement && !visible}
	{@const rect = hoveredElement.getBoundingClientRect()}
	<div
		class="svelte-grab-highlight"
		style="
			top: {rect.top}px;
			left: {rect.left}px;
			width: {rect.width}px;
			height: {rect.height}px;
			--sg-accent: {colors.accent};
		"
	></div>
	{#if hoveredInfo}
		<div
			class="svelte-grab-tooltip"
			style="
				left: {hoverPosition.x}px;
				top: {hoverPosition.y}px;
				--sg-bg: {colors.background};
				--sg-border: {colors.border};
				--sg-text: {colors.text};
				--sg-accent: {colors.accent};
			"
		>
			<span class="svelte-grab-tooltip-file">{hoveredInfo.file}</span>
			<span class="svelte-grab-tooltip-line">:{hoveredInfo.line}</span>
		</div>
	{/if}
{/if}

{#if isDev && showPopup && visible}
	<div
		class="svelte-grab-overlay"
		onclick={handleClickOutside}
		onkeydown={(e) => e.key === 'Escape' && handleClickOutside()}
		role="presentation"
	>
		<div
			class="svelte-grab-popup"
			style="
				left: {position.x}px;
				top: {position.y}px;
				--sg-bg: {colors.background};
				--sg-border: {colors.border};
				--sg-text: {colors.text};
				--sg-accent: {colors.accent};
			"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			aria-label="SvelteGrab component inspector"
			tabindex="-1"
		>
			<div class="svelte-grab-header">
				<span class="svelte-grab-title">SvelteGrab</span>
				{#if copied}
					<span class="svelte-grab-copied">Copied!</span>
				{/if}
				<button class="svelte-grab-close" onclick={() => (visible = false)}>x</button>
			</div>

			<div class="svelte-grab-content">
				{#each stack as entry, i (entry.file + ':' + entry.line)}
					<div class="svelte-grab-entry" class:svelte-grab-first={i === 0}>
						<span class="svelte-grab-type">{entry.type}</span>
						<button
							class="svelte-grab-path"
							onclick={() => copyToClipboard(`${shortenPath(entry.file)}:${entry.line}`)}
						>
							{shortenPath(entry.file)}:{entry.line}:{entry.column}
						</button>
					</div>
				{/each}
			</div>

			<div class="svelte-grab-footer">
				<button
					class="svelte-grab-btn"
					onclick={() => copyToClipboard(formatForAgent(stack))}
				>
					Copy for Agent
				</button>
				<button
					class="svelte-grab-btn"
					onclick={() => copyToClipboard(formatPaths(stack))}
				>
					Copy Paths
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* Selection mode highlight */
	.svelte-grab-highlight {
		position: fixed;
		pointer-events: none;
		z-index: 99998;
		border: 2px solid var(--sg-accent);
		background: color-mix(in srgb, var(--sg-accent) 15%, transparent);
		border-radius: 4px;
		transition: all 0.1s ease-out;
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--sg-accent) 20%, transparent);
	}

	.svelte-grab-tooltip {
		position: fixed;
		z-index: 99999;
		background: var(--sg-bg);
		border: 1px solid var(--sg-border);
		border-radius: 6px;
		padding: 6px 10px;
		font-family: ui-monospace, 'SF Mono', Menlo, Monaco, 'Cascadia Code', monospace;
		font-size: 11px;
		color: var(--sg-text);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
		transform: translate(12px, 12px);
		pointer-events: none;
		white-space: nowrap;
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.svelte-grab-tooltip-file {
		color: #60a5fa;
	}

	.svelte-grab-tooltip-line {
		color: var(--sg-accent);
		font-weight: 600;
	}

	.svelte-grab-overlay {
		position: fixed;
		inset: 0;
		z-index: 99999;
		background: rgba(0, 0, 0, 0.3);
	}

	.svelte-grab-popup {
		position: fixed;
		background: var(--sg-bg);
		border: 1px solid var(--sg-border);
		border-radius: 8px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
		min-width: 320px;
		max-width: 600px;
		max-height: 400px;
		overflow: hidden;
		font-family: ui-monospace, 'SF Mono', Menlo, Monaco, 'Cascadia Code', monospace;
		font-size: 12px;
		transform: translate(-50%, 10px);
		color: var(--sg-text);
	}

	.svelte-grab-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
		border-bottom: 1px solid var(--sg-border);
	}

	.svelte-grab-title {
		color: var(--sg-accent);
		font-weight: 600;
		flex: 1;
	}

	.svelte-grab-copied {
		color: #4ade80;
		font-size: 11px;
		animation: fade-in 0.2s ease;
	}

	@keyframes fade-in {
		from { opacity: 0; transform: translateY(-4px); }
		to { opacity: 1; transform: translateY(0); }
	}

	.svelte-grab-close {
		background: none;
		border: none;
		color: #888;
		cursor: pointer;
		padding: 2px 6px;
		font-size: 14px;
		border-radius: 4px;
	}

	.svelte-grab-close:hover {
		color: #fff;
		background: rgba(255, 255, 255, 0.1);
	}

	.svelte-grab-content {
		padding: 8px 0;
		max-height: 280px;
		overflow-y: auto;
	}

	.svelte-grab-entry {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 12px;
	}

	.svelte-grab-entry:hover {
		background: rgba(255, 255, 255, 0.05);
	}

	.svelte-grab-first {
		background: rgba(30, 58, 95, 0.5);
	}

	.svelte-grab-type {
		color: #888;
		min-width: 80px;
		font-size: 10px;
		text-transform: uppercase;
	}

	.svelte-grab-path {
		color: #60a5fa;
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
		padding: 2px 4px;
		border-radius: 4px;
		flex: 1;
		font-family: inherit;
		font-size: inherit;
	}

	.svelte-grab-path:hover {
		background: rgba(255, 255, 255, 0.1);
		color: #93c5fd;
	}

	.svelte-grab-footer {
		display: flex;
		gap: 8px;
		padding: 8px 12px;
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
		border-top: 1px solid var(--sg-border);
	}

	.svelte-grab-btn {
		flex: 1;
		padding: 6px 12px;
		background: rgba(255, 255, 255, 0.1);
		border: 1px solid var(--sg-border);
		border-radius: 4px;
		color: var(--sg-text);
		cursor: pointer;
		font-size: 11px;
		font-family: inherit;
		transition: background 0.15s ease;
	}

	.svelte-grab-btn:hover {
		background: rgba(255, 255, 255, 0.15);
	}

	.svelte-grab-btn:active {
		background: rgba(255, 255, 255, 0.2);
	}
</style>
