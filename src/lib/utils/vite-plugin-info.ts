/**
 * Browser side of the optional `svelte-grab/vite` plugin.
 *
 * In dev the plugin injects a tiny client module that sets
 * `window.__SVELTE_GRAB_VITE__ = { version, root, hmrBridge, importersEndpoint, env }`
 * (`env`: Vite's client env, VITE_* values) and forwards Vite HMR events as `svelte-grab:hmr` CustomEvents on `window`.
 *
 * Source of truth for the names: `src/vite/index.ts` (Node build). src/lib
 * cannot import from there, so the values are duplicated;
 * `tests/vite-plugin.test.ts` fails when the two copies drift apart.
 */

/** `window` property the plugin's client module sets. */
export const VITE_PLUGIN_GLOBAL = '__SVELTE_GRAB_VITE__';

/** CustomEvent the plugin's client module dispatches on `window` for each Vite HMR event. */
export const HMR_BRIDGE_EVENT = 'svelte-grab:hmr';

/** Vite's built-in launch-editor middleware (present in every Vite dev server). */
export const OPEN_IN_EDITOR_PATH = '/__open-in-editor';

export interface VitePluginInfo {
	/** svelte-grab version the plugin came from. */
	version: string;
	/** Vite project root (absolute, forward slashes). */
	root: string;
	/** The client forwards HMR events as `svelte-grab:hmr` window events. */
	hmrBridge: boolean;
	/** Path of the module-graph importers endpoint, or `null` when disabled. */
	importersEndpoint: string | null;
}

/**
 * `detail` of a `svelte-grab:hmr` event. `waitUntil` lets a listener hold the
 * Vite client (it awaits listeners) for a short while, e.g. to send a result
 * before a full reload; the client caps the wait.
 */
export interface HmrBridgeDetail {
	type: string;
	payload: unknown;
	waitUntil?: (promise: Promise<unknown>) => void;
}

/** The plugin's marker, or `null` when the plugin is not installed (or SSR). */
export function getVitePluginInfo(): VitePluginInfo | null {
	if (typeof window === 'undefined') return null;
	const raw = (window as unknown as Record<string, unknown>)[VITE_PLUGIN_GLOBAL];
	if (!raw || typeof raw !== 'object') return null;
	const info = raw as Partial<VitePluginInfo>;
	if (typeof info.root !== 'string') return null;
	return {
		version: typeof info.version === 'string' ? info.version : '',
		root: info.root,
		hmrBridge: info.hmrBridge === true,
		importersEndpoint: typeof info.importersEndpoint === 'string' ? info.importersEndpoint : null
	};
}
