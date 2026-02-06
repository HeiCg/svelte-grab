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
	import { SvelteSet } from 'svelte/reactivity';
	import type {
		SvelteMeta,
		DevStackEntry,
		StackEntry,
		HistoryEntry,
		ThemeConfig,
		SvelteGrabProps,
		SvelteGrabPlugin,
		ContextMenuAction,
		ActionContext,
		AgentContext,
		CopyContext
	} from './types.js';
	import { PluginRegistry } from './core/plugin-registry.js';
	import { createDefaultActions } from './core/context-menu-actions.js';
	import { findSvelteParent, findSvelteChild, findSvelteSibling } from './core/dom-navigation.js';
	import { createGlobalAPI, destroyGlobalAPI } from './core/global-api.js';
	import { AgentClient } from './core/agent-client.js';

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
		projectRoot = '',
		theme = {},
		lightTheme = false,
		showActiveIndicator = true,
		maxHistorySize = 20,
		// New feature props
		plugins = [],
		activationMode = 'hold',
		showToolbar = false,
		showContextMenu = true,
		enableAgentRelay = false,
		agentRelayUrl = 'ws://localhost:4722',
		agentId = 'claude-code',
		enableArrowNav = true,
		enableDragSelect = true,
		enableMcp = false,
		mcpPort = 4723
	}: SvelteGrabProps = $props();

	const darkTheme: ThemeConfig = {
		background: '#1a1a2e',
		border: '#4a4a6a',
		text: '#e0e0e0',
		accent: '#ff6b35'
	};

	const lightThemePreset: ThemeConfig = {
		background: '#ffffff',
		border: '#e0e0e0',
		text: '#1a1a2e',
		accent: '#e85d04'
	};

	// Use $derived for reactive theme selection based on lightTheme prop
	let baseTheme = $derived(lightTheme ? lightThemePreset : darkTheme);

	// Use $derived for reactive theme merging
	let colors = $derived({ ...baseTheme, ...theme });

	// Auto-detected project root from file paths
	let detectedProjectRoot = $state<string | null>(null);

	// History of grabbed elements
	let history = $state<HistoryEntry[]>([]);
	let showHistory = $state(false);

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

	// Multi-selection state (using SvelteSet for O(1) lookups with reactivity)
	let selectedElementsSet = $state(new SvelteSet<HTMLElement>());
	// Derived array for iteration in templates
	let selectedElements = $derived<HTMLElement[]>([...selectedElementsSet]);

	// Screenshot state
	let screenshotCopied = $state(false);
	let screenshotError = $state<string | null>(null);
	let isCapturingScreenshot = $state(false);
	let htmlToImageModule: typeof import('html-to-image') | null = null;

	// ============================================================
	// Plugin system state
	// ============================================================
	let pluginRegistry = new PluginRegistry();

	// ============================================================
	// Context menu state
	// ============================================================
	let contextMenuVisible = $state(false);
	let contextMenuPos = $state({ x: 0, y: 0 });
	let contextMenuActions = $state<ContextMenuAction[]>([]);
	let contextMenuContext = $state<ActionContext | null>(null);

	// ============================================================
	// Drag selection state
	// ============================================================
	let isDragging = $state(false);
	let dragStart = $state({ x: 0, y: 0 });
	let dragCurrent = $state({ x: 0, y: 0 });

	let selectionBox = $derived({
		left: Math.min(dragStart.x, dragCurrent.x),
		top: Math.min(dragStart.y, dragCurrent.y),
		width: Math.abs(dragCurrent.x - dragStart.x),
		height: Math.abs(dragCurrent.y - dragStart.y)
	});

	// ============================================================
	// Activation mode state
	// ============================================================
	let toggleActive = $state(false);
	let toggleKeyHandled = $state(false);

	// ============================================================
	// Agent relay state
	// ============================================================
	let agentClient: AgentClient | null = null;
	let showAgentPrompt = $state(false);
	let agentPromptText = $state('');
	let agentStatus = $state('');
	let agentStatusVisible = $state(false);
	let agentConnected = $state(false);

	// ============================================================
	// Arrow navigation state
	// ============================================================
	let navElement = $state<HTMLElement | null>(null);

	// ============================================================
	// Toolbar state
	// ============================================================
	let toolbarPos = $state({ x: 20, y: 20 });
	let toolbarDragging = $state(false);
	let toolbarDragOffset = $state({ x: 0, y: 0 });

	// Priority attributes for HTML preview (in order of importance)
	const PRIORITY_ATTRS = [
		'class', 'id', 'type', 'href', 'src', 'name', 'placeholder',
		'aria-label', 'role', 'data-testid', 'data-cy', 'data-test'
	];

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
	 * Try to detect project root from an absolute file path
	 */
	function detectProjectRoot(filePath: string): string | null {
		if (!filePath.startsWith('/') || filePath.startsWith('/.')) {
			return null;
		}

		const srcIndex = filePath.indexOf('/src/');
		if (srcIndex > 0) {
			return filePath.slice(0, srcIndex);
		}

		const libIndex = filePath.indexOf('/lib/');
		if (libIndex > 0) {
			return filePath.slice(0, libIndex);
		}

		return null;
	}

	/**
	 * Build editor URL based on configured editor
	 */
	function buildEditorUrl(file: string, line: number): string | null {
		if (editor === 'none') return null;

		const root = projectRoot || detectedProjectRoot;

		let absolutePath: string;

		const isAbsoluteSystemPath = file.startsWith('/') &&
			!file.startsWith('/.') &&
			(file.startsWith('/Users/') || file.startsWith('/home/') || file.match(/^\/[a-zA-Z]\//));

		if (isAbsoluteSystemPath) {
			absolutePath = file;
		} else if (root) {
			const relativePath = file.startsWith('/') ? file : `/${file}`;
			absolutePath = root.endsWith('/')
				? root.slice(0, -1) + relativePath
				: root + relativePath;
		} else {
			absolutePath = file.startsWith('/') ? file : `/${file}`;
		}

		switch (editor) {
			case 'vscode':
				return `vscode://file${absolutePath}:${line}`;
			case 'cursor':
				return `cursor://file${absolutePath}:${line}`;
			case 'webstorm':
				return `webstorm://open?file=${absolutePath}&line=${line}`;
			case 'zed':
				return `zed://file${absolutePath}:${line}`;
			case 'sublime':
				return `subl://open?url=file://${absolutePath}&line=${line}`;
			case 'idea':
				return `idea://open?file=${absolutePath}&line=${line}`;
			case 'phpstorm':
				return `phpstorm://open?file=${absolutePath}&line=${line}`;
			case 'pycharm':
				return `pycharm://open?file=${absolutePath}&line=${line}`;
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

		if (children.length === 0) {
			const text = element.textContent?.trim() || '';
			if (!text) return '';
			return text.length > 100 ? text.slice(0, 97) + '...' : text;
		}

		if (children.length > 2) {
			const firstTag = children[0].tagName.toLowerCase();
			return `<${firstTag}>...</${firstTag}> (${children.length} children)`;
		}

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

	/**
	 * Check if a file path should be excluded
	 */
	function isExcludedPath(filePath: string): boolean {
		return (
			filePath.includes('.svelte-kit/') ||
			filePath.includes('node_modules/') ||
			filePath.includes('generated/') ||
			filePath.startsWith('/@') ||
			filePath.includes('__vite')
		);
	}

	/**
	 * Extract component name from file path
	 */
	function extractComponentName(filePath: string): string | null {
		const match = filePath.match(/\/([^/]+)\.svelte$/);
		if (match) {
			return match[1];
		}
		return null;
	}

	/**
	 * Add entry to history
	 */
	function addToHistory(entryStack: StackEntry[], element: HTMLElement): void {
		const componentName = entryStack.length > 0 ? extractComponentName(entryStack[0].file) : null;
		const entry: HistoryEntry = {
			timestamp: Date.now(),
			stack: [...entryStack],
			htmlPreview: getHTMLPreview(element),
			componentName
		};

		history = [entry, ...history].slice(0, maxHistorySize);
	}

	/**
	 * Clear history
	 */
	function clearHistory(): void {
		history = [];
	}

	/**
	 * Copy history entry to clipboard
	 */
	function copyHistoryEntry(entry: HistoryEntry): void {
		const formatted = entry.stack.length > 0
			? `${entry.htmlPreview}\nDefined in: ${shortenPath(entry.stack[0].file)}:${entry.stack[0].line}`
			: 'No component info';
		copyToClipboard(formatted);
	}

	function getComponentStack(element: HTMLElement): StackEntry[] {
		const entries: StackEntry[] = [];
		const seen = new Set<string>();
		let current: HTMLElement | null = element;

		while (current) {
			const meta = (current as HTMLElement & { __svelte_meta?: SvelteMeta }).__svelte_meta;

			if (meta) {
				if (meta.loc && !isExcludedPath(meta.loc.file)) {
					const key = `${meta.loc.file}:${meta.loc.line}`;
					if (!seen.has(key)) {
						seen.add(key);
						entries.push({
							type: 'element',
							file: meta.loc.file,
							line: meta.loc.line,
							column: meta.loc.column
						});

						if (!detectedProjectRoot && !projectRoot) {
							detectedProjectRoot = detectProjectRoot(meta.loc.file);
						}
					}
				}

				let parentEntry = meta.parent;
				while (parentEntry) {
					if (parentEntry.file && parentEntry.line && !isExcludedPath(parentEntry.file)) {
						const key = `${parentEntry.file}:${parentEntry.line}`;
						if (!seen.has(key)) {
							seen.add(key);
							entries.push({
								type: parentEntry.type || 'component',
								file: parentEntry.file,
								line: parentEntry.line,
								column: parentEntry.column || 0
							});

							if (!detectedProjectRoot && !projectRoot) {
								detectedProjectRoot = detectProjectRoot(parentEntry.file);
							}
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
		const srcMatch = fullPath.match(/\/src\/(.*)/);
		if (srcMatch) return `src/${srcMatch[1]}`;

		const libMatch = fullPath.match(/\/lib\/(.*)/);
		if (libMatch) return `lib/${libMatch[1]}`;

		if (fullPath.startsWith('/src/') || fullPath.startsWith('/lib/')) {
			return fullPath.slice(1);
		}

		return fullPath;
	}

	function formatForAgent(entries: StackEntry[], element?: HTMLElement | null): string {
		if (entries.length === 0) return '';

		const parts: string[] = [];

		if (includeHtml && element) {
			parts.push(getHTMLPreview(element));
		}

		const definedIn = entries[0];
		const usedIn = entries.find(e => e.file !== definedIn.file);

		if (usedIn) {
			parts.push(`Used in: ${shortenPath(usedIn.file)}:${usedIn.line}`);
		}
		parts.push(`Defined in: ${shortenPath(definedIn.file)}:${definedIn.line}`);

		return parts.join('\n');
	}

	function formatPaths(entries: StackEntry[]): string {
		if (entries.length === 0) return 'No Svelte component found';

		const definedIn = entries[0];
		const usedIn = entries.find(e => e.file !== definedIn.file);

		const lines: string[] = [];
		if (usedIn) {
			lines.push(`Used in: ${shortenPath(usedIn.file)}:${usedIn.line}:${usedIn.column}`);
		}
		lines.push(`Defined in: ${shortenPath(definedIn.file)}:${definedIn.line}:${definedIn.column}`);

		return lines.join('\n');
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
		return selectedElementsSet.has(element);
	}

	/**
	 * Toggle element selection
	 */
	function toggleElementSelection(element: HTMLElement): void {
		if (selectedElementsSet.has(element)) {
			selectedElementsSet.delete(element);
		} else {
			selectedElementsSet.add(element);
		}
		pluginRegistry.executeHook('onSelectionChange', [...selectedElementsSet]);
	}

	/**
	 * Clear all selected elements
	 */
	function clearSelection(): void {
		selectedElementsSet.clear();
		pluginRegistry.executeHook('onSelectionChange', []);
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
	 * Send context to the MCP server (fire-and-forget).
	 */
	function sendToMcp(content: string[], prompt?: string): void {
		if (!enableMcp) return;

		fetch(`http://localhost:${mcpPort}/context`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content, prompt })
		}).catch(() => {
			// Fire-and-forget: don't block the UI if MCP server is not running
		});
	}

	/**
	 * Lazy load html-to-image module
	 */
	async function loadHtmlToImage(): Promise<typeof import('html-to-image') | null> {
		if (htmlToImageModule) return htmlToImageModule;

		try {
			htmlToImageModule = await import('html-to-image');
			return htmlToImageModule;
		} catch {
			console.error('[SvelteGrab] html-to-image not installed. Run: npm install html-to-image');
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
			const htmlToImage = await loadHtmlToImage();
			if (!htmlToImage) {
				screenshotError = 'html-to-image not installed';
				isCapturingScreenshot = false;
				return false;
			}

			const blob = await htmlToImage.toBlob(element, {
				backgroundColor: undefined,
				skipFonts: true
			});

			if (!blob) {
				screenshotError = 'Failed to create image';
				isCapturingScreenshot = false;
				return false;
			}

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
		// Close context menu on any click
		if (contextMenuVisible) {
			contextMenuVisible = false;
			return;
		}

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

		// Plugin hook
		pluginRegistry.executeHook('onElementGrab', elementWithMeta, getComponentStack(elementWithMeta));

		// Multi-select mode: Shift + modifier + click
		if (enableMultiSelect && event.shiftKey) {
			toggleElementSelection(elementWithMeta);

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

		// Add to history
		addToHistory(stack, elementWithMeta);

		// Debug: log raw paths
		console.log('[SvelteGrab] Raw paths:', stack.map(e => e.file));

		// Auto-copy based on format preference
		if (autoCopyFormat === 'agent') {
			const content = formatForAgent(stack, grabbedElement);
			const copyCtx: CopyContext = { format: 'agent', elements: [grabbedElement], content };
			const transformed = pluginRegistry.transformContent('beforeCopy', content, copyCtx);
			copyToClipboard(typeof transformed === 'string' ? transformed : content);
			pluginRegistry.executeHook('afterCopy', copyCtx);

			// Send to MCP server
			sendToMcp([typeof transformed === 'string' ? transformed : content]);
		} else if (autoCopyFormat === 'paths') {
			copyToClipboard(formatPaths(stack));
			sendToMcp([formatPaths(stack)]);
		}

		// Clear selection mode when opening popup
		selectionMode = false;
		hoveredElement = null;
		hoveredInfo = null;

		if (showPopup) {
			position = getConstrainedPosition(event.clientX, event.clientY);
			visible = true;
		} else {
			console.log('[SvelteGrab] Component stack copied:\n' + formatForAgent(stack, grabbedElement));
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			if (visible) {
				visible = false;
				return;
			}
			if (showAgentPrompt) {
				showAgentPrompt = false;
				return;
			}
			if (contextMenuVisible) {
				contextMenuVisible = false;
				return;
			}
			// In toggle mode, escape deactivates
			if (activationMode === 'toggle' && toggleActive) {
				toggleActive = false;
				selectionMode = false;
				hoveredElement = null;
				hoveredInfo = null;
				return;
			}
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

		// Tab to open agent prompt (when in selection mode with agent relay)
		if (event.key === 'Tab' && selectionMode && enableAgentRelay) {
			event.preventDefault();
			showAgentPrompt = true;
		}

		// Activation mode handling
		if (isModifierKey(event.key) && !visible) {
			if (activationMode === 'toggle') {
				if (!toggleKeyHandled) {
					toggleKeyHandled = true;
					toggleActive = !toggleActive;
					selectionMode = toggleActive;
					if (toggleActive) {
						pluginRegistry.executeHook('onActivate');
					} else {
						pluginRegistry.executeHook('onDeactivate');
						hoveredElement = null;
						hoveredInfo = null;
					}
				}
			} else {
				// Hold mode
				selectionMode = true;
				pluginRegistry.executeHook('onActivate');
			}
		}

		// Arrow key navigation in selection mode
		if (selectionMode && enableArrowNav && hoveredElement) {
			let nextEl: HTMLElement | null = null;

			switch (event.key) {
				case 'ArrowUp':
					event.preventDefault();
					nextEl = findSvelteParent(hoveredElement);
					break;
				case 'ArrowDown':
					event.preventDefault();
					nextEl = findSvelteChild(hoveredElement);
					break;
				case 'ArrowLeft':
					event.preventDefault();
					nextEl = findSvelteSibling(hoveredElement, 'prev');
					break;
				case 'ArrowRight':
					event.preventDefault();
					nextEl = findSvelteSibling(hoveredElement, 'next');
					break;
			}

			if (nextEl) {
				hoveredElement = nextEl;
				navElement = nextEl;
				const meta = (nextEl as HTMLElement & { __svelte_meta?: SvelteMeta }).__svelte_meta;
				if (meta?.loc) {
					hoveredInfo = {
						file: shortenPath(meta.loc.file),
						line: meta.loc.line
					};
				}
				nextEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
				const rect = nextEl.getBoundingClientRect();
				hoverPosition = { x: rect.right + 10, y: rect.top };
			}
		}

		// Cmd+C / Ctrl+C to copy in selection mode
		if (copyOnKeyboard && selectionMode && hoveredElement && (event.metaKey || event.ctrlKey) && event.key === 'c') {
			event.preventDefault();
			const hoverStack = getComponentStack(hoveredElement);
			if (hoverStack.length > 0) {
				copyToClipboard(formatForAgent(hoverStack, hoveredElement));
				hoverCopied = true;
				setTimeout(() => (hoverCopied = false), 1000);
			}
		}
	}

	function handleKeyup(event: KeyboardEvent) {
		if (isModifierKey(event.key)) {
			if (activationMode === 'toggle') {
				// Just reset the handled flag, don't deactivate
				toggleKeyHandled = false;
			} else {
				// Hold mode: deactivate on key release
				selectionMode = false;
				hoveredElement = null;
				hoveredInfo = null;
				pluginRegistry.executeHook('onDeactivate');
			}
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
		// Toolbar dragging
		if (toolbarDragging) {
			toolbarPos = {
				x: event.clientX - toolbarDragOffset.x,
				y: event.clientY - toolbarDragOffset.y
			};
			return;
		}

		// Drag selection
		if (isDragging && enableDragSelect) {
			dragCurrent = { x: event.clientX, y: event.clientY };

			// Find elements intersecting the selection box
			const box = {
				left: Math.min(dragStart.x, dragCurrent.x),
				top: Math.min(dragStart.y, dragCurrent.y),
				right: Math.max(dragStart.x, dragCurrent.x),
				bottom: Math.max(dragStart.y, dragCurrent.y)
			};

			// Only update hover highlight for drag, actual selection happens on mouseup
			const elementsInBox = document.elementsFromPoint(
				(box.left + box.right) / 2,
				(box.top + box.bottom) / 2
			);
			// Find elements with svelte meta that intersect
			for (const el of elementsInBox) {
				const meta = (el as HTMLElement & { __svelte_meta?: SvelteMeta }).__svelte_meta;
				if (meta?.loc) {
					hoveredElement = el as HTMLElement;
					break;
				}
			}
			return;
		}

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
					pluginRegistry.executeHook('onElementHover', current);
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

	/**
	 * Handle context menu (right-click) in selection mode
	 */
	function handleContextMenu(event: MouseEvent) {
		if (!selectionMode || !showContextMenu || !hoveredElement) return;

		event.preventDefault();
		event.stopPropagation();

		const meta = (hoveredElement as HTMLElement & { __svelte_meta?: SvelteMeta }).__svelte_meta || null;
		const elementStack = getComponentStack(hoveredElement);

		const ctx: ActionContext = {
			element: hoveredElement,
			selectedElements: [...selectedElementsSet],
			meta,
			stack: elementStack
		};

		contextMenuContext = ctx;

		// Build actions: plugin actions + default actions
		const pluginActions = pluginRegistry.getContextMenuActions();
		const defaultActions = createDefaultActions({
			copyForAgent: () => {
				if (ctx.stack.length > 0) {
					copyToClipboard(formatForAgent(ctx.stack, ctx.element));
				}
			},
			copyHtml: () => {
				copyToClipboard(getHTMLPreview(ctx.element));
			},
			copyPaths: () => {
				copyToClipboard(formatPaths(ctx.stack));
			},
			openInEditor: () => {
				if (ctx.stack.length > 0) {
					openInEditor(ctx.stack[0].file, ctx.stack[0].line);
				}
			},
			captureScreenshot: () => {
				captureScreenshot(ctx.element);
			},
			sendToAgent: () => {
				showAgentPrompt = true;
				contextMenuVisible = false;
			},
			hasEditor: editor !== 'none',
			hasScreenshot: enableScreenshot,
			hasAgentRelay: enableAgentRelay
		});

		// Filter visible actions
		const allActions = [...pluginActions, ...defaultActions];
		contextMenuActions = allActions.filter(a => !a.isVisible || a.isVisible(ctx));

		contextMenuPos = { x: event.clientX, y: event.clientY };
		contextMenuVisible = true;
	}

	/**
	 * Handle context menu action click
	 */
	function handleContextAction(action: ContextMenuAction): void {
		if (contextMenuContext && (!action.isEnabled || action.isEnabled(contextMenuContext))) {
			action.onAction(contextMenuContext);
		}
		contextMenuVisible = false;
	}

	/**
	 * Handle mouse down for drag selection
	 */
	function handleMouseDown(event: MouseEvent) {
		// Toolbar drag start
		const target = event.target as HTMLElement;
		if (target.closest('.sg-toolbar') && event.button === 0) {
			const toolbar = target.closest('.sg-toolbar') as HTMLElement;
			toolbarDragging = true;
			toolbarDragOffset = {
				x: event.clientX - toolbar.getBoundingClientRect().left,
				y: event.clientY - toolbar.getBoundingClientRect().top
			};
			event.preventDefault();
			return;
		}

		if (!selectionMode || !enableDragSelect || event.button !== 0) return;

		// Don't start drag if shift is held (that's multi-select click)
		if (event.shiftKey) return;

		// Don't start drag on our own UI elements
		if ((event.target as HTMLElement).closest('[class*="svelte-grab-"], [class*="sg-"]')) return;

		isDragging = true;
		dragStart = { x: event.clientX, y: event.clientY };
		dragCurrent = { x: event.clientX, y: event.clientY };
	}

	/**
	 * Handle mouse up for drag selection
	 */
	function handleMouseUp(event: MouseEvent) {
		if (toolbarDragging) {
			toolbarDragging = false;
			return;
		}

		if (!isDragging) return;

		isDragging = false;

		// Calculate final selection box
		const box = {
			left: selectionBox.left,
			top: selectionBox.top,
			right: selectionBox.left + selectionBox.width,
			bottom: selectionBox.top + selectionBox.height
		};

		// Only select if drag was significant (not just a click)
		if (selectionBox.width < 5 && selectionBox.height < 5) return;

		// Find all elements with svelte meta that intersect the box
		const allElements = document.querySelectorAll('*');
		for (const el of allElements) {
			const meta = (el as HTMLElement & { __svelte_meta?: SvelteMeta }).__svelte_meta;
			if (!meta?.loc) continue;

			const rect = el.getBoundingClientRect();
			// Check intersection
			if (rect.right >= box.left && rect.left <= box.right &&
				rect.bottom >= box.top && rect.top <= box.bottom) {
				selectedElementsSet.add(el as HTMLElement);
			}
		}

		pluginRegistry.executeHook('onSelectionChange', [...selectedElementsSet]);

		// Auto-copy selected
		if (autoCopyFormat === 'agent' && selectedElements.length > 0) {
			copyToClipboard(formatMultipleForAgent([...selectedElementsSet]));
		}
	}

	function handleClickOutside() {
		visible = false;
	}

	function getConstrainedPosition(x: number, y: number): { x: number; y: number } {
		const popupWidth = 320;
		const popupHeight = 300;
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

	/**
	 * Submit agent request via relay
	 */
	function submitAgentRequest(): void {
		if (!agentClient || !agentClient.connected) {
			agentStatus = 'Not connected to relay';
			agentStatusVisible = true;
			setTimeout(() => (agentStatusVisible = false), 3000);
			return;
		}

		const content = selectedElements.length > 0
			? [formatMultipleForAgent(selectedElements)]
			: hoveredElement
				? [formatForAgent(getComponentStack(hoveredElement), hoveredElement)]
				: [];

		const ctx: AgentContext = {
			content,
			prompt: agentPromptText,
			selectedCount: selectedElements.length || (hoveredElement ? 1 : 0)
		};

		// Plugin transform
		const transformed = pluginRegistry.transformContent('beforeAgentSend', ctx, ctx);
		const finalCtx = (transformed && typeof transformed === 'object') ? transformed as AgentContext : ctx;

		agentClient.sendRequest(agentId, {
			content: finalCtx.content,
			prompt: finalCtx.prompt,
			selectedCount: finalCtx.selectedCount
		});

		agentStatus = 'Sending to agent...';
		agentStatusVisible = true;
		showAgentPrompt = false;
		agentPromptText = '';
	}

	/**
	 * Handle keydown in agent prompt textarea
	 */
	function handleAgentKeydown(event: KeyboardEvent): void {
		// Cmd+Enter or Ctrl+Enter to send
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			submitAgentRequest();
		}
	}

	let cleanup: (() => void) | null = null;

	/**
	 * Detect if Svelte is running in dev mode
	 */
	function detectDevMode(): boolean {
		if (forceEnable) return true;

		if ((document.body as HTMLElement & { __svelte_meta?: unknown }).__svelte_meta) {
			return true;
		}

		const prioritySelectors = ['#app', '#root', 'main', '[data-sveltekit-hydrate]', '[data-svelte]'];
		for (const selector of prioritySelectors) {
			const el = document.querySelector(selector);
			if (el && (el as HTMLElement & { __svelte_meta?: unknown }).__svelte_meta) {
				return true;
			}
		}

		const bodyChildren = document.body.children;
		const maxCheck = Math.min(bodyChildren.length, 10);
		for (let i = 0; i < maxCheck; i++) {
			if ((bodyChildren[i] as HTMLElement & { __svelte_meta?: unknown }).__svelte_meta) {
				return true;
			}
		}

		const testElements = document.querySelectorAll('*');
		const maxBroadCheck = Math.min(testElements.length, 50);
		for (let i = 0; i < maxBroadCheck; i++) {
			if ((testElements[i] as HTMLElement & { __svelte_meta?: unknown }).__svelte_meta) {
				return true;
			}
		}

		return false;
	}

	onMount(() => {
		setTimeout(() => {
			isDev = detectDevMode();

			if (!isDev) {
				console.log('[SvelteGrab] Disabled - no Svelte dev metadata found. Use forceEnable={true} to override.');
				return;
			}

			console.log(`[SvelteGrab] Active! Use ${modifier.charAt(0).toUpperCase() + modifier.slice(1)}+Click to grab component info`);

			// Register plugins
			const { api, callbacks } = createGlobalAPI();

			for (const plugin of plugins) {
				pluginRegistry.register(plugin, api);
			}

			// Wire up global API callbacks
			callbacks.activate = () => {
				if (activationMode === 'toggle') {
					toggleActive = true;
				}
				selectionMode = true;
				pluginRegistry.executeHook('onActivate');
			};
			callbacks.deactivate = () => {
				if (activationMode === 'toggle') {
					toggleActive = false;
				}
				selectionMode = false;
				hoveredElement = null;
				hoveredInfo = null;
				pluginRegistry.executeHook('onDeactivate');
			};
			callbacks.toggle = () => {
				if (selectionMode) {
					callbacks.deactivate();
				} else {
					callbacks.activate();
				}
			};
			callbacks.isActive = () => selectionMode;
			callbacks.grab = (el: HTMLElement) => getComponentStack(el);
			callbacks.copyElement = async (el: HTMLElement, fmt?: 'agent' | 'paths') => {
				const elStack = getComponentStack(el);
				if (elStack.length === 0) return false;
				const text = fmt === 'paths' ? formatPaths(elStack) : formatForAgent(elStack, el);
				return copyToClipboard(text);
			};
			callbacks.registerPlugin = (plugin: SvelteGrabPlugin) => {
				pluginRegistry.register(plugin, api);
			};
			callbacks.getHistory = () => [...history];
			callbacks.getSelectedElements = () => [...selectedElementsSet];
			callbacks.clearSelection = () => clearSelection();

			// Connect agent relay if enabled
			if (enableAgentRelay) {
				agentClient = new AgentClient();
				agentClient.onStatus = (msg) => {
					agentStatus = msg;
					agentStatusVisible = true;
				};
				agentClient.onDone = (result) => {
					agentStatus = 'Agent done!';
					setTimeout(() => (agentStatusVisible = false), 3000);
					pluginRegistry.executeHook('afterAgentResponse', result);
					console.log('[SvelteGrab] Agent response:', result);
				};
				agentClient.onError = (err) => {
					agentStatus = `Agent error: ${err}`;
					setTimeout(() => (agentStatusVisible = false), 5000);
				};
				agentClient.onConnectionChange = (connected) => {
					agentConnected = connected;
					if (connected) {
						console.log('[SvelteGrab] Connected to agent relay');
					}
				};
				agentClient.connect(agentRelayUrl);
			}

			document.addEventListener('click', handleClick, true);
			document.addEventListener('keydown', handleKeydown);
			document.addEventListener('keyup', handleKeyup);
			document.addEventListener('mousemove', handleMouseMove);
			document.addEventListener('contextmenu', handleContextMenu, true);
			document.addEventListener('mousedown', handleMouseDown, true);
			document.addEventListener('mouseup', handleMouseUp, true);

			cleanup = () => {
				document.removeEventListener('click', handleClick, true);
				document.removeEventListener('keydown', handleKeydown);
				document.removeEventListener('keyup', handleKeyup);
				document.removeEventListener('mousemove', handleMouseMove);
				document.removeEventListener('contextmenu', handleContextMenu, true);
				document.removeEventListener('mousedown', handleMouseDown, true);
				document.removeEventListener('mouseup', handleMouseUp, true);
			};
		}, 100);
	});

	onDestroy(() => {
		cleanup?.();
		agentClient?.disconnect();
		pluginRegistry.clear();
		destroyGlobalAPI();
	});
</script>

<!-- Active indicator badge -->
{#if isDev && showActiveIndicator && !visible && !selectionMode}
	<div
		class="svelte-grab-active-indicator"
		class:svelte-grab-indicator-light={lightTheme}
		style="--sg-accent: {colors.accent};"
		title="SvelteGrab active - {modifier.charAt(0).toUpperCase() + modifier.slice(1)}+Click to grab"
		role="status"
		aria-live="polite"
	>
		<span class="svelte-grab-indicator-dot"></span>
		<span class="svelte-grab-indicator-text">SG</span>
		{#if enableAgentRelay}
			<span class="sg-relay-dot" class:sg-relay-connected={agentConnected}></span>
		{/if}
	</div>
{/if}

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

	<!-- Floating action bar for multi-selection -->
	{#if !visible}
		<div
			class="svelte-grab-floating-bar"
			style="
				--sg-bg: {colors.background};
				--sg-border: {colors.border};
				--sg-text: {colors.text};
				--sg-accent: {colors.accent};
			"
		>
			<span class="svelte-grab-floating-count">{selectedElements.length} selected</span>
			<button
				class="svelte-grab-floating-btn"
				onclick={() => {
					copyToClipboard(formatMultipleForAgent(selectedElements));
				}}
				title="Copy all selected elements for agent"
			>
				Copy All
			</button>
			{#if enableAgentRelay}
				<button
					class="svelte-grab-floating-btn"
					onclick={() => (showAgentPrompt = true)}
					title="Send to agent"
				>
					Send to Agent
				</button>
			{/if}
			<button
				class="svelte-grab-floating-btn svelte-grab-floating-btn-secondary"
				onclick={clearSelection}
				title="Clear selection"
			>
				Clear
			</button>
		</div>
	{/if}
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
			role="tooltip"
			aria-live="polite"
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

<!-- Drag selection box -->
{#if isDev && isDragging}
	<div
		class="sg-drag-box"
		style="
			left: {selectionBox.left}px;
			top: {selectionBox.top}px;
			width: {selectionBox.width}px;
			height: {selectionBox.height}px;
			--sg-accent: {colors.accent};
		"
	></div>
{/if}

<!-- Context menu -->
{#if isDev && contextMenuVisible && contextMenuContext}
	<div class="sg-context-overlay" onclick={() => (contextMenuVisible = false)} role="presentation">
		<div
			class="sg-context-menu"
			style="
				left: {contextMenuPos.x}px;
				top: {contextMenuPos.y}px;
				--sg-bg: {colors.background};
				--sg-border: {colors.border};
				--sg-text: {colors.text};
				--sg-accent: {colors.accent};
			"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="menu"
			tabindex="-1"
		>
			{#each contextMenuActions as action (action.id)}
				{#if action.divider}
					<div class="sg-context-divider"></div>
				{:else}
					<button
						class="sg-context-item"
						onclick={() => handleContextAction(action)}
						disabled={action.isEnabled && contextMenuContext ? !action.isEnabled(contextMenuContext) : false}
						role="menuitem"
					>
						{#if action.icon}<span class="sg-context-icon">{action.icon}</span>{/if}
						<span class="sg-context-label">{action.label}</span>
						{#if action.shortcut}<span class="sg-context-shortcut">{action.shortcut}</span>{/if}
					</button>
				{/if}
			{/each}
		</div>
	</div>
{/if}

<!-- Toolbar -->
{#if isDev && showToolbar}
	<div
		class="sg-toolbar"
		style="
			left: {toolbarPos.x}px;
			top: {toolbarPos.y}px;
			--sg-bg: {colors.background};
			--sg-border: {colors.border};
			--sg-text: {colors.text};
			--sg-accent: {colors.accent};
		"
		role="toolbar"
		aria-label="SvelteGrab toolbar"
	>
		<span class="sg-toolbar-handle" title="Drag to move">&#8942;&#8942;</span>
		<button
			class="sg-toolbar-btn"
			class:sg-toolbar-btn-active={selectionMode}
			onclick={() => {
				if (selectionMode) {
					selectionMode = false;
					if (activationMode === 'toggle') toggleActive = false;
					hoveredElement = null;
					hoveredInfo = null;
				} else {
					selectionMode = true;
					if (activationMode === 'toggle') toggleActive = true;
				}
			}}
			title={selectionMode ? 'Deactivate selection' : 'Activate selection'}
		>
			{selectionMode ? 'ON' : 'OFF'}
		</button>
		{#if history.length > 0}
			<button
				class="sg-toolbar-btn"
				onclick={() => {
					showHistory = !showHistory;
					if (showHistory && history.length > 0) {
						stack = history[0].stack;
						visible = true;
					}
				}}
				title="History ({history.length})"
			>
				History ({history.length})
			</button>
		{/if}
		{#if selectedElements.length > 0}
			<button class="sg-toolbar-btn" onclick={clearSelection} title="Clear selection">
				Clear ({selectedElements.length})
			</button>
		{/if}
		{#if enableAgentRelay}
			<span class="sg-toolbar-relay" class:sg-toolbar-relay-on={agentConnected}>
				{agentConnected ? 'Relay ON' : 'Relay OFF'}
			</span>
		{/if}
	</div>
{/if}

<!-- Agent prompt -->
{#if isDev && showAgentPrompt}
	<div class="sg-agent-overlay" onclick={() => (showAgentPrompt = false)} role="presentation">
		<div class="sg-agent-prompt" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}
			style="
				--sg-bg: {colors.background};
				--sg-border: {colors.border};
				--sg-text: {colors.text};
				--sg-accent: {colors.accent};
			"
			role="dialog"
			aria-label="Send to agent"
			tabindex="-1"
		>
			<div class="sg-agent-header">
				Send to Agent ({selectedElements.length || (hoveredElement ? 1 : 0)} elements)
			</div>
			<textarea
				class="sg-agent-textarea"
				bind:value={agentPromptText}
				placeholder="Describe what you want the agent to do..."
				onkeydown={handleAgentKeydown}
			></textarea>
			<div class="sg-agent-footer">
				<span class="sg-agent-hint">Cmd+Enter to send</span>
				<button class="sg-agent-send" onclick={submitAgentRequest}>Send</button>
			</div>
		</div>
	</div>
{/if}

<!-- Agent status toast -->
{#if isDev && agentStatusVisible}
	<div
		class="sg-agent-status"
		style="
			--sg-bg: {colors.background};
			--sg-border: {colors.border};
			--sg-text: {colors.text};
			--sg-accent: {colors.accent};
		"
	>
		{agentStatus}
	</div>
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
				{#if stack.length > 0}
					{@const componentName = extractComponentName(stack[0].file)}
					{#if componentName}
						<span class="svelte-grab-component-name">&lt;{componentName}&gt;</span>
					{/if}
				{/if}
				{#if copied}
					<span class="svelte-grab-copied" aria-live="polite">Copied!</span>
				{/if}
				{#if history.length > 0}
					<button
						class="svelte-grab-history-btn"
						class:svelte-grab-history-btn-active={showHistory}
						onclick={() => (showHistory = !showHistory)}
						title="View history ({history.length})"
						aria-expanded={showHistory}
					>
						<span class="svelte-grab-history-icon">&#9201;</span>
						<span class="svelte-grab-history-count">{history.length}</span>
					</button>
				{/if}
				<button class="svelte-grab-close" onclick={() => (visible = false)} aria-label="Close">&times;</button>
			</div>

			<div class="svelte-grab-content">
				{#if stack.length > 0}
					{@const definedIn = stack[0]}
					{@const usedIn = stack.find(e => e.file !== definedIn.file)}

					{#if usedIn}
						<div class="svelte-grab-section-header">Used in</div>
						<div class="svelte-grab-entry">
							<button
								class="svelte-grab-path"
								onclick={() => openInEditor(usedIn.file, usedIn.line)}
								title="Click to open in {editor}"
							>
								{shortenPath(usedIn.file)}:{usedIn.line}
							</button>
							{#if editor !== 'none'}
								<button
									class="svelte-grab-open-btn"
									onclick={() => openInEditor(usedIn.file, usedIn.line)}
									title="Open in {editor}"
								>
									&#8599;
								</button>
							{/if}
						</div>
					{/if}

					<div class="svelte-grab-section-header">Defined in</div>
					<div class="svelte-grab-entry svelte-grab-first">
						<button
							class="svelte-grab-path"
							onclick={() => openInEditor(definedIn.file, definedIn.line)}
							title="Click to open in {editor}"
						>
							{shortenPath(definedIn.file)}:{definedIn.line}
						</button>
						{#if editor !== 'none'}
							<button
								class="svelte-grab-open-btn"
								onclick={() => openInEditor(definedIn.file, definedIn.line)}
								title="Open in {editor}"
							>
								&#8599;
							</button>
						{/if}
					</div>
				{/if}
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

			<!-- History panel -->
			{#if showHistory && history.length > 0}
				<div class="svelte-grab-history-panel" role="region" aria-label="Grab history">
					<div class="svelte-grab-history-header">
						<span>History</span>
						<button
							class="svelte-grab-btn svelte-grab-btn-small"
							onclick={clearHistory}
						>
							Clear
						</button>
					</div>
					<div class="svelte-grab-history-list">
						{#each history as entry, idx (entry.timestamp)}
							<button
								class="svelte-grab-history-item"
								onclick={() => copyHistoryEntry(entry)}
								title="Click to copy"
							>
								<span class="svelte-grab-history-item-name">
									{entry.componentName || 'element'}
								</span>
								<span class="svelte-grab-history-item-path">
									{entry.stack.length > 0 ? shortenPath(entry.stack[0].file) : 'unknown'}
								</span>
								<span class="svelte-grab-history-item-time">
									{new Date(entry.timestamp).toLocaleTimeString()}
								</span>
							</button>
						{/each}
					</div>
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
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
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

	.svelte-grab-section-header {
		padding: 6px 12px 4px;
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		color: #888;
		letter-spacing: 0.5px;
		border-top: 1px solid var(--sg-border);
		margin-top: 4px;
	}

	.svelte-grab-section-header:first-child {
		border-top: none;
		margin-top: 0;
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

	/* Active indicator badge */
	.svelte-grab-active-indicator {
		position: fixed;
		bottom: 16px;
		right: 16px;
		z-index: 99997;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 10px;
		background: rgba(26, 26, 46, 0.9);
		border: 1px solid rgba(255, 107, 53, 0.3);
		border-radius: 20px;
		font-family: ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
		font-size: 10px;
		color: #e0e0e0;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
		cursor: default;
		user-select: none;
		opacity: 0.7;
		transition: opacity 0.2s ease;
	}

	.svelte-grab-active-indicator:hover {
		opacity: 1;
	}

	.svelte-grab-indicator-light {
		background: rgba(255, 255, 255, 0.95);
		color: #1a1a2e;
		border-color: rgba(232, 93, 4, 0.3);
	}

	.svelte-grab-indicator-dot {
		width: 6px;
		height: 6px;
		background: var(--sg-accent);
		border-radius: 50%;
		animation: pulse 2s infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.5; }
	}

	.svelte-grab-indicator-text {
		font-weight: 600;
		letter-spacing: 0.5px;
	}

	/* Relay connection dot in indicator */
	.sg-relay-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #888;
		margin-left: 2px;
	}

	.sg-relay-connected {
		background: #4ade80;
	}

	/* Component name in header */
	.svelte-grab-component-name {
		color: #60a5fa;
		font-size: 11px;
		padding: 2px 6px;
		background: rgba(96, 165, 250, 0.1);
		border-radius: 4px;
	}

	/* History button */
	.svelte-grab-history-btn {
		display: flex;
		align-items: center;
		gap: 4px;
		background: none;
		border: none;
		color: #888;
		cursor: pointer;
		padding: 4px 8px;
		font-size: 11px;
		border-radius: 4px;
		font-family: inherit;
	}

	.svelte-grab-history-btn:hover {
		color: #fff;
		background: rgba(255, 255, 255, 0.1);
	}

	.svelte-grab-history-btn-active {
		color: var(--sg-accent);
		background: rgba(255, 107, 53, 0.1);
	}

	.svelte-grab-history-icon {
		font-size: 12px;
	}

	.svelte-grab-history-count {
		background: rgba(255, 255, 255, 0.1);
		padding: 1px 5px;
		border-radius: 10px;
		font-size: 9px;
	}

	/* History panel */
	.svelte-grab-history-panel {
		border-top: 1px solid var(--sg-border);
		background: color-mix(in srgb, var(--sg-bg) 50%, black 10%);
		max-height: 200px;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.svelte-grab-history-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px;
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		color: #888;
		letter-spacing: 0.5px;
		border-bottom: 1px solid var(--sg-border);
	}

	.svelte-grab-history-list {
		overflow-y: auto;
		flex: 1;
	}

	.svelte-grab-history-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		width: 100%;
		background: none;
		border: none;
		border-bottom: 1px solid rgba(255, 255, 255, 0.05);
		color: var(--sg-text);
		cursor: pointer;
		text-align: left;
		font-family: inherit;
		font-size: 11px;
		transition: background 0.1s ease;
	}

	.svelte-grab-history-item:hover {
		background: rgba(255, 255, 255, 0.05);
	}

	.svelte-grab-history-item:last-child {
		border-bottom: none;
	}

	.svelte-grab-history-item-name {
		color: #60a5fa;
		font-weight: 500;
		min-width: 80px;
	}

	.svelte-grab-history-item-path {
		flex: 1;
		color: #888;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.svelte-grab-history-item-time {
		color: #666;
		font-size: 9px;
	}

	/* Floating action bar for multi-selection */
	.svelte-grab-floating-bar {
		position: fixed;
		bottom: 60px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 99998;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		background: var(--sg-bg);
		border: 1px solid var(--sg-border);
		border-radius: 8px;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
		font-family: ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
		animation: slide-up 0.2s ease-out;
	}

	@keyframes slide-up {
		from {
			opacity: 0;
			transform: translateX(-50%) translateY(10px);
		}
		to {
			opacity: 1;
			transform: translateX(-50%) translateY(0);
		}
	}

	.svelte-grab-floating-count {
		font-size: 12px;
		font-weight: 600;
		color: #60a5fa;
		padding-right: 8px;
		border-right: 1px solid var(--sg-border);
	}

	.svelte-grab-floating-btn {
		padding: 6px 12px;
		background: rgba(96, 165, 250, 0.2);
		border: 1px solid #60a5fa;
		border-radius: 4px;
		color: #60a5fa;
		cursor: pointer;
		font-size: 11px;
		font-weight: 500;
		font-family: inherit;
		transition: all 0.15s ease;
	}

	.svelte-grab-floating-btn:hover {
		background: rgba(96, 165, 250, 0.3);
	}

	.svelte-grab-floating-btn:active {
		background: rgba(96, 165, 250, 0.4);
	}

	.svelte-grab-floating-btn-secondary {
		background: rgba(255, 255, 255, 0.1);
		border-color: var(--sg-border);
		color: var(--sg-text);
	}

	.svelte-grab-floating-btn-secondary:hover {
		background: rgba(255, 255, 255, 0.15);
	}

	/* ============================================================
	   Drag selection box
	   ============================================================ */
	.sg-drag-box {
		position: fixed;
		z-index: 99997;
		border: 2px dashed var(--sg-accent);
		background: color-mix(in srgb, var(--sg-accent) 10%, transparent);
		border-radius: 2px;
		pointer-events: none;
	}

	/* ============================================================
	   Context menu
	   ============================================================ */
	.sg-context-overlay {
		position: fixed;
		inset: 0;
		z-index: 100000;
	}

	.sg-context-menu {
		position: fixed;
		z-index: 100001;
		background: var(--sg-bg);
		border: 1px solid var(--sg-border);
		border-radius: 8px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
		min-width: 200px;
		padding: 4px 0;
		font-family: ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
		font-size: 12px;
	}

	.sg-context-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 8px 12px;
		background: none;
		border: none;
		color: var(--sg-text);
		cursor: pointer;
		font-family: inherit;
		font-size: inherit;
		text-align: left;
		transition: background 0.1s ease;
	}

	.sg-context-item:hover {
		background: rgba(255, 255, 255, 0.08);
	}

	.sg-context-item:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.sg-context-icon {
		width: 20px;
		text-align: center;
		flex-shrink: 0;
	}

	.sg-context-label {
		flex: 1;
	}

	.sg-context-shortcut {
		color: #888;
		font-size: 10px;
		margin-left: auto;
	}

	.sg-context-divider {
		height: 1px;
		margin: 4px 8px;
		background: var(--sg-border);
	}

	/* ============================================================
	   Toolbar
	   ============================================================ */
	.sg-toolbar {
		position: fixed;
		z-index: 99999;
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 6px;
		background: var(--sg-bg);
		border: 1px solid var(--sg-border);
		border-radius: 8px;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
		font-family: ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
		font-size: 11px;
		user-select: none;
	}

	.sg-toolbar-handle {
		cursor: grab;
		color: #888;
		padding: 2px 4px;
		font-size: 10px;
		letter-spacing: -2px;
	}

	.sg-toolbar-handle:active {
		cursor: grabbing;
	}

	.sg-toolbar-btn {
		padding: 4px 8px;
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid var(--sg-border);
		border-radius: 4px;
		color: var(--sg-text);
		cursor: pointer;
		font-family: inherit;
		font-size: 10px;
		transition: all 0.1s ease;
	}

	.sg-toolbar-btn:hover {
		background: rgba(255, 255, 255, 0.15);
	}

	.sg-toolbar-btn-active {
		background: rgba(255, 107, 53, 0.2);
		border-color: var(--sg-accent);
		color: var(--sg-accent);
	}

	.sg-toolbar-relay {
		font-size: 9px;
		padding: 2px 6px;
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.05);
		color: #888;
	}

	.sg-toolbar-relay-on {
		background: rgba(74, 222, 128, 0.15);
		color: #4ade80;
	}

	/* ============================================================
	   Agent prompt
	   ============================================================ */
	.sg-agent-overlay {
		position: fixed;
		inset: 0;
		z-index: 100002;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.sg-agent-prompt {
		background: var(--sg-bg);
		border: 1px solid var(--sg-border);
		border-radius: 12px;
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
		width: 480px;
		max-width: 90vw;
		font-family: ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
		overflow: hidden;
	}

	.sg-agent-header {
		padding: 12px 16px;
		font-size: 13px;
		font-weight: 600;
		color: var(--sg-accent);
		border-bottom: 1px solid var(--sg-border);
	}

	.sg-agent-textarea {
		display: block;
		width: 100%;
		min-height: 100px;
		padding: 12px 16px;
		background: transparent;
		border: none;
		color: var(--sg-text);
		font-family: inherit;
		font-size: 13px;
		resize: vertical;
		outline: none;
	}

	.sg-agent-textarea::placeholder {
		color: #888;
	}

	.sg-agent-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 16px;
		border-top: 1px solid var(--sg-border);
		background: color-mix(in srgb, var(--sg-bg) 70%, white 5%);
	}

	.sg-agent-hint {
		font-size: 10px;
		color: #888;
	}

	.sg-agent-send {
		padding: 6px 16px;
		background: var(--sg-accent);
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-family: inherit;
		font-size: 12px;
		font-weight: 600;
		transition: opacity 0.1s ease;
	}

	.sg-agent-send:hover {
		opacity: 0.9;
	}

	/* Agent status toast */
	.sg-agent-status {
		position: fixed;
		bottom: 16px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 100003;
		padding: 8px 16px;
		background: var(--sg-bg);
		border: 1px solid var(--sg-border);
		border-radius: 8px;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
		font-family: ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
		font-size: 12px;
		color: var(--sg-text);
		animation: slide-up 0.2s ease-out;
	}
</style>
