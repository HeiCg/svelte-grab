<script lang="ts">
	// Top-level `await` needs Svelte's experimental async mode (enabled in
	// vite.config.ts). The nearest <svelte:boundary> shows its `pending`
	// snippet until this resolves (~300ms).
	function load(): Promise<string[]> {
		return new Promise((resolve) => {
			setTimeout(() => resolve(['north', 'south', 'east']), 300);
		});
	}

	const regions = await load();
</script>

<div class="fx-async" data-testid="fx-async-content">
	<p data-testid="fx-async-title">Loaded {regions.length} regions</p>
	<ul>
		{#each regions as region (region)}
			<li data-testid={`fx-async-item-${region}`}>{region}</li>
		{/each}
	</ul>
</div>

<style>
	.fx-async p {
		margin: 0 0 4px;
		color: #065f46;
	}
</style>
