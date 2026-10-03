<script lang="ts">
	import type { Snippet } from 'svelte';

	let { items, row, empty }: { items: string[]; row: Snippet<[string, number]>; empty?: Snippet } =
		$props();
</script>

<!-- Child that renders snippets passed in by its parent ({@render}). -->
<ol class="fx-snippet-list" data-testid="fx-snippet-list">
	{#each items as item, i (item)}
		{@render row(item, i)}
	{:else}
		{#if empty}{@render empty()}{/if}
	{/each}
</ol>

<style>
	.fx-snippet-list {
		margin: 0;
		padding-left: 18px;
	}
</style>
