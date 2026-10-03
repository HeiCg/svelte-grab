<script lang="ts">
	let email = $state('');
	let plan = $state('free');
	let agree = $state(false);
	let notes = $state('');
	let result = $state<string | null>(null);

	function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		result = `${email} / ${plan} / ${agree ? 'agreed' : 'not agreed'}`;
	}
</script>

<!-- A form with several control types (email, select, checkbox, textarea). -->
<form class="fx-form" data-testid="fx-form" onsubmit={handleSubmit}>
	<label for="fx-email">Email</label>
	<input id="fx-email" data-testid="fx-form-email" type="email" bind:value={email} required />

	<label for="fx-plan">Plan</label>
	<select id="fx-plan" data-testid="fx-form-plan" bind:value={plan}>
		<option value="free">Free</option>
		<option value="pro">Pro</option>
	</select>

	<label class="fx-form-check">
		<input data-testid="fx-form-agree" type="checkbox" bind:checked={agree} />
		I agree
	</label>

	<label for="fx-notes">Notes</label>
	<textarea id="fx-notes" data-testid="fx-form-notes" bind:value={notes}></textarea>

	<button data-testid="fx-form-submit" type="submit">Send</button>
	{#if result}
		<p data-testid="fx-form-result">Sent: {result}</p>
	{/if}
</form>

<style>
	.fx-form {
		display: flex;
		flex-direction: column;
		gap: 4px;
		color: #374151;
	}
	.fx-form-check {
		display: flex;
		align-items: center;
		gap: 6px;
	}
</style>
