<script lang="ts">
	import Button from './Button.svelte';
	import type { Snippet } from 'svelte';

	let {
		title = 'Card',
		children
	}: { title?: string; children?: Snippet } = $props();

	let clicks = $state(0);
</script>

<!--
	A nested component (Card > Button) so __svelte_meta has a real, multi-level
	component stack for the grab / props-tracer tests.
-->
<div class="pg-card" data-testid="demo-card">
	<h2 class="pg-card-title">{title}</h2>
	<div class="pg-card-body">
		{#if children}{@render children()}{/if}
	</div>
	<Button label={`Clicked ${clicks}x`} onclick={() => (clicks += 1)} />
</div>

<style>
	.pg-card {
		border: 1px solid #d1d5db;
		border-radius: 10px;
		padding: 16px;
		background: #ffffff;
		max-width: 360px;
	}
	.pg-card-title {
		margin: 0 0 8px;
		font-size: 18px;
		color: #111827;
	}
	.pg-card-body {
		margin-bottom: 12px;
		color: #374151;
	}
</style>
