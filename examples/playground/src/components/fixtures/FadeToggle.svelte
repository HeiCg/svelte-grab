<script lang="ts">
	import { fade } from 'svelte/transition';

	let visible = $state(true);
</script>

<!-- transition:fade on a toggled element (intro + outro). -->
<div data-testid="fx-fade">
	<button data-testid="fx-fade-toggle" onclick={() => (visible = !visible)}>
		{visible ? 'Hide' : 'Show'}
	</button>
	{#if visible}
		<p class="fx-fade-box" data-testid="fx-fade-box" transition:fade={{ duration: 150 }}>
			Fading content
		</p>
	{/if}
</div>

<style>
	.fx-fade-box {
		margin: 6px 0 0;
		padding: 8px;
		background: #eef2ff;
		color: #312e81;
		border-radius: 6px;
	}
</style>
