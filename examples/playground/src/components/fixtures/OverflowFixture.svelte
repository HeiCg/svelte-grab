<script lang="ts">
	// ui_verify fixture (e2e/verify.spec.ts): the toggle renders a strip wider
	// than any viewport, so the page scrolls horizontally. Off by default;
	// `?overflow=1` starts with it on.
	let wide = $state(new URLSearchParams(window.location.search).get('overflow') === '1');
</script>

<div class="fx-overflow" data-testid="fx-overflow">
	<button
		class="fx-overflow-toggle"
		data-testid="fx-overflow-toggle"
		onclick={() => (wide = !wide)}
	>
		Overflow: {wide ? 'on' : 'off'}
	</button>
	{#if wide}
		<div class="fx-overflow-strip" data-testid="fx-overflow-strip">
			This strip is 2400px wide and makes the page scroll horizontally.
		</div>
	{/if}
</div>

<style>
	.fx-overflow {
		position: relative;
		min-height: 64px;
	}
	.fx-overflow-toggle {
		background: #111827;
		color: #ffffff;
		border: none;
		border-radius: 6px;
		padding: 6px 12px;
		font-size: 14px;
		cursor: pointer;
	}
	/* Absolutely positioned: widens the page without widening its parents. */
	.fx-overflow-strip {
		position: absolute;
		left: 0;
		top: 40px;
		width: 2400px;
		padding: 4px 8px;
		background: #fef3c7;
		color: #78350f;
		font-size: 13px;
	}
</style>
