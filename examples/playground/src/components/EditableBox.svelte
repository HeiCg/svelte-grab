<script lang="ts">
	// A box with explicit padding + color so the StyleGrab edit panel has clear,
	// assertable values to tweak (padding stepper, color swatch).
</script>

<div class="pg-editable" data-testid="editable-box">
	<span class="pg-editable-label" data-testid="editable-box-label">Edit my styles</span>
</div>

<style>
	.pg-editable {
		padding: 12px;
		background: #fef3c7;
		border: 1px solid #f59e0b;
		border-radius: 8px;
		color: #92400e;
		max-width: 360px;
		display: inline-block;
	}
	.pg-editable-label {
		font-size: 14px;
		font-weight: 600;
	}
</style>
