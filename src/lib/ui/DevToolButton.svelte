<!--
	DevToolButton — the shared footer/action button used across svelte-grab tools.

	Replaces the per-tool `.sg-state-btn` / `.sg-trace-btn` (etc.) markup, which
	are byte-for-byte identical. Inherits color from CSS custom properties set by
	the surrounding popup (`--sg-text`, `--sg-border`), so it always matches the
	resolved theme. By default it stretches to fill (flex: 1) like the existing
	footer copy buttons; pass `block={false}` for an inline-sized button.

	Usage:
	  <DevToolButton onclick={() => copyFb.copy(text)}>Copy for Agent</DevToolButton>
	  <DevToolButton block={false} title="Close" onclick={close}>×</DevToolButton>
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { RADIUS, SPACING, FONT_SIZE } from './tokens.js';

	interface Props {
		/** Click handler. */
		onclick?: (event: MouseEvent) => void;
		/** When true (default) the button grows to fill its flex row. */
		block?: boolean;
		/** Native disabled state. */
		disabled?: boolean;
		/** Accessible label / tooltip. */
		title?: string;
		/** aria-label override (falls back to `title`). */
		ariaLabel?: string;
		/** Button label / content. */
		children: Snippet;
	}

	let { onclick, block = true, disabled = false, title, ariaLabel, children }: Props = $props();
</script>

<button
	class="sg-btn"
	class:sg-btn-block={block}
	style="
		--sg-btn-radius: {RADIUS.sm}px;
		--sg-btn-pad-y: {SPACING.md}px;
		--sg-btn-pad-x: {SPACING.xl}px;
		--sg-btn-font: {FONT_SIZE.md}px;
	"
	{onclick}
	{disabled}
	{title}
	aria-label={ariaLabel ?? title}
>
	{@render children()}
</button>

<style>
	.sg-btn {
		padding: var(--sg-btn-pad-y) var(--sg-btn-pad-x);
		background: rgba(255, 255, 255, 0.1);
		border: 1px solid var(--sg-border, #4a4a6a);
		border-radius: var(--sg-btn-radius);
		color: var(--sg-text, #e0e0e0);
		cursor: pointer;
		font-size: var(--sg-btn-font);
		font-family: inherit;
	}

	.sg-btn-block {
		flex: 1;
	}

	.sg-btn:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.15);
	}

	.sg-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
