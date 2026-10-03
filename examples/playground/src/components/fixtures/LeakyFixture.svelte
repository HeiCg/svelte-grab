<script module lang="ts">
	// Module-level: outlives every instance. Each mount pushes its root here and
	// nothing ever removes it, so every closed panel stays alive, detached.
	const retained: HTMLElement[] = [];
</script>

<script lang="ts">
	import { onMount } from 'svelte';

	// ui_leak_check fixture (e2e/leak.spec.ts): leaks on purpose. CleanFixture
	// is the same panel with the cleanup.
	let root: HTMLElement;

	onMount(() => {
		retained.push(root);
		const el = root;
		const onResize = () => (el.dataset.width = String(window.innerWidth));
		window.addEventListener('resize', onResize);
		// BUG (on purpose): no cleanup is returned, the listener is never removed.
	});
</script>

<div class="fx-leak-panel" data-testid="fx-leaky-panel" bind:this={root}>
	<strong>Leaky panel</strong>
	<ul>
		<li>one</li>
		<li>two</li>
		<li>three</li>
	</ul>
</div>

<style>
	.fx-leak-panel {
		padding: 6px 10px;
		border-radius: 6px;
		background: #fef2f2;
		color: #7f1d1d;
		font-size: 14px;
	}
	.fx-leak-panel ul {
		margin: 4px 0 0;
		padding-left: 18px;
	}
</style>
