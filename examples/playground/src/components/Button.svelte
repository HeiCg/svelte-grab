<script lang="ts">
	let { label = 'Button', onclick = () => {} }: { label?: string; onclick?: () => void } =
		$props();
</script>

<button class="pg-button" data-testid="demo-button" {onclick}>
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
