<script lang="ts">
	import SnippetList from './SnippetList.svelte';

	const tools = ['grab', 'inspect', 'verify'];
</script>

<!-- Parent that declares a {#snippet} and hands it to a child component. -->
<div data-testid="fx-snippet-host">
	{#snippet row(name: string, index: number)}
		<li class="fx-snippet-row" data-testid={`fx-snippet-row-${index}`}>
			<strong>{index + 1}.</strong> {name}
		</li>
	{/snippet}

	<SnippetList items={tools} {row} />
</div>

<style>
	.fx-snippet-row {
		color: #1f2937;
	}
</style>
