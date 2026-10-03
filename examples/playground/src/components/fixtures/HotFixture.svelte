<script lang="ts">
	import { onDestroy } from 'svelte';
	import QuietTicker from './QuietTicker.svelte';

	// ui_profile fixture (e2e/profile.spec.ts): Start updates the counter every
	// 16ms (a hot component) and the QuietTicker sibling once per second (a
	// quiet one). Stopped by default so other specs see a still page.
	let running = $state(false);
	let count = $state(0);
	let timer: ReturnType<typeof setInterval> | undefined;

	function toggle() {
		running = !running;
		clearInterval(timer);
		timer = running ? setInterval(() => count++, 16) : undefined;
	}

	onDestroy(() => clearInterval(timer));
</script>

<div class="fx-hot" data-testid="fx-hot">
	<button class="fx-hot-toggle" data-testid="fx-hot-toggle" onclick={toggle}>
		{running ? 'Stop' : 'Start'} hot updates
	</button>
	<span class="fx-hot-count" data-testid="fx-hot-count">{count}</span>
	<QuietTicker {running} />
</div>

<style>
	.fx-hot {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.fx-hot-toggle {
		background: #111827;
		color: #ffffff;
		border: none;
		border-radius: 6px;
		padding: 6px 12px;
		font-size: 14px;
		cursor: pointer;
	}
	.fx-hot-count {
		font-variant-numeric: tabular-nums;
		min-width: 4ch;
	}
</style>
