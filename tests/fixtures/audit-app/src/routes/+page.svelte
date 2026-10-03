<script lang="ts">
	let { data } = $props();
	let content = $state('<p>hi</p>');

	function onMsg(event: MessageEvent) {
		console.log(event.data);
	}
</script>

<svelte:window onmessage={onMsg} />

{@html content}
{@html "<b>x</b>"}

<a href="https://external.example" target="_blank">external</a>
<a href="https://external.example" target="_blank" rel="noopener noreferrer">safe external</a>
<a href="/about" target="_blank">relative</a>
<button onclick="doThing()">string handler</button>
<button onclick={() => console.log(data)}>function handler</button>
