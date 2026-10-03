<script module lang="ts">
	import { installNetworkCapture } from './runtime/network.js';

	/**
	 * Capture network requests from module evaluation on (dev only), before
	 * the app's first fetches, so `ui_network({ reload: true })` sees the
	 * initial load. The agent runtime retains the capture once it starts; the
	 * early hold is dropped on mount (releaseEarlyNetworkCapture), which
	 * restores the original fetch/XHR/... when the runtime is not running.
	 * No-op outside the Vite dev server and during SSR.
	 */
	installNetworkCapture();
</script>

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
		StackEntry,
		HistoryEntry,
		SvelteGrabProps,
		SvelteGrabPlugin,
		ContextMenuAction,
		ActionContext,
		AgentContext,
		AgentHistoryEntry,
		CopyContext
	} from './types.js';
	import { PluginRegistry } from './core/plugin-registry.js';
	import { createDefaultActions } from './core/context-menu-actions.js';
	import { findSvelteParent, findSvelteChild, findSvelteSibling } from './core/dom-navigation.js';
	import { createGlobalAPI, destroyGlobalAPI } from './core/global-api.js';
	import { AgentClient } from './core/agent-client.js';
	import { freezeGlobalAnimations } from './utils/freeze-animations.js';
	import { freezePseudoStates as freezePseudoStatesFn } from './utils/freeze-pseudo-states.js';
	import { loadHistory, addHistoryEntry } from './utils/history-storage.js';
	import { createElementSelector } from './utils/element-selector.js';
	import { getElementsInDragRect } from './utils/drag-selection.js';
	import { hideFromThirdParties } from './utils/hide-from-third-parties.js';
	import {
		startAgentRuntime,
		withToken,
		MCP_TOKEN_HEADER,
		type AgentRuntimeHandle
	} from './runtime/connection.js';
	import { resolveMcpPort } from './runtime/server-probe.js';
	import { releaseEarlyNetworkCapture } from './runtime/network.js';
	import { annotationStore, addAnnotation, refreshAnnotationRefs } from './runtime/annotations.js';
	import {
		formatAnnotationsForAgent,
		MAX_ANNOTATIONS,
		type Annotation
	} from './utils/annotations.js';
	import {
		ANNOTATION_KEY_LABEL,
		isAnnotationKey,
		isGrabHotkeyEnabled,
		hasReservedModifier,
		type GrabHotkey
	} from './utils/hotkeys.js';
	import {
		getComponentStack as getComponentStackPure,
		findMetaElement,
		getSvelteMeta,
		getSvelteLoc,
		hasSvelteLoc
	} from './utils/component-stack.js';
	import {
		openInEditor as openInEditorPure,
		detectProjectRoot as detectProjectRootPure
	} from './utils/editor-link.js';
	import { getHTMLPreview as getHTMLPreviewPure } from './utils/html-preview.js';
	import {
		formatForAgent as formatForAgentPure,
		formatPaths as formatPathsPure,
		formatMultipleForAgent as formatMultipleForAgentPure,
		type AgentFormatDeps
	} from './utils/agent-format.js';
	import DevToolButton from './ui/DevToolButton.svelte';
	import { resolveTheme } from './utils/resolve-theme.js';
	import { createCopyFeedback } from './utils/copy-with-feedback.js';
	import { COPY_SUCCESS_MS, Z_INDEX, RADIUS, FONT_FAMILY_MONO } from './ui/tokens.js';
	import {
		detectDevMode,
		shortenPath as sharedShortenPath,
		isExcludedPath as sharedIsExcludedPath,
		extractComponentName as sharedExtractComponentName,
		checkModifier as sharedCheckModifier
	} from './utils/shared.js';

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
		mcpPort = 4723,
		mcpToken,
		enableAgentRuntime = true,
		freezeAnimations: freezeAnimationsProp = true,
		freezePseudoStates: freezePseudoStatesProp = true,
		enableHistoryPersistence = true,
		enablePromptMode = true,
		screenshotSkipFonts = true,
		screenshotPixelRatio,
		enableAnnotations = true,
		hotkeys = 'full',
		reservedModifiers = [],
		reservedContextMenuModifiers = [],
		yieldDoubleClick = false
	}: SvelteGrabProps = $props();

	/** Whether a shortcut is active under the `hotkeys` set ('full' keeps all). */
	function hotkeyOn(hotkey: GrabHotkey): boolean {
		return isGrabHotkeyEnabled(hotkeys, hotkey);
	}

	/** Whether a mouse event holds another tool's modifier (see `reservedModifiers`). */
	function isReservedClick(event: MouseEvent): boolean {
		return hasReservedModifier(event, reservedModifiers, modifier);
	}

	/** Whether a right-click is another tool's trigger (see `reservedContextMenuModifiers`). */
	function isReservedContextMenu(event: MouseEvent): boolean {
		return (
			isReservedClick(event) || hasReservedModifier(event, reservedContextMenuModifiers, modifier)
		);
	}

	/**
	 * Close the grab popup and the context menu. SvelteDevKit calls this (via
	 * `bind:this`) when the PropsTracer opens from Modifier+DoubleClick: the
	 * first click of the double-click already grabbed. That grab's clipboard
	 * copy and history entry stay; the tracer's own copy then replaces the
	 * clipboard. The multi-selection is left untouched.
	 */
	export function dismiss(): void {
		visible = false;
		contextMenuVisible = false;
	}

	// Resolve theme via the shared design-system helper so SvelteGrab's colors
	// come from the same resolved theme (--sg-bg / --sg-border / --sg-text /
	// --sg-accent) as every other tool. Wrapped in $derived so theme/lightTheme
	// changes flow through reactively.
	let colors = $derived(resolveTheme(theme, lightTheme));

	// Auto-detected project root from file paths
	let detectedProjectRoot = $state<string | null>(null);

	// History of grabbed elements
	let history = $state<HistoryEntry[]>([]);
	let showHistory = $state(false);

	let visible = $state(false);
	let stack = $state<StackEntry[]>([]);
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

	// Multi-selection state (SvelteSet is already deeply reactive — no $state wrapper needed)
	let selectedElementsSet = new SvelteSet<HTMLElement>();
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
	// Hint toast & help overlay state
	// ============================================================
	let showHintToast = $state(false);
	let showHelpOverlay = $state(false);
	let hintShownThisSession = false;

	// ============================================================
	// Agent relay state
	// ============================================================
	let agentClient: AgentClient | null = null;
	let showAgentPrompt = $state(false);
	let agentPromptText = $state('');
	let agentStatus = $state('');
	let agentStatusVisible = $state(false);
	let agentConnected = $state(false);
	let agentHistory = $state<AgentHistoryEntry[]>([]);
	let lastAgentStatus = $state<'idle' | 'pending' | 'done' | 'error'>('idle');
	let showAgentHistory = $state(false);

	// ============================================================
	// Freeze state
	// ============================================================
	let unfreezeAnimations: (() => void) | null = null;
	let unfreezePseudoStates: (() => void) | null = null;

	// ============================================================
	// Prompt mode state
	// ============================================================
	let promptMode = $state(false);
	// Whether the activation modifier is physically held; lets the prompt overlay
	// survive releasing it (typing with a modifier held garbles input on macOS).
	let modifierHeld = false;
	let promptText = $state('');
	// The prompt overlay doubles as the annotation editor: 'annotate' stores the
	// typed text with `annotationTargets` instead of sending it.
	let promptPurpose = $state<'prompt' | 'annotate'>('prompt');

	// ============================================================
	// Annotation mode state (pending annotations live in runtime/annotations.ts
	// so the `ui_annotations` runtime command reads the same store)
	// ============================================================
	interface AnnotationView {
		annotation: Annotation;
		targets: Element[];
	}
	let annotationTargets = $state.raw<HTMLElement[]>([]);
	let annotationViews = $state.raw<AnnotationView[]>([]);
	let annotationInstruction = $state('');
	let annotationNextId = $state(1);
	let annotationTrayCollapsed = $state(false);
	let annotationsSent = $state(false);
	// Bumped on scroll/resize so the numbered badges follow their elements.
	let layoutTick = $state(0);

	// ============================================================
	// MCP connection state (SSE)
	// ============================================================
	let mcpAgentListening = $state(false);
	let mcpStatus = $state<'idle' | 'watching' | 'processing' | 'sent'>('idle');
	let mcpEventSource: EventSource | null = null;
	// MCP server base URL after the port probe (the server may have fallen back
	// to another port). `null` until resolved: `mcpPort` is used meanwhile.
	let mcpBaseUrl: string | null = null;
	// In-page agent runtime (ui_snapshot / ui_find over the MCP server channel)
	let agentRuntime: AgentRuntimeHandle | null = null;

	// ============================================================
	// Toolbar state
	// ============================================================
	let toolbarPos = $state({ x: 20, y: 20 });
	let toolbarDragging = $state(false);
	let toolbarDragOffset = $state({ x: 0, y: 0 });

	/**
	 * Generate an HTML preview of the element for the agent output.
	 * (Pure logic lives in ./utils/html-preview.ts)
	 */
	function getHTMLPreview(element: HTMLElement): string {
		return getHTMLPreviewPure(element);
	}

	/**
	 * Open file in configured editor: through Vite's `/__open-in-editor` when
	 * the svelte-grab/vite plugin is installed, else the editor deep link.
	 */
	function openInEditor(file: string, line: number): void {
		openInEditorPure(file, line, editor, projectRoot || detectedProjectRoot);
	}

	// Use shared utilities (imported above)
	const isExcludedPath = sharedIsExcludedPath;
	const extractComponentName = sharedExtractComponentName;

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

		// Persist to localStorage when enabled so the grab survives reloads
		// (the load side runs on mount via loadHistory()).
		if (enableHistoryPersistence) {
			try {
				const selector = createElementSelector(element);
				addHistoryEntry({
					timestamp: entry.timestamp,
					componentName: entry.componentName,
					tagName: element.tagName.toLowerCase(),
					htmlPreview: entry.htmlPreview,
					elementSelector: selector,
					stack: entry.stack
				});
			} catch {
				// Graceful degradation if selector generation fails
			}
		}
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
		const formatted =
			entry.stack.length > 0
				? `${entry.htmlPreview}\nDefined in: ${shortenPath(entry.stack[0].file)}:${entry.stack[0].line}`
				: 'No component info';
		copyToClipboard(formatted);
	}

	function getComponentStack(element: HTMLElement): StackEntry[] {
		// Pure stack-walking lives in ./utils/component-stack.ts; the callback
		// preserves the lazy project-root detection from each accepted entry.
		return getComponentStackPure(element, isExcludedPath, (file) => {
			if (!detectedProjectRoot && !projectRoot) {
				detectedProjectRoot = detectProjectRootPure(file);
			}
		});
	}

	const shortenPath = sharedShortenPath;

	/**
	 * Formatting helpers passed to the pure agent-format module.
	 * (Pure logic lives in ./utils/agent-format.ts)
	 */
	let agentFormatDeps = $derived<AgentFormatDeps>({
		includeHtml,
		getHTMLPreview,
		extractComponentName,
		shortenPath
	});

	function formatForAgent(entries: StackEntry[], element?: HTMLElement | null): string {
		return formatForAgentPure(entries, element, agentFormatDeps);
	}

	function formatPaths(entries: StackEntry[]): string {
		return formatPathsPure(entries, shortenPath);
	}

	/**
	 * Format multiple selected elements for agent output
	 */
	function formatMultipleForAgent(elements: HTMLElement[]): string {
		return formatMultipleForAgentPure(elements, getComponentStack, agentFormatDeps);
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

	let copyFailed = $state(false);

	// Shared copy-feedback controller: drives `copied` / `copyFailed` and owns the
	// auto-clear timeouts (COPY_SUCCESS_MS / COPY_FAILURE_MS) the design system uses.
	const copyFb = createCopyFeedback({
		get copied() {
			return copied;
		},
		set copied(v) {
			copied = v;
		},
		get copyFailed() {
			return copyFailed;
		},
		set copyFailed(v) {
			copyFailed = v;
		}
	});

	function copyToClipboard(text: string): Promise<boolean> {
		return copyFb.copy(text);
	}

	/**
	 * Send context to the MCP server (fire-and-forget).
	 */
	function sendToMcp(content: string[], prompt?: string): void {
		if (!enableMcp) return;

		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (mcpToken) headers[MCP_TOKEN_HEADER] = mcpToken;
		fetch(`${mcpBaseUrl ?? `http://localhost:${mcpPort}`}/context`, {
			method: 'POST',
			headers,
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
			console.error(
				'[SvelteGrab] html-to-image not installed. Screenshots are disabled.\n' +
					'  Install it: npm install html-to-image\n' +
					'  Or disable screenshots: <SvelteGrab enableScreenshot={false} />'
			);
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
				skipFonts: screenshotSkipFonts,
				pixelRatio: screenshotPixelRatio
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
			setTimeout(() => (screenshotCopied = false), COPY_SUCCESS_MS);
			isCapturingScreenshot = false;
			return true;
		} catch (err) {
			console.error('[SvelteGrab] Screenshot failed:', err);
			screenshotError = err instanceof Error ? err.message : 'Screenshot failed';
			isCapturingScreenshot = false;
			return false;
		}
	}

	function checkModifier(event: MouseEvent | KeyboardEvent): boolean {
		return sharedCheckModifier(event, modifier);
	}

	/** Activate freeze effects when entering selection mode */
	function activateFreezes(): void {
		if (freezeAnimationsProp && !unfreezeAnimations) {
			unfreezeAnimations = freezeGlobalAnimations();
		}
		if (freezePseudoStatesProp && !unfreezePseudoStates) {
			unfreezePseudoStates = freezePseudoStatesFn();
		}
	}

	/** Deactivate freeze effects when exiting selection mode */
	function deactivateFreezes(): void {
		if (unfreezeAnimations) {
			unfreezeAnimations();
			unfreezeAnimations = null;
		}
		if (unfreezePseudoStates) {
			unfreezePseudoStates();
			unfreezePseudoStates = null;
		}
	}

	/** Enter selection mode with freeze support */
	function enterSelectionMode(): void {
		selectionMode = true;
		activateFreezes();
	}

	/** Exit selection mode with freeze cleanup */
	function exitSelectionMode(): void {
		selectionMode = false;
		promptMode = false;
		promptText = '';
		promptPurpose = 'prompt';
		annotationTargets = [];
		deactivateFreezes();
	}

	/** Close the prompt overlay; leave selection mode too if the modifier was already released */
	function closePromptOverlay(): void {
		promptMode = false;
		promptText = '';
		promptPurpose = 'prompt';
		annotationTargets = [];
		if (activationMode === 'hold' && !modifierHeld) {
			exitSelectionMode();
			document.body.style.cursor = '';
			hoveredElement = null;
			hoveredInfo = null;
			pluginRegistry.executeHook('onDeactivate');
		}
	}

	/** Handle prompt mode confirmation */
	function confirmPrompt(): void {
		const element = hoveredElement || grabbedElement;
		if (!element) {
			closePromptOverlay();
			return;
		}

		const elementStack = getComponentStack(element);
		const formatted = formatForAgent(elementStack, element);

		// Send via MCP (direct to Claude Code session)
		if (enableMcp) {
			sendToMcp([formatted], promptText);
			mcpStatus = 'sent';
			// Reset status after 3s
			setTimeout(() => {
				mcpStatus = mcpAgentListening ? 'watching' : 'idle';
			}, 3000);
		}

		// Send via WebSocket relay
		if (enableAgentRelay && agentClient) {
			agentClient.sendRequest(agentId, {
				content: [formatted],
				prompt: promptText,
				selectedCount: selectedElements.length || 1
			});
		}

		// Fallback: copy to clipboard if no agent transport
		if (!enableMcp && !enableAgentRelay) {
			const withContext = promptText ? `Instructions: ${promptText}\n\n${formatted}` : formatted;
			copyToClipboard(withContext);
		}

		closePromptOverlay();
	}

	// ============================================================
	// Annotation mode
	// ============================================================

	/** Mirror the shared annotation store into component state (badges + tray). */
	function syncAnnotations(): void {
		annotationViews = annotationStore.list().map((annotation) => ({
			annotation,
			targets: annotationStore.targetsOf(annotation.id)
		}));
		// Keep what is being typed (the store trims); pick up clears.
		if (annotationStore.instruction !== annotationInstruction.trim()) {
			annotationInstruction = annotationStore.instruction;
		}
		annotationNextId = annotationStore.nextId;
		annotationsSent = false;
	}

	/**
	 * What an annotation would cover now: the multi / region selection, else the
	 * hovered element (else the last grabbed one, when `withGrabbed`).
	 */
	function currentAnnotationTargets(withGrabbed = false): HTMLElement[] {
		if (selectedElements.length > 0) return [...selectedElements];
		const el = hoveredElement || (withGrabbed ? grabbedElement : null);
		return el ? [el] : [];
	}

	/** Open the prompt overlay as the annotation editor for `targets`. */
	function openAnnotationDraft(targets: HTMLElement[]): void {
		if (!enableAnnotations || targets.length === 0 || annotationStore.isFull) return;
		annotationTargets = targets;
		promptPurpose = 'annotate';
		promptText = '';
		promptMode = true;
	}

	/**
	 * Store `promptText` with `targets` as annotation #N, then close the overlay.
	 * A selection that was annotated is cleared so the next one starts fresh.
	 */
	function saveAnnotation(targets: HTMLElement[]): void {
		const fromSelection =
			selectedElements.length > 0 && targets.every((el) => selectedElementsSet.has(el));
		const added = addAnnotation(promptText, targets);
		if (added && fromSelection) clearSelection();
		closePromptOverlay();
	}

	/**
	 * "Send all": one agent text for every pending annotation, copied to the
	 * clipboard and, with MCP on, posted to `/context` (so watch_for_grab /
	 * get_element_context receive it). The annotations stay pending for
	 * `ui_annotations` until the agent clears them or the human does.
	 */
	function sendAllAnnotations(): void {
		annotationStore.setInstruction(annotationInstruction);
		refreshAnnotationRefs();
		const annotations = annotationStore.list();
		if (annotations.length === 0) return;
		const instruction = annotationStore.instruction;
		const text = formatAnnotationsForAgent(annotations, instruction, shortenPath);
		copyToClipboard(text);
		if (enableMcp) {
			sendToMcp([text], instruction || undefined);
			mcpStatus = 'sent';
			setTimeout(() => {
				mcpStatus = mcpAgentListening ? 'watching' : 'idle';
			}, 3000);
		}
		annotationsSent = true;
	}

	/** `<Component> file:line` of the first element, `+N` for the rest. */
	function annotationSummary(annotation: Annotation): string {
		const first = annotation.refs[0];
		if (!first) return '';
		const parts: string[] = [];
		if (first.component) parts.push(`<${first.component}>`);
		if (first.source) {
			const m = first.source.match(/^(.*):(\d+)$/);
			parts.push(m ? `${shortenPath(m[1]).split('/').pop()}:${m[2]}` : first.source);
		}
		if (annotation.refs.length > 1) parts.push(`+${annotation.refs.length - 1}`);
		return parts.join(' ');
	}

	/** Viewport box of an annotated element; `tick` makes it re-read on scroll/resize. */
	function badgeRect(el: Element, tick: number): DOMRect {
		void tick;
		return el.getBoundingClientRect();
	}

	let layoutRafId: number | null = null;
	function bumpLayout(): void {
		if (annotationViews.length === 0 || layoutRafId !== null) return;
		layoutRafId = requestAnimationFrame(() => {
			layoutRafId = null;
			layoutTick++;
		});
	}

	/** Annotation editor position: next to the cursor, kept inside the viewport. */
	function annotationOverlayPos(): { x: number; y: number } {
		const x = Math.max(8, Math.min(hoverPosition.x, window.innerWidth - 340));
		const y = Math.max(8, Math.min(hoverPosition.y + 30, window.innerHeight - 220));
		return { x, y };
	}

	function isEditableTarget(target: EventTarget | null): boolean {
		const el = target as HTMLElement | null;
		if (!el || typeof el.tagName !== 'string') return false;
		return el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName);
	}

	function handleClick(event: MouseEvent) {
		// Close context menu on any click
		if (contextMenuVisible) {
			contextMenuVisible = false;
			return;
		}

		if (!checkModifier(event)) return;
		// Another tool's trigger (e.g. Alt+Ctrl+Click in SvelteDevKit): hands off.
		if (isReservedClick(event)) return;

		event.preventDefault();
		event.stopPropagation();

		// Second click of a Modifier+DoubleClick belongs to the PropsTracer
		// (SvelteDevKit). Still swallowed: it must not reach the popup backdrop
		// the first click opened, or the backdrop would close (and detach) before
		// the `dblclick` it is the target of could bubble to the tracer.
		if (yieldDoubleClick && event.detail >= 2) return;

		const target = event.target as HTMLElement;

		// Find the actual element with Svelte metadata
		const elementWithMeta = findMetaElement(target);

		if (!elementWithMeta) {
			const tag = target.tagName?.toLowerCase() || 'unknown';
			console.log(
				`[SvelteGrab] No Svelte component found for <${tag}>. This element may be plain HTML, rendered by a third-party library, or outside Svelte's component tree. Try clicking a parent element.`
			);
			return;
		}

		// Plugin hook
		pluginRegistry.executeHook(
			'onElementGrab',
			elementWithMeta,
			getComponentStack(elementWithMeta)
		);

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
			const tag = elementWithMeta.tagName?.toLowerCase() || 'unknown';
			console.log(
				`[SvelteGrab] No component stack found for <${tag}>. The element has Svelte metadata but no file location. Try clicking a parent element.`
			);
			return;
		}

		// Add to history
		addToHistory(stack, elementWithMeta);

		// Debug: log raw paths
		console.log(
			'[SvelteGrab] Raw paths:',
			stack.map((e) => e.file)
		);

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
		exitSelectionMode();
		document.body.style.cursor = '';
		hoveredElement = null;
		hoveredInfo = null;

		if (showPopup) {
			visible = true;
		} else {
			console.log('[SvelteGrab] Component stack copied:\n' + formatForAgent(stack, grabbedElement));
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			if (showHelpOverlay) {
				showHelpOverlay = false;
				return;
			}
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
			// In prompt mode, escape cancels prompt
			if (promptMode) {
				closePromptOverlay();
				return;
			}
			// In toggle mode, escape deactivates
			if (activationMode === 'toggle' && toggleActive) {
				toggleActive = false;
				exitSelectionMode();
				document.body.style.cursor = '';
				hoveredElement = null;
				hoveredInfo = null;
				return;
			}
		}

		// Open first file in editor when "O" is pressed with popup visible
		if (
			(event.key === 'o' || event.key === 'O') &&
			visible &&
			stack.length > 0 &&
			hotkeyOn('open')
		) {
			event.preventDefault();
			openInEditor(stack[0].file, stack[0].line);
		}

		// Screenshot when "S" is pressed with popup visible
		if (
			(event.key === 's' || event.key === 'S') &&
			visible &&
			grabbedElement &&
			enableScreenshot &&
			hotkeyOn('screenshot')
		) {
			event.preventDefault();
			captureScreenshot(grabbedElement);
		}

		// Tab to open agent prompt (when in selection mode with agent relay)
		if (event.key === 'Tab' && selectionMode && enableAgentRelay && hotkeyOn('relayPrompt')) {
			event.preventDefault();
			showAgentPrompt = true;
		}

		// Enter to open prompt mode (when selection mode active with hovered element)
		if (
			event.key === 'Enter' &&
			selectionMode &&
			hoveredElement &&
			enablePromptMode &&
			!promptMode &&
			hotkeyOn('prompt')
		) {
			event.preventDefault();
			promptMode = true;
		}

		// Alt+? to toggle help overlay
		if (
			(event.key === '?' || event.key === '/') &&
			checkModifier(event) &&
			showPopup &&
			hotkeyOn('help')
		) {
			event.preventDefault();
			showHelpOverlay = !showHelpOverlay;
		}

		if (isModifierKey(event.key)) {
			modifierHeld = true;
		}

		// Activation mode handling
		if (isModifierKey(event.key) && !visible) {
			if (activationMode === 'toggle') {
				if (!toggleKeyHandled) {
					toggleKeyHandled = true;
					toggleActive = !toggleActive;
					if (toggleActive) {
						enterSelectionMode();
						document.body.style.cursor = 'crosshair';
						pluginRegistry.executeHook('onActivate');
					} else {
						exitSelectionMode();
						document.body.style.cursor = '';
						pluginRegistry.executeHook('onDeactivate');
						hoveredElement = null;
						hoveredInfo = null;
					}
				}
			} else {
				// Hold mode
				enterSelectionMode();
				document.body.style.cursor = 'crosshair';
				pluginRegistry.executeHook('onActivate');

				// Show first-time hint toast
				if (!hintShownThisSession && showActiveIndicator) {
					hintShownThisSession = true;
					try {
						sessionStorage.setItem('svelte-grab-hint-shown', '1');
					} catch {
						/* sessionStorage unavailable (private mode / disabled) — non-fatal */
					}
					showHintToast = true;
					setTimeout(() => (showHintToast = false), 3000);
				}
			}
		}

		// N while selecting: annotate the selection (or the hovered element)
		if (
			enableAnnotations &&
			hotkeyOn('annotate') &&
			selectionMode &&
			!promptMode &&
			!event.repeat &&
			isAnnotationKey(event) &&
			!isEditableTarget(event.target)
		) {
			const targets = currentAnnotationTargets();
			if (targets.length > 0) {
				event.preventDefault();
				openAnnotationDraft(targets);
				return;
			}
		}

		// Arrow key navigation in selection mode
		if (selectionMode && enableArrowNav && hoveredElement && hotkeyOn('arrows')) {
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
				const loc = getSvelteLoc(nextEl);
				if (loc) {
					hoveredInfo = {
						file: shortenPath(loc.file),
						line: loc.line
					};
				}
				nextEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
				const rect = nextEl.getBoundingClientRect();
				hoverPosition = { x: rect.right + 10, y: rect.top };
			}
		}

		// Cmd+C / Ctrl+C to copy in selection mode
		if (
			copyOnKeyboard &&
			hotkeyOn('copy') &&
			selectionMode &&
			hoveredElement &&
			(event.metaKey || event.ctrlKey) &&
			event.key === 'c'
		) {
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
			modifierHeld = false;
			if (activationMode === 'toggle') {
				// Just reset the handled flag, don't deactivate
				toggleKeyHandled = false;
			} else if (!promptMode) {
				// Hold mode: deactivate on key release (unless the prompt overlay is open)
				exitSelectionMode();
				document.body.style.cursor = '';
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

	// ============================================================
	// Mousemove throttling (perf): coalesce to one update per frame
	// ============================================================
	let pendingMouseEvent: MouseEvent | null = null;
	let mouseMoveRafId: number | null = null;

	/**
	 * Throttled mousemove entry point. Stores the latest event and schedules a
	 * single rAF so the (potentially heavy) DOM walk / elementsFromPoint hover
	 * logic in processMouseMove runs at most once per animation frame regardless
	 * of how many native mousemove events fire. Behavior is visually identical;
	 * only the update cadence is coalesced.
	 */
	function handleMouseMove(event: MouseEvent) {
		pendingMouseEvent = event;
		if (mouseMoveRafId !== null) return;
		mouseMoveRafId = requestAnimationFrame(() => {
			mouseMoveRafId = null;
			const ev = pendingMouseEvent;
			pendingMouseEvent = null;
			if (ev) processMouseMove(ev);
		});
	}

	function processMouseMove(event: MouseEvent) {
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
				if (hasSvelteLoc(el)) {
					hoveredElement = el as HTMLElement;
					break;
				}
			}
			return;
		}

		if (!selectionMode) return;

		// Freeze hover tracking while the prompt overlay is open, so the overlay
		// doesn't chase the cursor away from its own buttons and the grabbed
		// element can't change out from under the typed instruction.
		if (promptMode) return;

		const target = event.target as HTMLElement;

		// Find the closest element with Svelte meta.loc
		const current = findMetaElement(target);
		const loc = getSvelteLoc(current);
		if (current && loc) {
			if (hoveredElement !== current) {
				hoveredElement = current;
				hoveredInfo = {
					file: shortenPath(loc.file),
					line: loc.line
				};
				pluginRegistry.executeHook('onElementHover', current);
			}
			hoverPosition = { x: event.clientX, y: event.clientY };
			return;
		}

		// No svelte element found
		hoveredElement = null;
		hoveredInfo = null;
	}

	/**
	 * Handle context menu (right-click) in selection mode
	 */
	function handleContextMenu(event: MouseEvent) {
		if (!selectionMode || !showContextMenu || !hoveredElement || !hotkeyOn('contextMenu')) return;
		// macOS turns Ctrl+Click into a right-click: with Ctrl reserved, that
		// click is StyleGrab's, not a request for this menu. Same for the A11y
		// element audit's Alt+Shift+RightClick in SvelteDevKit.
		if (isReservedContextMenu(event)) return;

		event.preventDefault();
		event.stopPropagation();

		const meta = getSvelteMeta(hoveredElement);
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
		contextMenuActions = allActions.filter((a) => !a.isVisible || a.isVisible(ctx));

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
		// Nor on another tool's modified click (see reservedModifiers)
		if (isReservedClick(event)) return;

		// Don't start drag on our own UI elements
		if ((event.target as HTMLElement).closest('[class*="svelte-grab-"], [class*="sg-"]')) return;

		isDragging = true;
		dragStart = { x: event.clientX, y: event.clientY };
		dragCurrent = { x: event.clientX, y: event.clientY };
	}

	/**
	 * Handle mouse up for drag selection
	 */
	function handleMouseUp() {
		if (toolbarDragging) {
			toolbarDragging = false;
			return;
		}

		if (!isDragging) return;

		isDragging = false;

		// Only select if drag was significant (not just a click)
		if (selectionBox.width < 5 && selectionBox.height < 5) return;

		// Use improved point-sampling drag selection
		const dragRect = {
			x: selectionBox.left,
			y: selectionBox.top,
			width: selectionBox.width,
			height: selectionBox.height
		};
		const elements = getElementsInDragRect(dragRect, hasSvelteLoc);
		for (const el of elements) {
			selectedElementsSet.add(el as HTMLElement);
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

		const content =
			selectedElements.length > 0
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
		const finalCtx =
			transformed && typeof transformed === 'object' ? (transformed as AgentContext) : ctx;

		agentClient.sendRequest(agentId, {
			content: finalCtx.content,
			prompt: finalCtx.prompt,
			selectedCount: finalCtx.selectedCount
		});

		agentStatus = 'Sending to agent...';
		agentStatusVisible = true;
		lastAgentStatus = 'pending';
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
	 * Resolve the MCP server port, then connect the SSE status stream and the
	 * in-page agent runtime (ui_snapshot / ui_find). Both carry `mcpToken` the
	 * way the server's checkAccess reads it (`?token=` / x-svelte-grab-token).
	 */
	async function connectMcp(): Promise<void> {
		const port = await resolveMcpPort(mcpPort);
		if (destroyed) return;
		mcpBaseUrl = `http://localhost:${port}`;

		try {
			mcpEventSource = new EventSource(withToken(`${mcpBaseUrl}/events`, mcpToken));
			mcpEventSource.addEventListener('agent-status', (e) => {
				const data = JSON.parse(e.data);
				if (data.status === 'watching') {
					mcpAgentListening = true;
					mcpStatus = 'watching';
				} else if (data.status === 'processing') {
					mcpStatus = 'processing';
				} else {
					mcpAgentListening = false;
					mcpStatus = 'idle';
				}
			});
			mcpEventSource.addEventListener('context-received', (e) => {
				const data = JSON.parse(e.data);
				if (data.agentWatching) {
					mcpStatus = 'processing';
				}
			});
			mcpEventSource.onerror = () => {
				mcpAgentListening = false;
				mcpStatus = 'idle';
			};
		} catch {
			// SSE not available, proceed without real-time status
		}

		// Answer agent queries (ui_snapshot / ui_find) relayed by the MCP server
		if (enableAgentRuntime) {
			agentRuntime = startAgentRuntime({
				serverUrl: mcpBaseUrl,
				token: mcpToken,
				forceEnable
			});
		}
		// The runtime (if it started) now retains the network capture.
		releaseEarlyNetworkCapture();
	}

	let destroyed = false;
	let mountTimeoutId: ReturnType<typeof setTimeout>;

	/**
	 * Svelte action: stamp third-party session-replay redaction markers onto a
	 * dev-UI root element when it mounts, so the dev overlay (which can show file
	 * paths, HTML and prop values) never leaks into tools like PostHog/rrweb,
	 * Sentry, FullStory, Datadog, LogRocket, Hotjar, Clarity, Heap or Smartlook.
	 *
	 * Applied via `use:redactNode` to each top-level overlay/popup/toolbar root.
	 * Idempotent and purely additive — it adds attributes/classes and changes no
	 * existing behavior.
	 */
	function redactNode(node: HTMLElement) {
		hideFromThirdParties(node);
	}

	onMount(() => {
		// Check if hint was already shown this session
		try {
			hintShownThisSession = sessionStorage.getItem('svelte-grab-hint-shown') === '1';
		} catch {
			/* sessionStorage unavailable (private mode / disabled) — non-fatal */
		}

		// Load persistent history
		if (enableHistoryPersistence) {
			try {
				const persistedHistory = loadHistory();
				for (const entry of persistedHistory) {
					history = [
						...history,
						{
							timestamp: entry.timestamp,
							stack: entry.stack,
							htmlPreview: entry.htmlPreview,
							componentName: entry.componentName
						}
					];
				}
			} catch {
				/* persisted history unreadable/corrupt — start with empty history */
			}
		}

		mountTimeoutId = setTimeout(() => {
			if (destroyed) return;
			isDev = detectDevMode(forceEnable);

			if (!isDev) {
				releaseEarlyNetworkCapture();
				console.log(
					'[SvelteGrab] Disabled - no Svelte dev metadata found.\n' +
						'  Possible causes:\n' +
						'  - Production build (Svelte strips __svelte_meta in prod)\n' +
						'  - Svelte 4 or earlier (requires Svelte 5+)\n' +
						'  - SSR-only render (dev metadata is client-side only)\n' +
						'  Use forceEnable={true} to override detection.'
				);
				return;
			}

			console.log(
				`[SvelteGrab] Active! Use ${modifier.charAt(0).toUpperCase() + modifier.slice(1)}+Click to grab component info`
			);

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
				enterSelectionMode();
				document.body.style.cursor = 'crosshair';
				pluginRegistry.executeHook('onActivate');
			};
			callbacks.deactivate = () => {
				if (activationMode === 'toggle') {
					toggleActive = false;
				}
				exitSelectionMode();
				document.body.style.cursor = '';
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

			// MCP server: find its port (it may have fallen back), then open the
			// status stream and the agent runtime there.
			if (enableMcp) void connectMcp();
			else releaseEarlyNetworkCapture();

			// Connect agent relay if enabled
			if (enableAgentRelay) {
				agentClient = new AgentClient();
				agentClient.onStatus = (msg) => {
					agentStatus = msg;
					agentStatusVisible = true;
					lastAgentStatus = 'pending';
				};
				agentClient.onDone = (result) => {
					agentStatus = 'Agent done!';
					lastAgentStatus = 'done';
					agentStatusVisible = true;
					agentHistory = agentClient!.getHistory();
					pluginRegistry.executeHook('afterAgentResponse', result);
					console.log('[SvelteGrab] Agent response:', result);
				};
				agentClient.onError = (err) => {
					agentStatus = `Agent error: ${err}`;
					lastAgentStatus = 'error';
					agentStatusVisible = true;
					agentHistory = agentClient!.getHistory();
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
			window.addEventListener('scroll', bumpLayout, true);
			window.addEventListener('resize', bumpLayout);

			// Pending annotations survive a remount (the store is per page load).
			const unsubscribeAnnotations = annotationStore.subscribe(syncAnnotations);
			syncAnnotations();

			cleanup = () => {
				unsubscribeAnnotations();
				window.removeEventListener('scroll', bumpLayout, true);
				window.removeEventListener('resize', bumpLayout);
				if (layoutRafId !== null) {
					cancelAnimationFrame(layoutRafId);
					layoutRafId = null;
				}
				document.removeEventListener('click', handleClick, true);
				document.removeEventListener('keydown', handleKeydown);
				document.removeEventListener('keyup', handleKeyup);
				document.removeEventListener('mousemove', handleMouseMove);
				document.removeEventListener('contextmenu', handleContextMenu, true);
				document.removeEventListener('mousedown', handleMouseDown, true);
				document.removeEventListener('mouseup', handleMouseUp, true);
				// Cancel any pending throttled mousemove frame
				if (mouseMoveRafId !== null) {
					cancelAnimationFrame(mouseMoveRafId);
					mouseMoveRafId = null;
				}
				pendingMouseEvent = null;
			};
		}, 100);
	});

	onDestroy(() => {
		destroyed = true;
		clearTimeout(mountTimeoutId);
		cleanup?.();
		// Belt-and-suspenders: ensure no throttled mousemove frame outlives us
		if (mouseMoveRafId !== null) {
			cancelAnimationFrame(mouseMoveRafId);
			mouseMoveRafId = null;
		}
		pendingMouseEvent = null;
		// Clear any pending copy-feedback badge timeout so it can't outlive us.
		copyFb.reset();
		agentClient?.disconnect();
		mcpEventSource?.close();
		agentRuntime?.stop();
		agentRuntime = null;
		releaseEarlyNetworkCapture();
		pluginRegistry.clear();
		destroyGlobalAPI();
	});
</script>

<!-- Active indicator badge -->
{#if isDev && showActiveIndicator && !visible && !selectionMode}
	<div
		use:redactNode
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
			use:redactNode
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
			{#if enableAnnotations && annotationViews.length < MAX_ANNOTATIONS}
				<button
					class="svelte-grab-floating-btn"
					onclick={(e) => {
						const r = e.currentTarget.getBoundingClientRect();
						hoverPosition = { x: r.left, y: r.top - 200 };
						openAnnotationDraft([...selectedElements]);
					}}
					title="Annotate the selected elements ({ANNOTATION_KEY_LABEL} while selecting)"
				>
					Annotate
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

<!-- Annotation mode: numbered badges on annotated elements + the tray -->
{#if isDev && enableAnnotations && annotationViews.length > 0}
	{#each annotationViews as view (view.annotation.id)}
		{#each view.targets as target, i (i)}
			{#if target.isConnected}
				{@const rect = badgeRect(target, layoutTick)}
				<div
					use:redactNode
					class="sg-ann-outline"
					data-annotation-badge={view.annotation.id}
					style="
						top: {rect.top}px;
						left: {rect.left}px;
						width: {rect.width}px;
						height: {rect.height}px;
						z-index: {Z_INDEX.floating};
						--sg-accent: {colors.accent};
					"
					aria-hidden="true"
				>
					<span class="sg-ann-badge">{view.annotation.id}</span>
				</div>
			{/if}
		{/each}
	{/each}

	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		use:redactNode
		class="sg-ann-tray"
		style="
			--sg-bg: {colors.background};
			--sg-border: {colors.border};
			--sg-text: {colors.text};
			--sg-accent: {colors.accent};
			--sg-ann-radius: {RADIUS.md}px;
			--sg-ann-font: {FONT_FAMILY_MONO};
			z-index: {Z_INDEX.floating};
		"
		role="region"
		aria-label="SvelteGrab annotations"
		onkeydown={(e) => e.stopPropagation()}
	>
		<div class="sg-ann-header">
			<span class="sg-ann-title">Annotations ({annotationViews.length})</span>
			{#if annotationsSent}
				<span class="sg-ann-sent" aria-live="polite"
					>{enableMcp ? 'Sent and copied' : 'Copied'}</span
				>
			{/if}
			<button
				class="sg-ann-icon-btn"
				onclick={() => (annotationTrayCollapsed = !annotationTrayCollapsed)}
				aria-expanded={!annotationTrayCollapsed}
				aria-label={annotationTrayCollapsed ? 'Expand annotations' : 'Collapse annotations'}
				>{annotationTrayCollapsed ? '▴' : '▾'}</button
			>
		</div>
		{#if !annotationTrayCollapsed}
			<ol class="sg-ann-list">
				{#each annotationViews as view (view.annotation.id)}
					{@const id = view.annotation.id}
					<li class="sg-ann-item" data-annotation-id={id}>
						<div class="sg-ann-item-head">
							<span class="sg-ann-num">#{id}</span>
							<span class="sg-ann-where">{annotationSummary(view.annotation)}</span>
							<button
								class="sg-ann-icon-btn"
								onclick={() => annotationStore.remove(id)}
								aria-label="Delete annotation #{id}"
								title="Delete annotation #{id}">&times;</button
							>
						</div>
						<textarea
							class="sg-ann-comment"
							rows="2"
							value={view.annotation.comment}
							placeholder="Comment"
							aria-label="Comment for annotation #{id}"
							onchange={(e) => annotationStore.update(id, e.currentTarget.value)}
						></textarea>
					</li>
				{/each}
			</ol>
			<input
				class="sg-ann-instruction"
				type="text"
				value={annotationInstruction}
				placeholder="Instruction for all (optional)"
				aria-label="Instruction for all annotations"
				oninput={(e) => {
					annotationInstruction = e.currentTarget.value;
					annotationStore.setInstruction(annotationInstruction);
				}}
			/>
		{/if}
		<div class="sg-ann-footer">
			<DevToolButton
				onclick={sendAllAnnotations}
				title={enableMcp
					? 'Copy all annotations and send them to the MCP server'
					: 'Copy all annotations for your agent'}>Send all</DevToolButton
			>
			<DevToolButton
				block={false}
				onclick={() => annotationStore.clear()}
				title="Delete every annotation">Clear all</DevToolButton
			>
		</div>
	</div>
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
			use:redactNode
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
	<div
		use:redactNode
		class="sg-context-overlay"
		onclick={() => (contextMenuVisible = false)}
		role="presentation"
	>
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
						disabled={action.isEnabled && contextMenuContext
							? !action.isEnabled(contextMenuContext)
							: false}
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
		use:redactNode
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
					exitSelectionMode();
					document.body.style.cursor = '';
					if (activationMode === 'toggle') toggleActive = false;
					hoveredElement = null;
					hoveredInfo = null;
				} else {
					enterSelectionMode();
					document.body.style.cursor = 'crosshair';
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
			{#if agentHistory.length > 0}
				<button
					class="sg-toolbar-btn"
					onclick={() => {
						showAgentPrompt = true;
						showAgentHistory = true;
					}}
					title="Agent history ({agentHistory.length})"
				>
					Sessions ({agentHistory.length})
				</button>
			{/if}
			<span class="sg-toolbar-relay" class:sg-toolbar-relay-on={agentConnected}>
				{agentConnected ? 'Relay ON' : 'Relay OFF'}
			</span>
		{/if}
	</div>
{/if}

<!-- Agent prompt -->
{#if isDev && promptMode && (hoveredElement || (promptPurpose === 'annotate' && annotationTargets.length > 0))}
	{@const annotating = promptPurpose === 'annotate'}
	{@const annotatePos = annotating ? annotationOverlayPos() : null}
	<div
		use:redactNode
		class="sg-prompt-overlay"
		style="
			--sg-bg: {colors.background};
			--sg-border: {colors.border};
			--sg-text: {colors.text};
			--sg-accent: {colors.accent};
			position: fixed;
			left: {annotatePos ? annotatePos.x : hoverPosition.x}px;
			top: {annotatePos ? annotatePos.y : hoverPosition.y + 30}px;
			z-index: 2147483647;
		"
	>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="sg-prompt-container" onkeydown={(e) => e.stopPropagation()}>
			{#if enableMcp && !annotating}
				<div
					style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 10px;"
				>
					<span
						style="
						width: 6px; height: 6px; border-radius: 50%;
						background: {mcpAgentListening ? '#22c55e' : '#ef4444'};
						display: inline-block;
					"
					></span>
					<span style="color: var(--sg-text); opacity: 0.7;">
						{#if mcpStatus === 'watching'}
							Claude Code listening
						{:else if mcpStatus === 'processing'}
							Processing...
						{:else if mcpStatus === 'sent'}
							Sent!
						{:else}
							No agent connected
						{/if}
					</span>
				</div>
			{/if}
			<div
				class="sg-prompt-header"
				style="color: var(--sg-text); font-size: 11px; margin-bottom: 4px; opacity: 0.7;"
			>
				{#if annotating}
					Annotation #{annotationNextId} ({annotationTargets.length} element{annotationTargets.length ===
					1
						? ''
						: 's'}): Enter to add, Esc to cancel
				{:else if enableMcp && mcpAgentListening}
					Describe what to change (Cmd+Enter to send)
				{:else}
					Add context (Cmd+Enter to copy, Esc to cancel)
				{/if}
			</div>
			<!-- svelte-ignore a11y_autofocus -->
			<textarea
				class="sg-prompt-input"
				bind:value={promptText}
				placeholder={annotating
					? 'What should change here?'
					: enableMcp && mcpAgentListening
						? 'e.g. "Make this button bigger and change the color to blue"'
						: 'Add context or instructions...'}
				aria-label={annotating ? `Comment for new annotation #${annotationNextId}` : undefined}
				autofocus
				onkeydown={(e) => {
					if (e.key === 'Escape') {
						e.preventDefault();
						closePromptOverlay();
					}
					if (annotating && e.key === 'Enter' && !e.shiftKey) {
						e.preventDefault();
						saveAnnotation(annotationTargets);
						return;
					}
					if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						confirmPrompt();
					}
				}}
				style="
					background: var(--sg-bg);
					color: var(--sg-text);
					border: 1px solid {enableMcp && mcpAgentListening && !annotating ? '#22c55e' : 'var(--sg-border)'};
					border-radius: 6px;
					padding: 8px;
					width: 300px;
					min-height: 60px;
					resize: vertical;
					font-family: system-ui, sans-serif;
					font-size: 12px;
					outline: none;
				"
			></textarea>
			<div style="display: flex; gap: 6px; margin-top: 6px;">
				{#if annotating}
					<button class="sg-ann-primary-btn" onclick={() => saveAnnotation(annotationTargets)}
						>Add annotation #{annotationNextId}</button
					>
					<button class="sg-ann-secondary-btn" onclick={() => closePromptOverlay()}>Cancel</button>
				{:else if enableMcp && mcpAgentListening}
					<button
						onclick={() => confirmPrompt()}
						style="
							background: #22c55e;
							color: white;
							border: none;
							border-radius: 4px;
							padding: 4px 12px;
							font-size: 11px;
							cursor: pointer;
							font-weight: 500;
						">Send to Claude Code</button
					>
				{:else if enableMcp}
					<button
						onclick={() => confirmPrompt()}
						style="
							background: var(--sg-accent);
							color: white;
							border: none;
							border-radius: 4px;
							padding: 4px 12px;
							font-size: 11px;
							cursor: pointer;
							opacity: 0.7;
						"
						title="Context will be queued — start Claude Code with watch_for_grab to receive it"
						>Send (queued)</button
					>
				{:else}
					<button
						onclick={() => confirmPrompt()}
						style="
							background: var(--sg-accent);
							color: white;
							border: none;
							border-radius: 4px;
							padding: 4px 12px;
							font-size: 11px;
							cursor: pointer;
						">Copy with Context</button
					>
				{/if}
				{#if enableAgentRelay}
					<button
						onclick={() => {
							if (agentClient) {
								const element = hoveredElement || grabbedElement;
								if (element) {
									const elementStack = getComponentStack(element);
									const formatted = formatForAgent(elementStack, element);
									agentClient.sendRequest(agentId, {
										content: [formatted],
										prompt: promptText,
										selectedCount: selectedElements.length || 1
									});
								}
							}
							promptMode = false;
							promptText = '';
						}}
						style="
							background: transparent;
							color: var(--sg-accent);
							border: 1px solid var(--sg-accent);
							border-radius: 4px;
							padding: 4px 12px;
							font-size: 11px;
							cursor: pointer;
						">Send via Relay</button
					>
				{/if}
				{#if !annotating && enableAnnotations && annotationViews.length < MAX_ANNOTATIONS}
					<button
						class="sg-ann-secondary-btn"
						onclick={() => saveAnnotation(currentAnnotationTargets(true))}
						title="Keep this as annotation #{annotationNextId} and send several together later"
						>Add annotation</button
					>
				{/if}
			</div>
		</div>
	</div>
{/if}

{#if isDev && showAgentPrompt}
	<div
		use:redactNode
		class="sg-agent-overlay"
		onclick={() => (showAgentPrompt = false)}
		role="presentation"
	>
		<div
			class="sg-agent-prompt"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
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
				<span>Send to Agent ({selectedElements.length || (hoveredElement ? 1 : 0)} elements)</span>
				{#if agentHistory.length > 0}
					<button
						class="sg-agent-history-toggle"
						onclick={() => (showAgentHistory = !showAgentHistory)}
						title="Session history ({agentHistory.length})"
					>
						History ({agentHistory.length})
					</button>
				{/if}
			</div>
			{#if agentHistory.length > 0 && !showAgentHistory}
				<button
					class="sg-agent-resume-link"
					onclick={() => {
						const lastEntry = agentHistory[agentHistory.length - 1];
						if (lastEntry) {
							agentPromptText = '';
							// Use resume instead of new request
						}
					}}
				>
					Resume last session
				</button>
			{/if}
			{#if showAgentHistory}
				<div class="sg-agent-history-panel">
					{#each agentHistory as entry (entry.timestamp)}
						<div class="sg-agent-history-entry">
							<div class="sg-agent-history-entry-header">
								<span class="sg-agent-history-entry-time"
									>{new Date(entry.timestamp).toLocaleTimeString()}</span
								>
								{#if entry.result}
									<span class="sg-agent-history-entry-status sg-agent-history-done">done</span>
								{:else if entry.error}
									<span class="sg-agent-history-entry-status sg-agent-history-error">error</span>
								{/if}
							</div>
							<div class="sg-agent-history-entry-prompt">{entry.prompt}</div>
							{#if entry.result}
								<div class="sg-agent-history-entry-result">
									{entry.result.slice(0, 200)}{entry.result.length > 200 ? '...' : ''}
								</div>
							{/if}
							{#if entry.error}
								<div class="sg-agent-history-entry-error">{entry.error}</div>
							{/if}
							<button
								class="sg-agent-history-resume-btn"
								onclick={() => {
									showAgentHistory = false;
									agentClient?.resume(agentPromptText || 'Continue from where you left off');
									agentStatus = 'Resuming session...';
									agentStatusVisible = true;
									lastAgentStatus = 'pending';
									showAgentPrompt = false;
								}}>Resume</button
							>
						</div>
					{/each}
				</div>
			{:else}
				<textarea
					class="sg-agent-textarea"
					bind:value={agentPromptText}
					placeholder="Describe what you want the agent to do..."
					onkeydown={handleAgentKeydown}
				></textarea>
			{/if}
			<div class="sg-agent-footer">
				<span class="sg-agent-hint"
					>{showAgentHistory ? 'Click Resume on an entry' : 'Cmd+Enter to send'}</span
				>
				{#if !showAgentHistory}
					{#if agentHistory.length > 0}
						<button
							class="sg-agent-resume-btn"
							onclick={() => {
								if (agentPromptText.trim()) {
									agentClient?.resume(agentPromptText);
									agentStatus = 'Resuming...';
									agentStatusVisible = true;
									lastAgentStatus = 'pending';
									showAgentPrompt = false;
									agentPromptText = '';
								}
							}}>Resume</button
						>
					{/if}
					<button class="sg-agent-send" onclick={submitAgentRequest}>Send</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<!-- Agent status toast -->
{#if isDev && agentStatusVisible}
	<div
		use:redactNode
		class="sg-agent-status"
		style="
			--sg-bg: {colors.background};
			--sg-border: {colors.border};
			--sg-text: {colors.text};
			--sg-accent: {colors.accent};
		"
	>
		<span class="sg-agent-status-text">{agentStatus}</span>
		<div class="sg-agent-status-actions">
			{#if lastAgentStatus === 'done'}
				<button
					class="sg-agent-status-btn"
					onclick={() => {
						agentClient?.undo();
						agentStatus = 'Undoing...';
						lastAgentStatus = 'pending';
					}}>Undo</button
				>
				<button
					class="sg-agent-status-btn"
					onclick={() => {
						showAgentPrompt = true;
						agentStatusVisible = false;
					}}>Resume</button
				>
			{/if}
			{#if lastAgentStatus === 'error'}
				<button
					class="sg-agent-status-btn"
					onclick={() => {
						agentClient?.retry();
						agentStatus = 'Retrying...';
						lastAgentStatus = 'pending';
					}}>Retry</button
				>
			{/if}
			<button
				class="sg-agent-status-btn sg-agent-status-btn-dim"
				onclick={() => {
					agentStatusVisible = false;
					lastAgentStatus = 'idle';
				}}>Dismiss</button
			>
		</div>
	</div>
{/if}

{#if isDev && showPopup && visible}
	<div
		use:redactNode
		class="svelte-grab-overlay"
		style="--sg-overlay-z: {Z_INDEX.overlay};"
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
				--sg-popup-radius: {RADIUS.md}px;
				--sg-popup-font-family: {FONT_FAMILY_MONO};
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
				{#if copyFailed}
					<span class="svelte-grab-copy-failed" aria-live="polite">Copy failed</span>
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
				<button class="svelte-grab-close" onclick={() => (visible = false)} aria-label="Close"
					>&times;</button
				>
			</div>

			<div class="svelte-grab-content">
				{#if stack.length > 0}
					{@const definedIn = stack[0]}
					{@const usedIn = stack.find((e) => e.file !== definedIn.file)}

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
					<button class="svelte-grab-btn svelte-grab-btn-small" onclick={clearSelection}>
						Clear
					</button>
				</div>
			{/if}

			<div class="svelte-grab-footer">
				<DevToolButton onclick={() => copyToClipboard(formatForAgent(stack, grabbedElement))}
					>Copy for Agent</DevToolButton
				>
				<DevToolButton onclick={() => copyToClipboard(formatPaths(stack))}>Copy Paths</DevToolButton
				>
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
						<button class="svelte-grab-btn svelte-grab-btn-small" onclick={clearHistory}>
							Clear
						</button>
					</div>
					<div class="svelte-grab-history-list">
						{#each history as entry (entry.timestamp)}
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

<!-- First-time hint toast -->
{#if isDev && showHintToast}
	<div
		use:redactNode
		class="sg-hint-toast"
		style="--sg-bg: {colors.background}; --sg-text: {colors.text}; --sg-accent: {colors.accent};"
		role="status"
		aria-live="polite"
	>
		{modifier.charAt(0).toUpperCase() + modifier.slice(1)}+Click to grab component info | {modifier
			.charAt(0)
			.toUpperCase() + modifier.slice(1)}+? for help
	</div>
{/if}

<!-- Help overlay for standalone SvelteGrab -->
{#if isDev && showHelpOverlay}
	<div
		use:redactNode
		class="sg-help-overlay"
		style="--sg-overlay-z: {Z_INDEX.overlay};"
		onclick={() => (showHelpOverlay = false)}
		onkeydown={(e) => e.key === 'Escape' && (showHelpOverlay = false)}
		role="presentation"
	>
		<div
			class="sg-help-popup"
			style="
				--sg-bg: {colors.background};
				--sg-border: {colors.border};
				--sg-text: {colors.text};
				--sg-accent: {colors.accent};
			"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			aria-label="SvelteGrab Keyboard Shortcuts"
			tabindex="-1"
		>
			<div class="sg-help-header">
				<span class="sg-help-title">SvelteGrab Shortcuts</span>
				<button class="sg-help-close" onclick={() => (showHelpOverlay = false)} aria-label="Close"
					>&times;</button
				>
			</div>
			<div class="sg-help-content">
				<table class="sg-help-table">
					<thead
						><tr><th class="sg-help-th">Shortcut</th><th class="sg-help-th">Action</th></tr></thead
					>
					<tbody>
						<tr
							><td class="sg-help-keys"
								><kbd>{modifier.charAt(0).toUpperCase() + modifier.slice(1)}+Click</kbd></td
							><td class="sg-help-desc">Grab component stack</td></tr
						>
						<tr
							><td class="sg-help-keys"><kbd>Cmd/Ctrl+C</kbd></td><td class="sg-help-desc"
								>Copy hovered element (selection mode)</td
							></tr
						>
						<tr
							><td class="sg-help-keys"><kbd>Arrow keys</kbd></td><td class="sg-help-desc"
								>Navigate component tree (selection mode)</td
							></tr
						>
						<tr
							><td class="sg-help-keys"><kbd>O</kbd></td><td class="sg-help-desc"
								>Open in editor (popup visible)</td
							></tr
						>
						<tr
							><td class="sg-help-keys"><kbd>S</kbd></td><td class="sg-help-desc"
								>Screenshot element (popup visible)</td
							></tr
						>
						{#if enableAgentRelay}<tr
								><td class="sg-help-keys"><kbd>Tab</kbd></td><td class="sg-help-desc"
									>Open agent prompt (selection mode)</td
								></tr
							>{/if}
						{#if enableAnnotations}<tr
								><td class="sg-help-keys"><kbd>{ANNOTATION_KEY_LABEL}</kbd></td><td
									class="sg-help-desc">Annotate hovered element or selection (selection mode)</td
								></tr
							>{/if}
						<tr
							><td class="sg-help-keys"><kbd>Escape</kbd></td><td class="sg-help-desc"
								>Close popup / exit selection mode</td
							></tr
						>
					</tbody>
				</table>
			</div>
			<div class="sg-help-footer">
				Press {modifier.charAt(0).toUpperCase() + modifier.slice(1)}+? to close
			</div>
		</div>
	</div>
{/if}

<style>
	/* Annotation mode: badges on annotated elements */
	.sg-ann-outline {
		position: fixed;
		pointer-events: none;
		border: 2px dashed var(--sg-accent);
		border-radius: 4px;
		box-sizing: border-box;
	}

	.sg-ann-badge {
		position: absolute;
		top: -10px;
		right: -10px;
		min-width: 20px;
		height: 20px;
		padding: 0 5px;
		box-sizing: border-box;
		background: var(--sg-accent);
		color: #fff;
		border-radius: 10px;
		font-size: 11px;
		font-weight: 700;
		line-height: 20px;
		text-align: center;
		font-family: ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
	}

	/* Annotation tray (compact, non-modal: the page stays usable) */
	.sg-ann-tray {
		position: fixed;
		left: 16px;
		bottom: 16px;
		width: 300px;
		max-height: min(60vh, 460px);
		display: flex;
		flex-direction: column;
		background: var(--sg-bg);
		border: 1px solid var(--sg-border);
		border-radius: var(--sg-ann-radius, 8px);
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
		color: var(--sg-text);
		font-family: var(--sg-ann-font, ui-monospace, 'SF Mono', Menlo, Monaco, monospace);
		font-size: 12px;
		overflow: hidden;
	}

	.sg-ann-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border-bottom: 1px solid var(--sg-border);
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
	}

	.sg-ann-title {
		color: var(--sg-accent);
		font-weight: 600;
	}

	.sg-ann-sent {
		color: #4ade80;
		font-size: 11px;
	}

	.sg-ann-icon-btn {
		margin-left: auto;
		background: none;
		border: none;
		color: #888;
		cursor: pointer;
		padding: 2px 6px;
		font-size: 13px;
		border-radius: 4px;
		line-height: 1;
	}

	.sg-ann-icon-btn:hover {
		color: var(--sg-text);
		background: rgba(255, 255, 255, 0.1);
	}

	.sg-ann-list {
		list-style: none;
		margin: 0;
		padding: 6px 10px;
		overflow-y: auto;
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.sg-ann-item-head {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 3px;
	}

	.sg-ann-num {
		color: var(--sg-accent);
		font-weight: 700;
	}

	.sg-ann-where {
		opacity: 0.7;
		font-size: 11px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sg-ann-comment,
	.sg-ann-instruction {
		width: 100%;
		box-sizing: border-box;
		background: var(--sg-bg);
		color: var(--sg-text);
		border: 1px solid var(--sg-border);
		border-radius: 4px;
		padding: 4px 6px;
		font-family: system-ui, sans-serif;
		font-size: 12px;
		outline: none;
	}

	.sg-ann-comment {
		resize: vertical;
	}

	.sg-ann-comment:focus,
	.sg-ann-instruction:focus {
		border-color: var(--sg-accent);
	}

	.sg-ann-instruction {
		margin: 0 10px 6px;
		width: calc(100% - 20px);
	}

	.sg-ann-footer {
		display: flex;
		gap: 8px;
		padding: 6px 10px;
		border-top: 1px solid var(--sg-border);
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
	}

	/* Annotation editor buttons (prompt overlay in annotate mode) */
	.sg-ann-primary-btn,
	.sg-ann-secondary-btn {
		border-radius: 4px;
		padding: 4px 12px;
		font-size: 11px;
		cursor: pointer;
	}

	.sg-ann-primary-btn {
		background: var(--sg-accent);
		color: white;
		border: none;
		font-weight: 500;
	}

	.sg-ann-secondary-btn {
		background: transparent;
		color: var(--sg-accent);
		border: 1px solid var(--sg-accent);
	}

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
		/* Matches the shared FONT_FAMILY_MONO token */
		font-family: ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
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
		z-index: var(--sg-overlay-z, 99999);
		background: rgba(0, 0, 0, 0.3);
	}

	.svelte-grab-popup {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		background: var(--sg-bg);
		border: 1px solid var(--sg-border);
		/* Radius + mono font sourced from the shared RADIUS.md / FONT_FAMILY_MONO tokens */
		border-radius: var(--sg-popup-radius, 8px);
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
		min-width: 320px;
		max-width: 600px;
		max-height: 400px;
		overflow: hidden;
		font-family: var(--sg-popup-font-family, ui-monospace, 'SF Mono', Menlo, Monaco, monospace);
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

	.svelte-grab-copy-failed {
		color: #ef4444;
		font-size: 11px;
		animation: fade-in 0.2s ease;
	}

	@keyframes fade-in {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
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
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.5;
		}
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
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.sg-agent-status-text {
		flex: 1;
	}

	.sg-agent-status-actions {
		display: flex;
		gap: 6px;
	}

	.sg-agent-status-btn {
		padding: 4px 10px;
		background: rgba(255, 255, 255, 0.1);
		border: 1px solid var(--sg-border);
		border-radius: 4px;
		color: var(--sg-text);
		cursor: pointer;
		font-family: inherit;
		font-size: 11px;
		transition: background 0.1s ease;
	}

	.sg-agent-status-btn:hover {
		background: rgba(255, 255, 255, 0.2);
	}

	.sg-agent-status-btn-dim {
		opacity: 0.6;
		border-color: transparent;
	}

	.sg-agent-status-btn-dim:hover {
		opacity: 1;
	}

	/* Agent prompt enhancements */
	.sg-agent-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.sg-agent-history-toggle {
		padding: 3px 8px;
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid var(--sg-border);
		border-radius: 4px;
		color: #888;
		cursor: pointer;
		font-family: inherit;
		font-size: 10px;
		transition: all 0.1s ease;
	}

	.sg-agent-history-toggle:hover {
		color: var(--sg-text);
		background: rgba(255, 255, 255, 0.12);
	}

	.sg-agent-resume-link {
		display: block;
		width: 100%;
		padding: 8px 16px;
		background: rgba(96, 165, 250, 0.08);
		border: none;
		border-bottom: 1px solid var(--sg-border);
		color: #60a5fa;
		cursor: pointer;
		font-family: inherit;
		font-size: 11px;
		text-align: left;
		transition: background 0.1s ease;
	}

	.sg-agent-resume-link:hover {
		background: rgba(96, 165, 250, 0.15);
	}

	.sg-agent-resume-btn {
		padding: 6px 14px;
		background: rgba(96, 165, 250, 0.15);
		border: 1px solid #60a5fa;
		border-radius: 4px;
		color: #60a5fa;
		cursor: pointer;
		font-family: inherit;
		font-size: 12px;
		font-weight: 500;
		transition: all 0.1s ease;
	}

	.sg-agent-resume-btn:hover {
		background: rgba(96, 165, 250, 0.25);
	}

	/* Session history panel */
	.sg-agent-history-panel {
		max-height: 300px;
		overflow-y: auto;
		border-bottom: 1px solid var(--sg-border);
	}

	.sg-agent-history-entry {
		padding: 10px 16px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.05);
	}

	.sg-agent-history-entry:last-child {
		border-bottom: none;
	}

	.sg-agent-history-entry-header {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 4px;
	}

	.sg-agent-history-entry-time {
		font-size: 10px;
		color: #888;
	}

	.sg-agent-history-entry-status {
		font-size: 9px;
		padding: 1px 6px;
		border-radius: 8px;
		font-weight: 600;
		text-transform: uppercase;
	}

	.sg-agent-history-done {
		background: rgba(74, 222, 128, 0.15);
		color: #4ade80;
	}

	.sg-agent-history-error {
		background: rgba(248, 113, 113, 0.15);
		color: #f87171;
	}

	.sg-agent-history-entry-prompt {
		font-size: 12px;
		color: var(--sg-text);
		margin-bottom: 4px;
	}

	.sg-agent-history-entry-result {
		font-size: 11px;
		color: #888;
		padding: 6px 8px;
		background: rgba(255, 255, 255, 0.03);
		border-radius: 4px;
		margin-bottom: 6px;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.sg-agent-history-entry-error {
		font-size: 11px;
		color: #f87171;
		padding: 6px 8px;
		background: rgba(248, 113, 113, 0.08);
		border-radius: 4px;
		margin-bottom: 6px;
	}

	.sg-agent-history-resume-btn {
		padding: 3px 10px;
		background: rgba(96, 165, 250, 0.1);
		border: 1px solid rgba(96, 165, 250, 0.3);
		border-radius: 4px;
		color: #60a5fa;
		cursor: pointer;
		font-family: inherit;
		font-size: 10px;
		transition: all 0.1s ease;
	}

	.sg-agent-history-resume-btn:hover {
		background: rgba(96, 165, 250, 0.2);
	}

	/* Hint toast */
	.sg-hint-toast {
		position: fixed;
		bottom: 20px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 100000;
		background: var(--sg-bg, #1e1e2e);
		color: var(--sg-text, #cdd6f4);
		border: 1px solid var(--sg-accent, #58a6ff);
		border-radius: 8px;
		padding: 8px 16px;
		font-family: ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
		font-size: 12px;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
		animation:
			sg-toast-in 0.2s ease-out,
			sg-toast-out 0.3s ease-in 2.7s forwards;
		pointer-events: none;
	}

	@keyframes sg-toast-in {
		from {
			opacity: 0;
			transform: translateX(-50%) translateY(10px);
		}
		to {
			opacity: 1;
			transform: translateX(-50%) translateY(0);
		}
	}

	@keyframes sg-toast-out {
		from {
			opacity: 1;
		}
		to {
			opacity: 0;
		}
	}

	/* Help overlay */
	.sg-help-overlay {
		position: fixed;
		inset: 0;
		z-index: var(--sg-overlay-z, 99999);
		background: rgba(0, 0, 0, 0.3);
	}

	.sg-help-popup {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		background: var(--sg-bg);
		border: 1px solid var(--sg-border);
		border-radius: 8px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
		min-width: 340px;
		max-width: 500px;
		overflow: hidden;
		font-family: ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
		font-size: 12px;
		color: var(--sg-text);
		display: flex;
		flex-direction: column;
	}

	.sg-help-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 14px;
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
		border-bottom: 1px solid var(--sg-border);
	}

	.sg-help-title {
		color: var(--sg-accent);
		font-weight: 600;
		flex: 1;
	}

	.sg-help-close {
		background: none;
		border: none;
		color: #888;
		cursor: pointer;
		padding: 2px 6px;
		font-size: 14px;
		border-radius: 4px;
	}
	.sg-help-close:hover {
		color: #fff;
		background: rgba(255, 255, 255, 0.1);
	}

	.sg-help-content {
		padding: 8px 14px;
	}

	.sg-help-table {
		width: 100%;
		border-collapse: collapse;
	}
	.sg-help-th {
		text-align: left;
		padding: 4px 0;
		color: #888;
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		border-bottom: 1px solid rgba(255, 255, 255, 0.1);
	}

	.sg-help-keys kbd {
		background: rgba(255, 255, 255, 0.1);
		padding: 2px 6px;
		border-radius: 3px;
		font-size: 11px;
		font-family: inherit;
		border: 1px solid rgba(255, 255, 255, 0.15);
	}
	.sg-help-desc {
		color: #ccc;
		padding: 6px 0 6px 12px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.03);
	}

	.sg-help-footer {
		padding: 8px 14px;
		text-align: center;
		color: #888;
		font-size: 10px;
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
		border-top: 1px solid var(--sg-border);
	}
</style>
