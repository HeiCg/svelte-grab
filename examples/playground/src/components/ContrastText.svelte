<script lang="ts">
	// Intentionally low-contrast: light gray (#cccccc) text on white background.
	// Contrast ratio ~1.6:1, well below the WCAG AA 4.5:1 minimum, so the
	// a11y reporter flags it as a critical contrast issue.
</script>

<div class="pg-contrast" data-testid="low-contrast">
	<p class="pg-contrast-text" data-testid="low-contrast-text">
		This faint gray text is hard to read on a white background.
	</p>
</div>

<style>
	.pg-contrast {
		background: #ffffff;
		padding: 16px;
		border: 1px solid #e5e7eb;
		border-radius: 10px;
		max-width: 360px;
	}
	.pg-contrast-text {
		margin: 0;
		color: #cccccc;
		font-size: 14px;
	}
</style>
