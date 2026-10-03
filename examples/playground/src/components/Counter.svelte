<script lang="ts">
	// A component that mutates the DOM on demand, for the render profiler.
	// Each "bump" appends/updates DOM nodes so the profiler's MutationObserver
	// has real mutations to attribute back to this component.
	let count = $state(0);
	let log = $state<number[]>([]);

	function bump() {
		count += 1;
		// Push a new node into a keyed list -> real DOM insertion the profiler sees.
		log = [...log, count].slice(-8);
	}

	// Fire a burst of mutations so the profiler/live overlay definitely paints.
	function burst() {
		let n = 0;
		const id = setInterval(() => {
			bump();
			if (++n >= 30) clearInterval(id);
		}, 16);
	}
</script>

<div class="pg-counter" data-testid="demo-counter">
	<div class="pg-counter-value" data-testid="counter-value">{count}</div>
	<div class="pg-counter-actions">
		<button class="pg-counter-btn" data-testid="counter-bump" onclick={bump}>Bump</button>
		<button class="pg-counter-btn" data-testid="counter-burst" onclick={burst}>Burst</button>
	</div>
	<div class="pg-counter-log" data-testid="counter-log">
		{#each log as n (n)}
			<span class="pg-counter-tick">{n}</span>
		{/each}
	</div>
</div>

<style>
	.pg-counter {
		border: 1px solid #d1d5db;
		border-radius: 10px;
		padding: 16px;
		background: #ffffff;
		max-width: 360px;
	}
	.pg-counter-value {
		font-size: 32px;
		font-weight: 700;
		color: #111827;
	}
	.pg-counter-actions {
		display: flex;
		gap: 8px;
		margin: 8px 0;
	}
	.pg-counter-btn {
		background: #059669;
		color: #fff;
		border: none;
		border-radius: 6px;
		padding: 6px 12px;
		cursor: pointer;
	}
	.pg-counter-log {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		min-height: 20px;
	}
	.pg-counter-tick {
		background: #d1fae5;
		color: #065f46;
		border-radius: 4px;
		padding: 2px 6px;
		font-size: 12px;
	}
</style>
