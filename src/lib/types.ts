/**
 * Svelte internal metadata attached to elements in dev mode
 */
export interface SvelteMeta {
	loc?: {
		file: string;
		line: number;
		column: number;
	};
	parent?: DevStackEntry;
}

/**
 * Internal stack entry from Svelte's dev metadata
 */
export interface DevStackEntry {
	type?: string;
	file?: string;
	line?: number;
	column?: number;
	parent?: DevStackEntry;
}

/**
 * Processed stack entry with component location info
 */
export interface StackEntry {
	type: string;
	file: string;
	line: number;
	column: number;
}

/**
 * History entry for tracking grabbed elements
 */
export interface HistoryEntry {
	timestamp: number;
	stack: StackEntry[];
	htmlPreview: string;
	componentName: string | null;
}

/**
 * Theme configuration for SvelteGrab UI.
 *
 * Use `lightTheme` to select the base preset (dark or light), then use `theme`
 * to override individual colors on top of the chosen preset.
 *
 * Example: `<SvelteGrab lightTheme theme={{ accent: '#ff6b35' }} />`
 */
export interface ThemeConfig {
	background?: string;
	border?: string;
	text?: string;
	accent?: string;
}

/**
 * Props for the SvelteGrab component
 */
export interface SvelteGrabProps {
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
	editor?: 'vscode' | 'cursor' | 'webstorm' | 'zed' | 'sublime' | 'idea' | 'phpstorm' | 'pycharm' | 'none';
	/** Enable Cmd+C / Ctrl+C to copy in selection mode. Default: true */
	copyOnKeyboard?: boolean;
	/** Enable screenshot capture (requires html-to-image). Default: true */
	enableScreenshot?: boolean;
	/** Enable multi-selection mode. Default: true */
	enableMultiSelect?: boolean;
	/** Project root path for opening files in editor. Required for "Open in editor" to work correctly. */
	projectRoot?: string;
	/** Custom theme colors */
	theme?: ThemeConfig;
	/** Use light theme preset. Default: false */
	lightTheme?: boolean;
	/** Show active indicator badge. Default: true */
	showActiveIndicator?: boolean;
	/** Maximum history entries to keep. Default: 20 */
	maxHistorySize?: number;
	/** Plugins to register. Default: [] */
	plugins?: SvelteGrabPlugin[];
	/** Activation mode: 'hold' requires holding modifier, 'toggle' toggles on modifier press. Default: 'hold' */
	activationMode?: 'hold' | 'toggle';
	/** Show floating toolbar. Default: false */
	showToolbar?: boolean;
	/** Show context menu on right-click in selection mode. Default: true */
	showContextMenu?: boolean;
	/** Enable agent relay WebSocket connection. Default: false */
	enableAgentRelay?: boolean;
	/** WebSocket URL for agent relay. Default: 'ws://localhost:4722' */
	agentRelayUrl?: string;
	/** Agent ID to use for relay requests. Default: 'claude-code' */
	agentId?: string;
	/** Enable arrow key navigation in selection mode. Default: true */
	enableArrowNav?: boolean;
	/** Enable click+drag box selection. Default: true */
	enableDragSelect?: boolean;
	/** Enable auto-send to MCP server on grab. Default: false */
	enableMcp?: boolean;
	/** Port for MCP HTTP server. Default: 4723 */
	mcpPort?: number;
	/** Freeze CSS animations/transitions while selection mode is active. Default: true */
	freezeAnimations?: boolean;
	/** Freeze :hover/:focus pseudo-states while selection mode is active. Default: true */
	freezePseudoStates?: boolean;
	/** Persist grab history to sessionStorage for cross-navigation reacquisition. Default: true */
	enableHistoryPersistence?: boolean;
	/** Enable prompt/input mode (Enter key opens textarea for context). Default: true */
	enablePromptMode?: boolean;
}

// ============================================================
// Svelte-State-Grab Types
// ============================================================

export interface ChildComponentInfo {
	name: string;
	file: string;
	count: number;
}

export interface ComponentStateInfo {
	componentName: string | null;
	file: string;
	line: number;
	props: Record<string, unknown>;
	attributes: Record<string, string>;
	dataAttributes: Record<string, string>;
	boundValues: Record<string, unknown>;
	inspectableState?: Record<string, unknown>;
	childComponentCount: number;
	childComponents: ChildComponentInfo[];
	elementTag: string;
}

export interface StateSnapshot {
	timestamp: number;
	componentName: string | null;
	file: string;
	state: Record<string, unknown>;
}

export interface StateDiff {
	key: string;
	oldValue: unknown;
	newValue: unknown;
}

export interface SvelteStateGrabProps {
	/** Primary modifier key to activate state inspection. Default: 'alt' */
	modifier?: 'alt' | 'ctrl' | 'meta' | 'shift';
	/** Secondary modifier combined with primary (e.g. Alt+Shift+Click). Default: 'shift'. Different from StyleGrab's 'ctrl' to avoid conflicts. */
	secondaryModifier?: 'shift' | 'ctrl' | 'meta';
	/** Force enable even if Svelte dev metadata is not detected. Default: false */
	forceEnable?: boolean;
	/** Show visual popup with state details. Default: true */
	showPopup?: boolean;
	/** Custom theme color overrides, applied on top of the light/dark preset. */
	theme?: ThemeConfig;
	/** Use the light theme preset instead of dark. Default: false */
	lightTheme?: boolean;
	/** Maximum object nesting depth for serialization. Default: 3 */
	maxDepth?: number;
	/** Maximum string length before truncation. Default: 200 */
	maxStringLength?: number;
	/** Maximum number of state snapshots to keep. Default: 5 */
	maxSnapshots?: number;
}

// ============================================================
// Svelte-Style-Grab Types
// ============================================================

export interface StylePropertyInfo {
	name: string;
	value: string;
	source: StyleSource;
	isOverridden: boolean;
}

export interface StyleSource {
	type: 'inline' | 'svelte-scoped' | 'tailwind' | 'stylesheet' | 'user-agent' | 'inherited';
	selector?: string;
	file?: string;
	specificity?: [number, number, number];
}

export interface StyleCategory {
	name: string;
	icon: string;
	properties: StylePropertyInfo[];
}

export interface StyleConflict {
	property: string;
	rules: StyleConflictRule[];
	suggestion?: string;
}

export interface StyleConflictRule {
	selector: string;
	value: string;
	specificity: [number, number, number];
	important: boolean;
	won: boolean;
	source?: string;
}

export interface SvelteStyleGrabProps {
	/** Primary modifier key to activate style inspection. Default: 'alt' */
	modifier?: 'alt' | 'ctrl' | 'meta' | 'shift';
	/** Secondary modifier combined with primary (e.g. Alt+Ctrl+Click). Default: 'ctrl'. Different from StateGrab's 'shift' to avoid conflicts. */
	secondaryModifier?: 'shift' | 'ctrl' | 'meta';
	/** Force enable even if Svelte dev metadata is not detected. Default: false */
	forceEnable?: boolean;
	/** Show visual popup with style analysis. Default: true */
	showPopup?: boolean;
	/** Custom theme color overrides, applied on top of the light/dark preset. */
	theme?: ThemeConfig;
	/** Use the light theme preset instead of dark. Default: false */
	lightTheme?: boolean;
	/** Which CSS categories to display. Default: ['all'] */
	showCategories?: ('box-model' | 'visual' | 'typography' | 'layout' | 'all')[];
}

// ============================================================
// Svelte-Props-Tracer Types
// ============================================================

export interface PropTraceNode {
	file: string;
	line: number;
	column: number;
	componentName: string | null;
	depth: number;
	propsProxy?: Record<string, string>;
}

export interface PropTrace {
	chain: PropTraceNode[];
	elementTag: string;
	elementPreview: string;
}

export interface SveltePropsTracerProps {
	/** Primary modifier key to activate hierarchy tracing. Default: 'alt' */
	modifier?: 'alt' | 'ctrl' | 'meta' | 'shift';
	/** Secondary modifier (unused for PropsTracer, which triggers on DoubleClick). Default: 'shift' */
	secondaryModifier?: 'shift' | 'ctrl' | 'meta';
	/** Force enable even if Svelte dev metadata is not detected. Default: false */
	forceEnable?: boolean;
	/** Show visual popup with the component trace. Default: true */
	showPopup?: boolean;
	/** Custom theme color overrides, applied on top of the light/dark preset. */
	theme?: ThemeConfig;
	/** Use the light theme preset instead of dark. Default: false */
	lightTheme?: boolean;
}

// ============================================================
// Svelte-A11y-Reporter Types
// ============================================================

export interface A11yIssue {
	severity: 'critical' | 'warning' | 'info';
	rule: string;
	message: string;
	elementHtml: string;
	file?: string;
	line?: number;
	fix: string;
	fixCode?: string;
	why?: string;
	element?: HTMLElement;
}

export interface A11yReport {
	critical: A11yIssue[];
	warnings: A11yIssue[];
	passes: string[];
	score: number;
	elementTag: string;
	file?: string;
	line?: number;
}

export interface SvelteA11yReporterProps {
	/** Primary modifier key to activate accessibility audit. Default: 'alt' */
	modifier?: 'alt' | 'ctrl' | 'meta' | 'shift';
	/** Secondary modifier for element-level audit (Alt+RightClick). Default: 'shift' */
	secondaryModifier?: 'shift' | 'ctrl' | 'meta';
	/** Force enable even if Svelte dev metadata is not detected. Default: false */
	forceEnable?: boolean;
	/** Show visual popup with audit results. Default: true */
	showPopup?: boolean;
	/** Custom theme color overrides, applied on top of the light/dark preset. */
	theme?: ThemeConfig;
	/** Use the light theme preset instead of dark. Default: false */
	lightTheme?: boolean;
	/** Also audit child elements within the selected element. Default: true */
	includeSubtree?: boolean;
}

// ============================================================
// Svelte-Error-Context Types
// ============================================================

export interface ParsedStackFrame {
	functionName: string;
	file: string;
	line: number;
	column: number;
}

export interface CapturedError {
	id: string;
	type: 'error' | 'warning' | 'unhandled-rejection';
	message: string;
	timestamp: number;
	count: number;
	stack: ParsedStackFrame[];
	svelteFile?: string;
	svelteLine?: number;
	componentName?: string;
	sourceContext?: { lines: { num: number; text: string; isCurrent: boolean }[] };
}

export interface SvelteErrorContextProps {
	/** Primary modifier key to view captured errors. Default: 'alt' */
	modifier?: 'alt' | 'ctrl' | 'meta' | 'shift';
	/** Secondary modifier (errors use Alt+E shortcut). Default: 'shift' */
	secondaryModifier?: 'shift' | 'ctrl' | 'meta';
	/** Force enable even if Svelte dev metadata is not detected. Default: false */
	forceEnable?: boolean;
	/** Show visual popup with error details. Default: true */
	showPopup?: boolean;
	/** Custom theme color overrides, applied on top of the light/dark preset. */
	theme?: ThemeConfig;
	/** Use the light theme preset instead of dark. Default: false */
	lightTheme?: boolean;
	/** Maximum number of errors to capture and retain. Default: 50 */
	maxErrors?: number;
	/** Time window in minutes after which old errors are discarded. Default: 5 */
	bufferMinutes?: number;
	/** Hide stack frames from node_modules for cleaner traces. Default: true */
	filterNodeModules?: boolean;
}

// ============================================================
// Svelte-Render-Profiler Types
// ============================================================

export interface RenderEvent {
	componentFile: string;
	componentName: string;
	timestamp: number;
	type: 'mutation' | 'attribute' | 'childList' | 'characterData';
	mutationCount: number;
}

export interface ComponentProfile {
	file: string;
	name: string;
	renderCount: number;
	firstRender: number;
	lastRender: number;
	burstCount: number;
	averageInterval: number;
}

export interface RenderBurst {
	componentName: string;
	file: string;
	count: number;
	startTime: number;
	endTime: number;
	duration: number;
}

export interface SvelteRenderProfilerProps {
	/** Primary modifier key to start profiling. Default: 'alt' */
	modifier?: 'alt' | 'ctrl' | 'meta' | 'shift';
	/** Secondary modifier (profiler uses Alt+P shortcut). Default: 'shift' */
	secondaryModifier?: 'shift' | 'ctrl' | 'meta';
	/** Force enable even if Svelte dev metadata is not detected. Default: false */
	forceEnable?: boolean;
	/** Show visual popup with profiling results. Default: true */
	showPopup?: boolean;
	/** Custom theme color overrides, applied on top of the light/dark preset. */
	theme?: ThemeConfig;
	/** Use the light theme preset instead of dark. Default: false */
	lightTheme?: boolean;
	/** Duration of a profiling session in seconds. Default: 10 */
	profileDuration?: number;
	/** Minimum number of renders in a burst window to trigger burst detection. Default: 20 */
	burstThreshold?: number;
	/** Time window in milliseconds for burst detection. Default: 1000 */
	burstWindow?: number;
}

// ============================================================
// SvelteDevKit Types
// ============================================================

export type DevKitTool = 'grab' | 'state' | 'style' | 'props' | 'a11y' | 'errors' | 'profiler';

export interface SvelteDevKitProps {
	modifier?: 'alt' | 'ctrl' | 'meta' | 'shift';
	forceEnable?: boolean;
	theme?: ThemeConfig;
	lightTheme?: boolean;
	enabledTools?: DevKitTool[];
	editor?: 'vscode' | 'cursor' | 'webstorm' | 'zed' | 'sublime' | 'idea' | 'phpstorm' | 'pycharm' | 'none';
	projectRoot?: string;
	/** Plugins to register. Default: [] */
	plugins?: SvelteGrabPlugin[];
	/** Activation mode: 'hold' requires holding modifier, 'toggle' toggles on modifier press. Default: 'hold' */
	activationMode?: 'hold' | 'toggle';
	/** Show floating toolbar. Default: false */
	showToolbar?: boolean;
	/** Show context menu on right-click in selection mode. Default: true */
	showContextMenu?: boolean;
	/** Enable agent relay WebSocket connection. Default: false */
	enableAgentRelay?: boolean;
	/** WebSocket URL for agent relay. Default: 'ws://localhost:4722' */
	agentRelayUrl?: string;
	/** Agent ID to use for relay requests. Default: 'claude-code' */
	agentId?: string;
	/** Enable arrow key navigation in selection mode. Default: true */
	enableArrowNav?: boolean;
	/** Enable click+drag box selection. Default: true */
	enableDragSelect?: boolean;
	/** Enable auto-send to MCP server on grab. Default: false */
	enableMcp?: boolean;
	/** Port for MCP HTTP server. Default: 4723 */
	mcpPort?: number;

	// SvelteGrab props forwarding
	/** Auto-copy format when element is grabbed. Default: 'agent' */
	autoCopyFormat?: 'agent' | 'paths' | 'none';
	/** Show visual popup. Default: true */
	showPopup?: boolean;
	/** Include HTML preview in output. Default: true */
	includeHtml?: boolean;
	/** Enable Cmd+C / Ctrl+C to copy in selection mode. Default: true */
	copyOnKeyboard?: boolean;
	/** Enable screenshot capture (requires html-to-image). Default: true */
	enableScreenshot?: boolean;
	/** Enable multi-selection mode. Default: true */
	enableMultiSelect?: boolean;
	/** Show active indicator badge. Default: true */
	showActiveIndicator?: boolean;
	/** Maximum history entries to keep. Default: 20 */
	maxHistorySize?: number;

	// Sub-tool config props
	/** Secondary modifier for StateGrab. Default: 'shift' */
	stateSecondaryModifier?: 'shift' | 'ctrl' | 'meta';
	/** Secondary modifier for StyleGrab. Default: 'ctrl' */
	styleSecondaryModifier?: 'shift' | 'ctrl' | 'meta';
	/** Maximum number of state snapshots. Default: 5 */
	maxSnapshots?: number;
	/** Profile duration in seconds. Default: 10 */
	profileDuration?: number;
	/** Minimum mutations to trigger burst detection. Default: 20 */
	burstThreshold?: number;
	/** Time window for burst detection in ms. Default: 1000 */
	burstWindow?: number;
	/** Maximum errors to capture. Default: 50 */
	maxErrors?: number;
	/** Error buffer time in minutes. Default: 5 */
	bufferMinutes?: number;
	/** Filter node_modules from error stacks. Default: true */
	filterNodeModules?: boolean;
	/** Style categories to show. Default: ['all'] */
	showCategories?: ('box-model' | 'visual' | 'typography' | 'layout' | 'all')[];
	/** Include subtree in a11y analysis. Default: true */
	includeSubtree?: boolean;
	/** Freeze CSS animations/transitions while selection mode is active. Default: true */
	freezeAnimations?: boolean;
	/** Freeze :hover/:focus pseudo-states while selection mode is active. Default: true */
	freezePseudoStates?: boolean;
	/** Persist grab history to sessionStorage. Default: true */
	enableHistoryPersistence?: boolean;
	/** Enable prompt/input mode. Default: true */
	enablePromptMode?: boolean;
}

// ============================================================
// Plugin System Types
// ============================================================

export interface SvelteGrabPlugin {
	/** Unique plugin name */
	name: string;
	/** Plugin version */
	version?: string;
	/** Lifecycle hooks */
	hooks?: PluginHooks;
	/** Context menu actions contributed by this plugin */
	actions?: ContextMenuAction[];
	/** Called when plugin is registered */
	setup?: (api: SvelteGrabAPI) => void;
	/** Called when plugin is unregistered */
	teardown?: () => void;
}

export interface PluginHooks {
	/** Called when SvelteGrab activates */
	onActivate?: () => void;
	/** Called when SvelteGrab deactivates */
	onDeactivate?: () => void;
	/** Called when an element is hovered in selection mode */
	onElementHover?: (element: HTMLElement) => void;
	/** Called when an element is grabbed/clicked */
	onElementGrab?: (element: HTMLElement, stack: StackEntry[]) => void;
	/** Called when elements are selected */
	onSelectionChange?: (elements: HTMLElement[]) => void;
	/** Transform content before copy */
	beforeCopy?: (context: CopyContext) => string | void;
	/** Called after content is copied */
	afterCopy?: (context: CopyContext) => void;
	/** Transform content before sending to agent */
	beforeAgentSend?: (context: AgentContext) => AgentContext | void;
	/** Called after agent response */
	afterAgentResponse?: (response: string) => void;
}

// ============================================================
// Context Menu Types
// ============================================================

export interface ContextMenuAction {
	/** Unique action ID */
	id: string;
	/** Display label */
	label: string;
	/** Icon character/emoji */
	icon?: string;
	/** Keyboard shortcut hint */
	shortcut?: string;
	/** Action handler */
	onAction: (context: ActionContext) => void;
	/** Whether action is visible */
	isVisible?: (context: ActionContext) => boolean;
	/** Whether action is enabled */
	isEnabled?: (context: ActionContext) => boolean;
	/** If true, renders as a divider instead of a button */
	divider?: boolean;
}

export interface ActionContext {
	/** The primary hovered/targeted element */
	element: HTMLElement;
	/** All selected elements */
	selectedElements: HTMLElement[];
	/** Svelte metadata for the element */
	meta: SvelteMeta | null;
	/** Component stack */
	stack: StackEntry[];
}

// ============================================================
// Agent Types
// ============================================================

export interface AgentContext {
	/** Content items to send */
	content: string[];
	/** User prompt text */
	prompt: string;
	/** Number of selected elements */
	selectedCount: number;
}

export interface AgentHistoryEntry {
	/** User prompt text */
	prompt: string;
	/** Content sent with the request */
	content: string[];
	/** Agent result (if completed) */
	result?: string;
	/** Agent error (if failed) */
	error?: string;
	/** Timestamp of the interaction */
	timestamp: number;
}

export interface AgentSession {
	/** Session ID */
	id: string;
	/** Prompts sent in this session */
	prompts: string[];
	/** Results received in this session */
	results: string[];
	/** Errors received in this session */
	errors: string[];
	/** Timestamps for each interaction */
	timestamps: number[];
	/** Current session status */
	status: 'idle' | 'pending' | 'done' | 'error';
}

export interface CopyContext {
	/** Copy format */
	format: 'agent' | 'paths' | 'html';
	/** Elements being copied */
	elements: HTMLElement[];
	/** Formatted content */
	content: string;
}

// ============================================================
// Global API Types
// ============================================================

export interface SvelteGrabAPI {
	/** Activate selection mode */
	activate: () => void;
	/** Deactivate selection mode */
	deactivate: () => void;
	/** Toggle selection mode */
	toggle: () => void;
	/** Check if selection mode is active */
	isActive: () => boolean;
	/** Programmatically grab an element */
	grab: (element: HTMLElement) => StackEntry[];
	/** Copy element info to clipboard */
	copyElement: (element: HTMLElement, format?: 'agent' | 'paths') => Promise<boolean>;
	/** Register a plugin */
	registerPlugin: (plugin: SvelteGrabPlugin) => void;
	/** Get grab history */
	getHistory: () => HistoryEntry[];
	/** Get currently selected elements */
	getSelectedElements: () => HTMLElement[];
	/** Clear current selection */
	clearSelection: () => void;
}
