<!--
	DevToolPopup — the shared popup chrome for every svelte-grab dev tool.
	See the documentation block at the top of the <script> tag below for the
	rationale, theming contract, and a full usage example.
-->
<script lang="ts">
	/**
	 * DevToolPopup — the shared popup chrome for every svelte-grab dev tool.
	 *
	 * Today each tool hand-rolls the same overlay -> dialog -> header (title +
	 * "Copied!"/"Copy failed" status + close button) -> body -> footer structure
	 * plus ~60 lines of identical CSS. This component owns that ONCE, driven by CSS
	 * custom properties (--sg-bg / --sg-border / --sg-text / --sg-accent) from the
	 * resolved theme, so migrated tools look pixel-identical to today.
	 *
	 * Theme: pass EITHER a pre-resolved theme via `colors`, OR the raw
	 * `theme` + `lightTheme` props (resolved internally with `resolveTheme`).
	 *
	 * Snippets: `children` renders the scrollable body; optional `footer` renders
	 * the footer row (typically DevToolButton copy actions); optional `headerExtra`
	 * renders inline metadata after the title (e.g. the component chip).
	 *
	 * Usage (in a tool component):
	 *
	 *   import DevToolPopup from './ui/DevToolPopup.svelte';
	 *   import DevToolButton from './ui/DevToolButton.svelte';
	 *   let visible = $state(false);
	 *   let copied = $state(false);
	 *   let copyFailed = $state(false);
	 *
	 *   ... in markup ...
	 *   <DevToolPopup
	 *     title="StateGrab"
	 *     bind:visible
	 *     theme={theme} lightTheme={lightTheme}
	 *     copied={copied} copyFailed={copyFailed}
	 *     titleColor="#a78bfa"
	 *     ariaLabel="SvelteStateGrab inspector"
	 *   >
	 *     {#snippet headerExtra()} component chip here {/snippet}
	 *     body content here
	 *     {#snippet footer()}
	 *       <DevToolButton onclick={...}>Copy for Agent</DevToolButton>
	 *     {/snippet}
	 *   </DevToolPopup>
	 */
	import type { Snippet } from 'svelte';
	import type { ThemeConfig } from '../types.js';
	import { resolveTheme, type ResolvedTheme } from '../utils/resolve-theme.js';
	import { hideFromThirdParties } from '../utils/hide-from-third-parties.js';
	import { Z_INDEX, RADIUS, FONT_SIZE, FONT_FAMILY_MONO } from './tokens.js';

	interface Props {
		/** Popup title (e.g. "StateGrab"). */
		title: string;
		/** Bindable visibility. Setting false closes the popup. */
		visible?: boolean;
		/**
		 * Pre-resolved theme. If omitted, `theme` + `lightTheme` are resolved
		 * internally via `resolveTheme`.
		 */
		colors?: ResolvedTheme;
		/** Raw theme overrides (used when `colors` is not supplied). */
		theme?: ThemeConfig;
		/** Use the light preset (used when `colors` is not supplied). */
		lightTheme?: boolean;
		/** Accent color for the title text. Defaults to the theme accent. */
		titleColor?: string;
		/** Show the "Copied!" success badge in the header. */
		copied?: boolean;
		/** Show the "Copy failed" badge in the header. */
		copyFailed?: boolean;
		/** aria-label for the dialog. Defaults to the title. */
		ariaLabel?: string;
		/** Minimum width of the popup (px). Default 360. */
		minWidth?: number;
		/** Inline metadata rendered after the title (e.g. component chip). */
		headerExtra?: Snippet;
		/** Scrollable body content. */
		children: Snippet;
		/** Optional footer row (typically copy buttons). */
		footer?: Snippet;
	}

	let {
		title,
		visible = $bindable(false),
		colors,
		theme = {},
		lightTheme = false,
		titleColor,
		copied = false,
		copyFailed = false,
		ariaLabel,
		minWidth = 360,
		headerExtra,
		children,
		footer
	}: Props = $props();

	// Accept a pre-resolved theme, or resolve from raw props. Wrapped in $derived
	// so theme/lightTheme changes flow through reactively.
	let resolved = $derived<ResolvedTheme>(colors ?? resolveTheme(theme, lightTheme));

	let overlayEl: HTMLDivElement | undefined = $state();

	function close() {
		visible = false;
	}

	// Opt the whole popup subtree out of third-party session-replay tools (so
	// source paths, prop values and errors never leak) and out of ui_snapshot /
	// ui_find. Re-runs whenever the overlay element is created: a popup that
	// opens after mount is marked too, which an onMount check missed.
	$effect(() => {
		if (overlayEl) hideFromThirdParties(overlayEl);
	});
</script>

{#if visible}
	<div
		bind:this={overlayEl}
		class="sg-overlay"
		style="z-index: {Z_INDEX.overlay};"
		onclick={close}
		onkeydown={(e) => e.key === 'Escape' && close()}
		role="presentation"
	>
		<div
			class="sg-popup"
			style="
				--sg-bg: {resolved.background};
				--sg-border: {resolved.border};
				--sg-text: {resolved.text};
				--sg-accent: {resolved.accent};
				--sg-popup-z: {Z_INDEX.popup};
				--sg-popup-radius: {RADIUS.md}px;
				--sg-popup-min-width: {minWidth}px;
				--sg-popup-font: {FONT_SIZE.base}px;
				--sg-popup-font-family: {FONT_FAMILY_MONO};
				--sg-title-color: {titleColor ?? resolved.accent};
			"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			aria-label={ariaLabel ?? title}
			tabindex="-1"
		>
			<div class="sg-header">
				<span class="sg-title">{title}</span>
				{#if headerExtra}{@render headerExtra()}{/if}
				{#if copied}<span class="sg-copied">Copied!</span>{/if}
				{#if copyFailed}<span class="sg-copy-failed">Copy failed</span>{/if}
				<button class="sg-close" onclick={close} aria-label="Close">&times;</button>
			</div>

			<div class="sg-content">
				{@render children()}
			</div>

			{#if footer}
				<div class="sg-footer">
					{@render footer()}
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.sg-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.3);
	}

	.sg-popup {
		position: fixed;
		top: 50%;
		left: 50%;
		z-index: var(--sg-popup-z);
		transform: translate(-50%, -50%);
		background: var(--sg-bg);
		border: 1px solid var(--sg-border);
		border-radius: var(--sg-popup-radius);
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
		min-width: var(--sg-popup-min-width);
		max-width: 600px;
		max-height: 500px;
		overflow: hidden;
		font-family: var(--sg-popup-font-family, ui-monospace, 'SF Mono', Menlo, Monaco, monospace);
		font-size: var(--sg-popup-font);
		color: var(--sg-text);
		display: flex;
		flex-direction: column;
	}

	.sg-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
		border-bottom: 1px solid var(--sg-border);
	}

	.sg-title {
		color: var(--sg-title-color);
		font-weight: 600;
		flex-shrink: 0;
	}

	.sg-copied {
		color: #4ade80;
		font-size: 11px;
	}

	.sg-copy-failed {
		color: #ef4444;
		font-size: 11px;
	}

	.sg-close {
		background: none;
		border: none;
		color: #888;
		cursor: pointer;
		padding: 2px 6px;
		font-size: 14px;
		border-radius: 4px;
		margin-left: auto;
	}

	.sg-close:hover {
		color: #fff;
		background: rgba(255, 255, 255, 0.1);
	}

	.sg-content {
		overflow-y: auto;
		flex: 1;
	}

	.sg-footer {
		display: flex;
		gap: 8px;
		padding: 8px 12px;
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
		border-top: 1px solid var(--sg-border);
	}
</style>
