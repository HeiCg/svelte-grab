// Components
export { default as SvelteGrab } from './SvelteGrab.svelte';
export { default as SvelteStateGrab } from './SvelteStateGrab.svelte';
export { default as SvelteStyleGrab } from './SvelteStyleGrab.svelte';
export { default as SveltePropsTracer } from './SveltePropsTracer.svelte';
export { default as SvelteA11yReporter } from './SvelteA11yReporter.svelte';
export { default as SvelteErrorContext } from './SvelteErrorContext.svelte';
export { default as SvelteRenderProfiler } from './SvelteRenderProfiler.svelte';
export { default as SvelteDevKit } from './SvelteDevKit.svelte';

// Core utilities (for advanced users)
export { PluginRegistry } from './core/plugin-registry.js';
export { createGlobalAPI, destroyGlobalAPI } from './core/global-api.js';

// Types
export type {
	// Core types (SvelteGrab)
	SvelteGrabProps,
	StackEntry,
	HistoryEntry,
	ThemeConfig,
	SvelteMeta,
	DevStackEntry,

	// Plugin system types
	SvelteGrabPlugin,
	PluginHooks,
	ContextMenuAction,
	ActionContext,
	SvelteGrabAPI,
	AgentContext,
	AgentHistoryEntry,
	AgentSession,
	CopyContext,

	// StateGrab types
	SvelteStateGrabProps,
	ComponentStateInfo,

	// StyleGrab types
	SvelteStyleGrabProps,
	StylePropertyInfo,
	StyleSource,
	StyleCategory,
	StyleConflict,
	StyleConflictRule,

	// PropsTracer types
	SveltePropsTracerProps,
	PropTrace,
	PropTraceNode,

	// A11yReporter types
	SvelteA11yReporterProps,
	A11yIssue,
	A11yReport,

	// ErrorContext types
	SvelteErrorContextProps,
	CapturedError,
	ParsedStackFrame,

	// RenderProfiler types
	SvelteRenderProfilerProps,
	RenderEvent,
	ComponentProfile,
	RenderBurst,

	// DevKit types
	SvelteDevKitProps,
	DevKitTool
} from './types.js';
