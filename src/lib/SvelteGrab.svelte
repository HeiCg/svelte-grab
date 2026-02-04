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
		/** Include HTML preview in output. Default: true */
		includeHtml?: boolean;
		/** Editor to open files in. Default: 'vscode' */
		editor?: 'vscode' | 'cursor' | 'webstorm' | 'none';
		/** Enable Cmd+C / Ctrl+C to copy in selection mode. Default: true */
		copyOnKeyboard?: boolean;
		/** Enable screenshot capture (requires html2canvas). Default: true */
		enableScreenshot?: boolean;
		/** Enable multi-selection mode. Default: true */
		enableMultiSelect?: boolean;
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
		includeHtml = true,
		editor = 'vscode',
		copyOnKeyboard = true,
		enableScreenshot = true,
		enableMultiSelect = true,
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
	let hoverCopied = $state(false);

	// Grabbed element for HTML preview
	let grabbedElement = $state<HTMLElement | null>(null);

	// Multi-selection state
	let selectedElements = $state<HTMLElement[]>([]);

	// Screenshot state
	let screenshotCopied = $state(false);
	let screenshotError = $state<string | null>(null);
	let isCapturingScreenshot = $state(false);
	let html2canvasModule: typeof import('html2canvas') | null = null;

	// Priority attributes for HTML preview (in order of importance)
	const PRIORITY_ATTRS = ['class', 'id', 'type', 'href', 'src', 'name', 'placeholder', 'aria-label'];

	/**
	 * Generate an HTML preview of the element for the agent output
	 */
	function getHTMLPreview(element: HTMLElement): string {
		const tagName = element.tagName.toLowerCase();

		// Collect relevant attributes
		const attrs: string[] = [];
		for (const attrName of PRIORITY_ATTRS) {
			const value = element.getAttribute(attrName);
			if (value) {
				// Truncate long values
				const truncated = value.length > 50 ? value.slice(0, 47) + '...' : value;
				attrs.push(`${attrName}="${truncated}"`);
			}
		}

		// Build opening tag
		const attrString = attrs.length > 0 ? ' ' + attrs.join(' ') : '';

		// Get inner content
		const innerContent = getInnerPreview(element);

		// Self-closing tags
		const selfClosing = ['img', 'input', 'br', 'hr', 'meta', 'link'];
		if (selfClosing.includes(tagName)) {
			return `<${tagName}${attrString} />`;
		}

		// If no inner content, use self-closing style for brevity
		if (!innerContent) {
			return `<${tagName}${attrString}></${tagName}>`;
		}

		return `<${tagName}${attrString}>\n  ${innerContent}\n</${tagName}>`;
	}

	/**
	 * Build editor URL based on configured editor
	 */
	function buildEditorUrl(file: string, line: number): string | null {
		if (editor === 'none') return null;

		// Get absolute path - if file starts with src/, it's relative to project root
		// In dev mode, Svelte provides paths like /src/lib/... or full paths
		const absolutePath = file.startsWith('/') ? file : `/${file}`;

		switch (editor) {
			case 'vscode':
				return `vscode://file${absolutePath}:${line}`;
			case 'cursor':
				return `cursor://file${absolutePath}:${line}`;
			case 'webstorm':
				return `webstorm://open?file=${absolutePath}&line=${line}`;
			default:
				return null;
		}
	}

	/**
	 * Open file in configured editor
	 */
	function openInEditor(file: string, line: number): void {
		const url = buildEditorUrl(file, line);
		if (url) {
			window.open(url, '_self');
		}
	}

	/**
	 * Get a preview of the element's inner content
	 */
	function getInnerPreview(element: HTMLElement): string {
		const children = element.children;

		// If no children, get text content
		if (children.length === 0) {
			const text = element.textContent?.trim() || '';
			if (!text) return '';
			// Truncate long text
			return text.length > 100 ? text.slice(0, 97) + '...' : text;
		}

		// Show child count or first few children
		if (children.length > 2) {
			const firstTag = children[0].tagName.toLowerCase();
			return `<${firstTag}>...</${firstTag}> (${children.length} children)`;
		}

		// Show first 1-2 children as abbreviated tags
		const childPreviews: string[] = [];
		for (let i = 0; i < Math.min(children.length, 2); i++) {
			const child = children[i] as HTMLElement;
			const childTag = child.tagName.toLowerCase();
			const childText = child.textContent?.trim() || '';
			const truncatedText = childText.length > 30 ? childText.slice(0, 27) + '...' : childText;
			childPreviews.push(`<${childTag}>${truncatedText}</${childTag}>`);
		}

		return childPreviews.join('\n  ');
	}

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

	function formatForAgent(entries: StackEntry[], element?: HTMLElement | null): string {
		if (entries.length === 0) return '';

		const parts: string[] = [];

		// Add HTML preview if enabled and element is available
		if (includeHtml && element) {
			parts.push(getHTMLPreview(element));
		}

		// Add stack entries
		const lines = entries.map((entry) => {
			const shortPath = shortenPath(entry.file);
			return `in ${entry.type} at ${shortPath}:${entry.line}`;
		});
		parts.push(lines.join('\n'));

		return parts.join('\n');
	}

	function formatPaths(entries: StackEntry[]): string {
		if (entries.length === 0) return 'No Svelte component found';

		return entries
			.map((entry) => `${shortenPath(entry.file)}:${entry.line}:${entry.column}`)
			.join('\n');
	}

	/**
	 * Format multiple selected elements for agent output
	 */
	function formatMultipleForAgent(elements: HTMLElement[]): string {
		if (elements.length === 0) return '';
		if (elements.length === 1) {
			const elementStack = getComponentStack(elements[0]);
			return formatForAgent(elementStack, elements[0]);
		}

		return elements.map((element, index) => {
			const elementStack = getComponentStack(element);
			return `--- Element ${index + 1} ---\n${formatForAgent(elementStack, element)}`;
		}).join('\n\n');
	}

	/**
	 * Check if an element is in the selected list
	 */
	function isElementSelected(element: HTMLElement): boolean {
		return selectedElements.includes(element);
	}

	/**
	 * Toggle element selection (add or remove from list)
	 */
	function toggleElementSelection(element: HTMLElement): void {
		if (isElementSelected(element)) {
			selectedElements = selectedElements.filter(el => el !== element);
		} else {
			selectedElements = [...selectedElements, element];
		}
	}

	/**
	 * Clear all selected elements
	 */
	function clearSelection(): void {
		selectedElements = [];
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

	/**
	 * Lazy load html2canvas module
	 */
	async function loadHtml2Canvas(): Promise<typeof import('html2canvas') | null> {
		if (html2canvasModule) return html2canvasModule;

		try {
			html2canvasModule = await import('html2canvas');
			return html2canvasModule;
		} catch {
			console.error('[SvelteGrab] html2canvas not installed. Run: npm install html2canvas');
			return null;
		}
	}

	/**
	 * Capture screenshot of element and copy to clipboard
	 */
	async function captureScreenshot(element: HTMLElement): Promise<boolean> {
		if (!enableScreenshot) return false;

		isCapturingScreenshot = true;
		screenshotError = null;

		try {
			const html2canvas = await loadHtml2Canvas();
			if (!html2canvas) {
				screenshotError = 'html2canvas not installed';
				isCapturingScreenshot = false;
				return false;
			}

			// Capture the element as canvas
			const canvas = await html2canvas.default(element, {
				backgroundColor: null,
				logging: false,
				useCORS: true
			});

			// Convert to blob
			const blob = await new Promise<Blob | null>((resolve) => {
				canvas.toBlob(resolve, 'image/png');
			});

			if (!blob) {
				screenshotError = 'Failed to create image';
				isCapturingScreenshot = false;
				return false;
			}

			// Copy to clipboard
			await navigator.clipboard.write([
				new ClipboardItem({
					'image/png': blob
				})
			]);

			screenshotCopied = true;
			setTimeout(() => (screenshotCopied = false), 1500);
			isCapturingScreenshot = false;
			return true;
		} catch (err) {
			console.error('[SvelteGrab] Screenshot failed:', err);
			screenshotError = err instanceof Error ? err.message : 'Screenshot failed';
			isCapturingScreenshot = false;
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

		// Find the actual element with Svelte metadata
		let elementWithMeta: HTMLElement | null = target;
		while (elementWithMeta) {
			const meta = (elementWithMeta as HTMLElement & { __svelte_meta?: SvelteMeta }).__svelte_meta;
			if (meta?.loc) break;
			elementWithMeta = elementWithMeta.parentElement;
		}

		if (!elementWithMeta) {
			console.log('[SvelteGrab] No Svelte component found for this element');
			return;
		}

		// Multi-select mode: Shift + modifier + click
		if (enableMultiSelect && event.shiftKey) {
			toggleElementSelection(elementWithMeta);

			// Auto-copy all selected elements
			if (autoCopyFormat === 'agent' && selectedElements.length > 0) {
				copyToClipboard(formatMultipleForAgent(selectedElements));
			}
			return;
		}

		// Single selection mode (default)
		stack = getComponentStack(elementWithMeta);
		grabbedElement = elementWithMeta;

		if (stack.length === 0) {
			console.log('[SvelteGrab] No Svelte component found for this element');
			return;
		}

		// Auto-copy based on format preference
		if (autoCopyFormat === 'agent') {
			copyToClipboard(formatForAgent(stack, grabbedElement));
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
			console.log('[SvelteGrab] Component stack copied:\n' + formatForAgent(stack, grabbedElement));
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && visible) {
			visible = false;
		}

		// Open first file in editor when "O" is pressed with popup visible
		if ((event.key === 'o' || event.key === 'O') && visible && stack.length > 0) {
			event.preventDefault();
			openInEditor(stack[0].file, stack[0].line);
		}

		// Screenshot when "S" is pressed with popup visible
		if ((event.key === 's' || event.key === 'S') && visible && grabbedElement && enableScreenshot) {
			event.preventDefault();
			captureScreenshot(grabbedElement);
		}

		// Enter selection mode when modifier key is pressed
		if (isModifierKey(event.key) && !visible) {
			selectionMode = true;
		}

		// Cmd+C / Ctrl+C to copy in selection mode
		if (copyOnKeyboard && selectionMode && hoveredElement && (event.metaKey || event.ctrlKey) && event.key === 'c') {
			event.preventDefault();
			const hoverStack = getComponentStack(hoveredElement);
			if (hoverStack.length > 0) {
				copyToClipboard(formatForAgent(hoverStack, hoveredElement));
				// Visual feedback
				hoverCopied = true;
				setTimeout(() => (hoverCopied = false), 1000);
			}
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

{#if isDev && enableMultiSelect && selectedElements.length > 0}
	{#each selectedElements as selectedEl, idx (idx)}
		{@const rect = selectedEl.getBoundingClientRect()}
		<div
			class="svelte-grab-highlight svelte-grab-highlight-selected"
			style="
				top: {rect.top}px;
				left: {rect.left}px;
				width: {rect.width}px;
				height: {rect.height}px;
				--sg-accent: {colors.accent};
			"
		>
			<span class="svelte-grab-selection-badge">{selectedElements.indexOf(selectedEl) + 1}</span>
		</div>
	{/each}
{/if}

{#if isDev && selectionMode && hoveredElement && !visible}
	{@const rect = hoveredElement.getBoundingClientRect()}
	<div
		class="svelte-grab-highlight"
		class:svelte-grab-highlight-copied={hoverCopied}
		class:svelte-grab-highlight-already-selected={isElementSelected(hoveredElement)}
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
			class:svelte-grab-tooltip-copied={hoverCopied}
			style="
				left: {hoverPosition.x}px;
				top: {hoverPosition.y}px;
				--sg-bg: {colors.background};
				--sg-border: {colors.border};
				--sg-text: {colors.text};
				--sg-accent: {colors.accent};
			"
		>
			{#if hoverCopied}
				<span class="svelte-grab-tooltip-copied-text">Copied!</span>
			{:else}
				<span class="svelte-grab-tooltip-file">{hoveredInfo.file}</span>
				<span class="svelte-grab-tooltip-line">:{hoveredInfo.line}</span>
			{/if}
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
							onclick={() => openInEditor(entry.file, entry.line)}
							title="Click to open in {editor}"
						>
							{shortenPath(entry.file)}:{entry.line}:{entry.column}
						</button>
						{#if editor !== 'none'}
							<button
								class="svelte-grab-open-btn"
								onclick={() => openInEditor(entry.file, entry.line)}
								title="Open in {editor}"
							>
								↗
							</button>
						{/if}
					</div>
				{/each}
			</div>

			{#if enableMultiSelect && selectedElements.length > 0}
				<div class="svelte-grab-multi-select-bar">
					<span class="svelte-grab-multi-count">{selectedElements.length} selected</span>
					<button
						class="svelte-grab-btn svelte-grab-btn-small"
						onclick={() => copyToClipboard(formatMultipleForAgent(selectedElements))}
					>
						Copy All
					</button>
					<button
						class="svelte-grab-btn svelte-grab-btn-small"
						onclick={clearSelection}
					>
						Clear
					</button>
				</div>
			{/if}

			<div class="svelte-grab-footer">
				<button
					class="svelte-grab-btn"
					onclick={() => copyToClipboard(formatForAgent(stack, grabbedElement))}
				>
					Copy for Agent
				</button>
				<button
					class="svelte-grab-btn"
					onclick={() => copyToClipboard(formatPaths(stack))}
				>
					Copy Paths
				</button>
				{#if enableScreenshot && grabbedElement}
					<button
						class="svelte-grab-btn"
						class:svelte-grab-btn-success={screenshotCopied}
						onclick={() => grabbedElement && captureScreenshot(grabbedElement)}
						disabled={isCapturingScreenshot}
						title="Press 'S' to screenshot"
					>
						{#if isCapturingScreenshot}
							Capturing...
						{:else if screenshotCopied}
							Screenshot Copied!
						{:else if screenshotError}
							Error: {screenshotError}
						{:else}
							Screenshot (S)
						{/if}
					</button>
				{/if}
				{#if editor !== 'none' && stack.length > 0}
					<button
						class="svelte-grab-btn svelte-grab-btn-accent"
						onclick={() => openInEditor(stack[0].file, stack[0].line)}
						title="Press 'O' to open"
					>
						Open (O)
					</button>
				{/if}
			</div>

			{#if enableMultiSelect}
				<div class="svelte-grab-hint">
					Shift+{modifier.charAt(0).toUpperCase() + modifier.slice(1)}+Click to multi-select
				</div>
			{/if}
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
		transition: all 0.15s ease-out;
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--sg-accent) 20%, transparent);
	}

	.svelte-grab-highlight-copied {
		border-color: #4ade80;
		background: rgba(74, 222, 128, 0.2);
		box-shadow: 0 0 0 4px rgba(74, 222, 128, 0.3);
	}

	.svelte-grab-highlight-selected {
		border-color: #60a5fa;
		background: rgba(96, 165, 250, 0.15);
		box-shadow: 0 0 0 4px rgba(96, 165, 250, 0.2);
	}

	.svelte-grab-highlight-already-selected {
		border-color: #f472b6;
		background: rgba(244, 114, 182, 0.15);
		box-shadow: 0 0 0 4px rgba(244, 114, 182, 0.2);
	}

	.svelte-grab-selection-badge {
		position: absolute;
		top: -8px;
		left: -8px;
		width: 20px;
		height: 20px;
		background: #60a5fa;
		color: white;
		border-radius: 50%;
		font-size: 11px;
		font-weight: 600;
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
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

	.svelte-grab-tooltip-copied {
		border-color: #4ade80;
	}

	.svelte-grab-tooltip-copied-text {
		color: #4ade80;
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

	.svelte-grab-btn-accent {
		background: rgba(255, 107, 53, 0.2);
		border-color: var(--sg-accent);
		color: var(--sg-accent);
	}

	.svelte-grab-btn-accent:hover {
		background: rgba(255, 107, 53, 0.3);
	}

	.svelte-grab-btn-success {
		background: rgba(74, 222, 128, 0.2);
		border-color: #4ade80;
		color: #4ade80;
	}

	.svelte-grab-btn-success:hover {
		background: rgba(74, 222, 128, 0.3);
	}

	.svelte-grab-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.svelte-grab-btn-small {
		flex: 0;
		padding: 4px 8px;
		font-size: 10px;
	}

	.svelte-grab-multi-select-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 12px;
		background: rgba(96, 165, 250, 0.1);
		border-bottom: 1px solid rgba(96, 165, 250, 0.3);
	}

	.svelte-grab-multi-count {
		flex: 1;
		font-size: 11px;
		color: #60a5fa;
		font-weight: 600;
	}

	.svelte-grab-hint {
		padding: 6px 12px;
		font-size: 10px;
		color: #888;
		text-align: center;
		border-top: 1px solid var(--sg-border);
		background: color-mix(in srgb, var(--sg-bg) 50%, black 10%);
	}

	.svelte-grab-open-btn {
		background: none;
		border: none;
		color: #888;
		cursor: pointer;
		padding: 2px 6px;
		font-size: 12px;
		border-radius: 4px;
		opacity: 0;
		transition: opacity 0.15s ease;
	}

	.svelte-grab-entry:hover .svelte-grab-open-btn {
		opacity: 1;
	}

	.svelte-grab-open-btn:hover {
		color: var(--sg-accent);
		background: rgba(255, 255, 255, 0.1);
	}
</style>
