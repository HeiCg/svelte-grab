<script lang="ts">
	type Mode = 'empty' | 'few' | 'many';
	type Item = { id: number; label: string };

	let mode = $state<Mode>('few');
	let nextId = 4;
	let items = $state<Item[]>([
		{ id: 1, label: 'Alpha' },
		{ id: 2, label: 'Beta' },
		{ id: 3, label: 'Gamma' }
	]);

	function add() {
		items.push({ id: nextId, label: `Item ${nextId}` });
		nextId += 1;
	}

	function reverse() {
		items.reverse();
	}

	function removeFirst() {
		items.shift();
	}
</script>

<!-- {#if}/{:else if}/{:else} chain plus a keyed {#each} with reorder/remove. -->
<div class="fx-flow" data-testid="fx-flow">
	<div class="fx-flow-modes">
		<button data-testid="fx-mode-empty" onclick={() => (mode = 'empty')}>empty</button>
		<button data-testid="fx-mode-few" onclick={() => (mode = 'few')}>few</button>
		<button data-testid="fx-mode-many" onclick={() => (mode = 'many')}>many</button>
	</div>

	{#if mode === 'empty'}
		<p data-testid="fx-branch-if">Branch: if (empty)</p>
	{:else if mode === 'few'}
		<p data-testid="fx-branch-else-if">Branch: else if (few)</p>
	{:else}
		<p data-testid="fx-branch-else">Branch: else (many)</p>
	{/if}

	<div class="fx-flow-actions">
		<button data-testid="fx-each-add" onclick={add}>add</button>
		<button data-testid="fx-each-reverse" onclick={reverse}>reverse</button>
		<button data-testid="fx-each-remove" onclick={removeFirst}>remove first</button>
	</div>

	<ul class="fx-flow-list" data-testid="fx-each-list">
		{#each items as item (item.id)}
			<li data-testid={`fx-each-item-${item.id}`}>{item.label}</li>
		{/each}
	</ul>
</div>

<style>
	.fx-flow-modes,
	.fx-flow-actions {
		display: flex;
		gap: 6px;
		margin-bottom: 6px;
	}
	.fx-flow-list {
		margin: 0;
		padding-left: 18px;
		color: #1f2937;
	}
</style>
