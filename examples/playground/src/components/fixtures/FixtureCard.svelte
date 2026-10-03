<script lang="ts">
	import Button from '../Button.svelte';

	let { name }: { name: string } = $props();

	let clicks = $state(0);
</script>

<!-- Middle level: rendered twice, each reusing the shared Button component. -->
<div class="fx-card" data-testid={`fx-card-${name}`}>
	<p class="fx-card-text" data-testid={`fx-card-text-${name}`}>Card {name}</p>
	<Button
		testid={`fx-button-${name}`}
		label={`${name}: ${clicks}`}
		onclick={() => (clicks += 1)}
	/>
</div>

<style>
	.fx-card {
		border: 1px solid #d1d5db;
		border-radius: 8px;
		padding: 10px;
		margin-bottom: 8px;
	}
	.fx-card-text {
		margin: 0 0 6px;
		color: #374151;
	}
</style>
