<script module lang="ts">
	// Module-level registry of mounted panels; each instance removes itself on
	// destroy, so closed panels can be collected.
	const mounted: HTMLElement[] = [];
</script>

<script lang="ts">
	import { onMount } from 'svelte';

	// ui_leak_check fixture (e2e/leak.spec.ts): the non-leaking twin of
	// LeakyFixture. Same registry + window listener, both undone on destroy.
	let root: HTMLElement;

	onMount(() => {
		const el = root;
		mounted.push(el);
		const onResize = () => (el.dataset.width = String(window.innerWidth));
		window.addEventListener('resize', onResize);
		return () => {
			window.removeEventListener('resize', onResize);
			const i = mounted.indexOf(el);
			if (i >= 0) mounted.splice(i, 1);
		};
	});
</script>

<div class="fx-leak-panel" data-testid="fx-clean-panel" bind:this={root}>
	<strong>Clean panel</strong>
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
		background: #f0fdf4;
		color: #14532d;
		font-size: 14px;
	}
	.fx-leak-panel ul {
		margin: 4px 0 0;
		padding-left: 18px;
	}
</style>
