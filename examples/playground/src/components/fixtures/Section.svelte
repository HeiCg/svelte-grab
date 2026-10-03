<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		testid,
		children
	}: { title: string; testid: string; children: Snippet } = $props();
</script>

<!--
	Outermost level of the 3-deep chain: Section > FixtureCard > Button. Also
	the generic labelled wrapper every agent-runtime fixture renders inside.
-->
<section class="fx-section" data-testid={testid}>
	<h3 class="fx-section-title">{title}</h3>
	{@render children()}
</section>

<style>
	.fx-section {
		border: 1px dashed #6b7280;
		border-radius: 10px;
		padding: 16px;
		background: #ffffff;
	}
	.fx-section-title {
		margin: 0 0 10px;
		font-size: 16px;
		color: #111827;
	}
</style>
