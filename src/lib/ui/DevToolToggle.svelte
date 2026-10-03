<!--
	DevToolToggle — a small themed on/off toggle for dev-tool popups (e.g. a
	"filter node_modules" or "include subtree" switch in the tool footers).

	`checked` is bindable so a component can two-way bind it:
	  <DevToolToggle bind:checked={filterNodeModules} label="Filter node_modules" />

	Colors come from the surrounding popup's CSS custom properties
	(`--sg-accent`, `--sg-text`, `--sg-border`) so it tracks the resolved theme.
-->
<script lang="ts">
	import { RADIUS, FONT_SIZE, SPACING, TRANSITION } from './tokens.js';

	interface Props {
		/** Two-way bindable on/off state. */
		checked?: boolean;
		/** Visible label text shown next to the switch. */
		label?: string;
		/** Native disabled state. */
		disabled?: boolean;
		/** Fired after the value changes (in addition to `bind:checked`). */
		onchange?: (checked: boolean) => void;
	}

	let { checked = $bindable(false), label, disabled = false, onchange }: Props = $props();

	function toggle() {
		if (disabled) return;
		checked = !checked;
		onchange?.(checked);
	}
</script>

<button
	type="button"
	class="sg-toggle"
	class:sg-toggle-on={checked}
	role="switch"
	aria-checked={checked}
	aria-label={label}
	{disabled}
	onclick={toggle}
	style="
		--sg-toggle-radius: {RADIUS.sm}px;
		--sg-toggle-font: {FONT_SIZE.md}px;
		--sg-toggle-gap: {SPACING.md}px;
		--sg-toggle-transition: {TRANSITION.fast}ms;
	"
>
	<span class="sg-toggle-track">
		<span class="sg-toggle-thumb"></span>
	</span>
	{#if label}
		<span class="sg-toggle-label">{label}</span>
	{/if}
</button>

<style>
	.sg-toggle {
		display: inline-flex;
		align-items: center;
		gap: var(--sg-toggle-gap);
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		color: var(--sg-text, #e0e0e0);
		font-family: inherit;
		font-size: var(--sg-toggle-font);
	}

	.sg-toggle:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.sg-toggle-track {
		position: relative;
		display: inline-block;
		width: 28px;
		height: 16px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.15);
		border: 1px solid var(--sg-border, #4a4a6a);
		transition: background var(--sg-toggle-transition) ease;
		flex-shrink: 0;
	}

	.sg-toggle-on .sg-toggle-track {
		background: var(--sg-accent, #ff6b35);
		border-color: var(--sg-accent, #ff6b35);
	}

	.sg-toggle-thumb {
		position: absolute;
		top: 1px;
		left: 1px;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: #fff;
		transition: transform var(--sg-toggle-transition) ease;
	}

	.sg-toggle-on .sg-toggle-thumb {
		transform: translateX(12px);
	}

	.sg-toggle-label {
		white-space: nowrap;
	}
</style>
