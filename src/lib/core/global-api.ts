import type { SvelteGrabAPI, SvelteGrabPlugin, StackEntry, HistoryEntry } from '../types.js';

declare global {
	interface Window {
		__SVELTE_GRAB__?: SvelteGrabAPI;
	}
}

/**
 * Callback interface for the SvelteGrab component to wire up API methods.
 */
export interface APICallbacks {
	activate: () => void;
	deactivate: () => void;
	toggle: () => void;
	isActive: () => boolean;
	grab: (element: HTMLElement) => StackEntry[];
	copyElement: (element: HTMLElement, format?: 'agent' | 'paths') => Promise<boolean>;
	registerPlugin: (plugin: SvelteGrabPlugin) => void;
	getHistory: () => HistoryEntry[];
	getSelectedElements: () => HTMLElement[];
	clearSelection: () => void;
}

/**
 * Create the global SvelteGrab API and attach it to window.__SVELTE_GRAB__.
 * Returns a callbacks object that the component wires up in onMount.
 */
export function createGlobalAPI(): { api: SvelteGrabAPI; callbacks: APICallbacks } {
	const callbacks: APICallbacks = {
		activate: () => {},
		deactivate: () => {},
		toggle: () => {},
		isActive: () => false,
		grab: () => [],
		copyElement: async () => false,
		registerPlugin: () => {},
		getHistory: () => [],
		getSelectedElements: () => [],
		clearSelection: () => {}
	};

	const api: SvelteGrabAPI = {
		activate: () => callbacks.activate(),
		deactivate: () => callbacks.deactivate(),
		toggle: () => callbacks.toggle(),
		isActive: () => callbacks.isActive(),
		grab: (el) => callbacks.grab(el),
		copyElement: (el, fmt) => callbacks.copyElement(el, fmt),
		registerPlugin: (plugin) => callbacks.registerPlugin(plugin),
		getHistory: () => callbacks.getHistory(),
		getSelectedElements: () => callbacks.getSelectedElements(),
		clearSelection: () => callbacks.clearSelection()
	};

	if (typeof window !== 'undefined') {
		window.__SVELTE_GRAB__ = api;
	}

	return { api, callbacks };
}

/**
 * Remove global API from window.
 */
export function destroyGlobalAPI(): void {
	if (typeof window !== 'undefined') {
		delete window.__SVELTE_GRAB__;
	}
}
