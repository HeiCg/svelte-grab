<script lang="ts">
	let name = $state('');
	let submitted = $state('');

	function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		submitted = name;
	}
</script>

<!--
	A real form input so the e2e suite can verify keyboard-shortcut-in-input
	edge cases (typing letters like "a"/"p"/"e" into a focused field must not
	trigger the dev tools, since those are only fired with the Alt modifier).
-->
<form class="pg-form" data-testid="demo-form" onsubmit={handleSubmit}>
	<label class="pg-form-label" for="pg-name">Name</label>
	<input
		id="pg-name"
		class="pg-form-input"
		data-testid="demo-input"
		type="text"
		bind:value={name}
		placeholder="Type here"
	/>
	<button class="pg-form-submit" data-testid="demo-submit" type="submit">Submit</button>
	{#if submitted}
		<p class="pg-form-result" data-testid="demo-result">Submitted: {submitted}</p>
	{/if}
</form>

<style>
	.pg-form {
		display: flex;
		flex-direction: column;
		gap: 6px;
		max-width: 360px;
	}
	.pg-form-label {
		font-size: 13px;
		color: #374151;
	}
	.pg-form-input {
		padding: 8px;
		border: 1px solid #9ca3af;
		border-radius: 6px;
		font-size: 14px;
	}
	.pg-form-submit {
		background: #4f46e5;
		color: #fff;
		border: none;
		border-radius: 6px;
		padding: 8px 12px;
		cursor: pointer;
		align-self: flex-start;
	}
	.pg-form-result {
		margin: 4px 0 0;
		color: #065f46;
		font-size: 13px;
	}
</style>
