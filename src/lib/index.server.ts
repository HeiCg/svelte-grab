// SSR-safe entry point for Node.js environments.
// When Vite externalizes svelte-grab during SSR, Node.js can't process .svelte files.
// This module provides no-op stubs for all components (dev tools render nothing during SSR)
// and re-exports SSR-safe utilities.

// No-op component stubs — dev tools are client-only
function noop() {}

export const SvelteGrab = noop;
export const SvelteStateGrab = noop;
export const SvelteStyleGrab = noop;
export const SveltePropsTracer = noop;
export const SvelteA11yReporter = noop;
export const SvelteErrorContext = noop;
export const SvelteRenderProfiler = noop;
export const SvelteDevKit = noop;

// inspectable() is a client-only dev registry; on the server it does nothing.
// Same name and call signature as the client export.
export function inspectable(_name: string, _values: Record<string, unknown>): () => void {
	return noop;
}
export function uninspectable(_name: string): void {}

// Core utilities (already SSR-safe)
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
	DevStackEntryType,
	SvelteSourceLocation,
	HotkeysMode,

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
