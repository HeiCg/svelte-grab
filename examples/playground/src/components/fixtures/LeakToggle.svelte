<script lang="ts">
	import type { Snippet } from 'svelte';

	// ui_leak_check fixture host (e2e/leak.spec.ts): Open mounts the child,
	// Close unmounts it. Both buttons always render, so their refs stay valid
	// across open/close cycles.
	let { id, label, children }: { id: string; label: string; children: Snippet } = $props();
	let open = $state(false);
</script>

<div class="fx-leak-toggle" data-testid={`fx-${id}`}>
	<span class="fx-leak-label">{label}</span>
	<button data-testid={`fx-${id}-open`} onclick={() => (open = true)}>Open</button>
	<button data-testid={`fx-${id}-close`} onclick={() => (open = false)}>Close</button>
	{#if open}
		{@render children()}
	{/if}
</div>

<style>
	.fx-leak-toggle {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		flex-wrap: wrap;
		margin-bottom: 8px;
	}
	.fx-leak-label {
		min-width: 9ch;
		font-size: 14px;
		color: #374151;
	}
</style>
