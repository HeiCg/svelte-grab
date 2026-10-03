/**
 * Reusable dev-tool mount/teardown helper that fixes the within-100ms-unmount
 * listener leak.
 *
 * Every tool delays its setup by ~100ms (to let Svelte hydrate `__svelte_meta`)
 * and only attaches global listeners if dev mode is detected. Most tools do
 * this naively:
 *
 *   onMount(() => {
 *     setTimeout(() => {
 *       isDev = detectDevMode(forceEnable);
 *       if (!isDev) return;
 *       document.addEventListener(...);   // <-- cleanup stored in `cleanup`
 *       cleanup = () => document.removeEventListener(...);
 *     }, 100);
 *   });
 *   onDestroy(() => cleanup?.());
 *
 * If the component unmounts within that 100ms window, the timer still fires
 * AFTER onDestroy ran, so it attaches listeners that are never removed — a leak.
 * Only SvelteGrab guards against this (a `destroyed` flag + `clearTimeout`).
 *
 * `useDevtoolMount` packages SvelteGrab's proven pattern:
 *   - a guarded `setTimeout(MOUNT_DETECT_DELAY_MS)` that bails if `destroyed`
 *   - runs `detectDevMode(forceEnable)` and only calls `setup()` when dev
 *   - stores `setup()`'s returned cleanup
 *   - on destroy: sets `destroyed`, clears the timer, runs cleanup
 *
 * --- Usage in a Svelte 5 component ---
 *   <script lang="ts">
 *     import { onMount, onDestroy } from 'svelte';
 *     import { useDevtoolMount } from './utils/use-devtool-mount.svelte.js';
 *
 *     let isDev = $state(false);
 *
 *     const mount = useDevtoolMount(() => forceEnable, () => {
 *       // runs only if dev mode detected; return a cleanup fn
 *       document.addEventListener('click', handleClick, true);
 *       document.addEventListener('keydown', handleKeydown);
 *       return () => {
 *         document.removeEventListener('click', handleClick, true);
 *         document.removeEventListener('keydown', handleKeydown);
 *       };
 *     }, {
 *       onDev: () => { isDev = true; console.log('[MyTool] Active!'); }
 *     });
 *
 *     onMount(mount.start);
 *     onDestroy(mount.stop);
 *   </script>
 */

import { detectDevMode } from './shared.js';
import { MOUNT_DETECT_DELAY_MS } from '../ui/tokens.js';

/** Cleanup function returned by a tool's `setup`, run on destroy. */
export type DevtoolCleanup = () => void;

/** Optional callbacks for the mount lifecycle. */
export interface UseDevtoolMountOptions {
	/**
	 * Delay before dev detection + setup, in ms. Defaults to
	 * {@link MOUNT_DETECT_DELAY_MS} (the proven 100ms used across the suite).
	 */
	delayMs?: number;
	/**
	 * Called (after the delay) when dev mode IS detected, before `setup` runs.
	 * Typical use: flip the component's `isDev = true` and log an "Active!" hint.
	 */
	onDev?: () => void;
	/**
	 * Called (after the delay) when dev mode is NOT detected. Typical use: log a
	 * "disabled — no dev metadata" message.
	 */
	onNotDev?: () => void;
}

/** Controller returned by {@link useDevtoolMount}. */
export interface DevtoolMountController {
	/** Wire into `onMount`. Schedules guarded dev-detection + setup. */
	start: () => void;
	/** Wire into `onDestroy`. Marks destroyed, clears the timer, runs cleanup. */
	stop: () => void;
	/** Whether the mount timer has already run setup (for diagnostics/tests). */
	readonly didSetup: () => boolean;
}

/**
 * Encapsulate the guarded mount/teardown pattern for a dev tool.
 *
 * @param getForceEnable - Forwarded to `detectDevMode`; forces dev mode on.
 *   Accepts either a plain boolean (backward compatible) or a getter
 *   `() => boolean`. The getter form is preferred so the reactive `forceEnable`
 *   prop is read at the moment detection runs (avoids `state_referenced_locally`).
 * @param setup - Runs once, after the delay, only if dev mode is detected.
 *   Return a cleanup function that removes whatever the setup added.
 * @param options - Optional delay override and dev/not-dev callbacks.
 * @returns a controller with `start` (for onMount) and `stop` (for onDestroy).
 */
export function useDevtoolMount(
	getForceEnable: boolean | (() => boolean),
	setup: () => DevtoolCleanup | void,
	options: UseDevtoolMountOptions = {}
): DevtoolMountController {
	const { delayMs = MOUNT_DETECT_DELAY_MS, onDev, onNotDev } = options;

	let destroyed = false;
	let didSetup = false;
	let cleanup: DevtoolCleanup | null = null;
	let mountTimeoutId: ReturnType<typeof setTimeout> | undefined;

	function start() {
		// Reset flags in case the controller is reused across remounts.
		destroyed = false;
		mountTimeoutId = setTimeout(() => {
			if (destroyed) return;

			const fe = typeof getForceEnable === 'function' ? getForceEnable() : getForceEnable;
			const isDev = detectDevMode(fe);
			if (!isDev) {
				onNotDev?.();
				return;
			}

			onDev?.();
			const result = setup();
			cleanup = typeof result === 'function' ? result : null;
			didSetup = true;
		}, delayMs);
	}

	function stop() {
		destroyed = true;
		if (mountTimeoutId !== undefined) {
			clearTimeout(mountTimeoutId);
			mountTimeoutId = undefined;
		}
		cleanup?.();
		cleanup = null;
	}

	return {
		start,
		stop,
		didSetup: () => didSetup
	};
}
