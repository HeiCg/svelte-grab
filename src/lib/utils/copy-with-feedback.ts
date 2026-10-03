/**
 * Copy-to-clipboard with the standard "Copied!" / "Copy failed" feedback flags.
 *
 * Every dev-tool component repeats this snippet, often several times per file:
 *   copyToClipboard(text).then(ok => {
 *     if (ok) { copied = true; setTimeout(() => (copied = false), 1500); }
 *     else    { copyFailed = true; setTimeout(() => (copyFailed = false), 3000); }
 *   });
 * ...which leaks timeouts (no clearTimeout) and hard-codes the durations.
 *
 * This module is a plain `.ts` file, so it cannot itself declare `$state`
 * (runes only work in `.svelte` / `.svelte.ts` files). Instead it exposes a
 * `$state`-FRIENDLY controller: the component owns the reactive flags, and this
 * helper drives them through getter/setter accessors while owning the timeout
 * bookkeeping (clearing a pending badge before each copy so nothing leaks).
 *
 * --- Recommended usage in a Svelte 5 component ---
 *   <script lang="ts">
 *     import { createCopyFeedback } from './utils/copy-with-feedback.js';
 *
 *     let copied = $state(false);
 *     let copyFailed = $state(false);
 *
 *     // Bind the component's runes into the controller once:
 *     const copyFb = createCopyFeedback({
 *       get copied()     { return copied; },     set copied(v)     { copied = v; },
 *       get copyFailed() { return copyFailed; }, set copyFailed(v) { copyFailed = v; }
 *     });
 *     // Clean up the pending timeout on teardown:
 *     onDestroy(() => copyFb.reset());
 *   </script>
 *
 *   <button onclick={() => copyFb.copy(formatForAgent(info))}>Copy for Agent</button>
 *   {#if copied}<span>Copied!</span>{/if}
 *   {#if copyFailed}<span>Copy failed</span>{/if}
 *
 * Because the controller writes through the `copied` / `copyFailed` accessors,
 * which are backed by the component's `$state`, the markup stays reactive.
 *
 * --- One-shot variant ---
 * For a quick call without a long-lived controller, use `copyWithFeedback`
 * (same accessor object, plus optional timer accessors so it can cancel a
 * pending badge before starting a new copy).
 */

import { copyToClipboard } from './shared.js';
import { COPY_SUCCESS_MS, COPY_FAILURE_MS } from '../ui/tokens.js';

/**
 * Accessor object backing the two feedback flags. In a component these are
 * thin get/set wrappers over `$state` variables, which keeps them reactive.
 */
export interface CopyFeedbackFlags {
	/** True while the success badge should show. */
	copied: boolean;
	/** True while the failure badge should show. */
	copyFailed: boolean;
}

/**
 * Controller returned by {@link createCopyFeedback}. Drives the bound flags and
 * owns the auto-clear timeout.
 */
export interface CopyFeedbackController {
	/**
	 * Copy `text`, set `copied`/`copyFailed` accordingly, and schedule the flag
	 * to auto-clear after {@link COPY_SUCCESS_MS} / {@link COPY_FAILURE_MS}.
	 * Cancels any previously pending auto-clear first.
	 * @returns the clipboard success boolean.
	 */
	copy(text: string): Promise<boolean>;
	/** Clear both flags now and cancel any pending auto-clear timeout. */
	reset(): void;
}

/**
 * Create a copy-feedback controller bound to a component's reactive flags.
 *
 * @param flags - get/set accessors over the component's `copied` / `copyFailed`
 *   `$state` (or any externally-owned booleans).
 */
export function createCopyFeedback(flags: CopyFeedbackFlags): CopyFeedbackController {
	let timer: ReturnType<typeof setTimeout> | undefined;

	function clearTimer() {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	}

	function reset() {
		clearTimer();
		flags.copied = false;
		flags.copyFailed = false;
	}

	async function copy(text: string): Promise<boolean> {
		// Cancel any in-flight badge so rapid copies restart cleanly (no leak).
		clearTimer();
		flags.copied = false;
		flags.copyFailed = false;

		const ok = await copyToClipboard(text);
		if (ok) {
			flags.copied = true;
			timer = setTimeout(() => {
				flags.copied = false;
				timer = undefined;
			}, COPY_SUCCESS_MS);
		} else {
			flags.copyFailed = true;
			timer = setTimeout(() => {
				flags.copyFailed = false;
				timer = undefined;
			}, COPY_FAILURE_MS);
		}
		return ok;
	}

	return { copy, reset };
}

/**
 * One-shot copy-with-feedback. Same flag accessors as
 * {@link createCopyFeedback}, plus optional timer accessors so a pending badge
 * can be cancelled before a new copy starts. Use this when you don't want to
 * hold a controller instance.
 *
 * @returns the clipboard success boolean.
 */
export interface CopyWithFeedbackOptions extends CopyFeedbackFlags {
	/** Returns the current pending-timeout handle (or undefined). */
	getTimer?: () => ReturnType<typeof setTimeout> | undefined;
	/** Stores the new pending-timeout handle (or undefined when cleared). */
	setTimer?: (timer: ReturnType<typeof setTimeout> | undefined) => void;
}

export async function copyWithFeedback(
	text: string,
	options: CopyWithFeedbackOptions
): Promise<boolean> {
	const existing = options.getTimer?.();
	if (existing !== undefined) {
		clearTimeout(existing);
		options.setTimer?.(undefined);
	}
	options.copied = false;
	options.copyFailed = false;

	const ok = await copyToClipboard(text);
	if (ok) {
		options.copied = true;
		const t = setTimeout(() => {
			options.copied = false;
			options.setTimer?.(undefined);
		}, COPY_SUCCESS_MS);
		options.setTimer?.(t);
	} else {
		options.copyFailed = true;
		const t = setTimeout(() => {
			options.copyFailed = false;
			options.setTimer?.(undefined);
		}, COPY_FAILURE_MS);
		options.setTimer?.(t);
	}
	return ok;
}
