<script lang="ts">
	let { items = [] as string[] }: { items?: string[] } = $props();
</script>

<!-- {#each} rendered list so the grab stack walks into a loop body. -->
<ul class="pg-list" data-testid="demo-list">
	{#each items as item, i (item)}
		<li class="pg-list-item" data-testid={`demo-list-item-${i}`}>{item}</li>
	{/each}
</ul>

<style>
	.pg-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.pg-list-item {
		padding: 6px 10px;
		background: #f3f4f6;
		border-radius: 4px;
		color: #1f2937;
	}
</style>
