<script lang="ts">
	// `testid` defaults to the original id so existing specs keep matching;
	// fixtures that reuse Button pass their own to stay unique on the page.
	let {
		label = 'Button',
		onclick = () => {},
		testid = 'demo-button'
	}: { label?: string; onclick?: () => void; testid?: string } = $props();
</script>

<button class="pg-button" data-testid={testid} {onclick}>
	{label}
</button>

<style>
	.pg-button {
		background: #2563eb;
		color: #ffffff;
		border: none;
		border-radius: 6px;
		padding: 8px 14px;
		font-size: 14px;
		cursor: pointer;
	}
	.pg-button:hover {
		background: #1d4ed8;
	}
</style>
