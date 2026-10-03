<script lang="ts">
	// Quiet sibling of HotFixture (e2e/profile.spec.ts): ticks once per second
	// while `running`. Its own file, so ui_profile attributes it separately.
	let { running }: { running: boolean } = $props();
	let ticks = $state(0);

	$effect(() => {
		if (!running) return;
		const id = setInterval(() => ticks++, 1000);
		return () => clearInterval(id);
	});
</script>

<span class="fx-quiet" data-testid="fx-quiet-count">quiet ticks: {ticks}</span>

<style>
	.fx-quiet {
		color: #4b5563;
		font-size: 14px;
	}
</style>
