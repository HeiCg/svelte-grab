<script lang="ts">
	import { SvelteDevKit } from 'svelte-grab';
	import Card from './components/Card.svelte';
	import List from './components/List.svelte';
	import Counter from './components/Counter.svelte';
	import ContrastText from './components/ContrastText.svelte';
	import EditableBox from './components/EditableBox.svelte';
	import DemoForm from './components/DemoForm.svelte';
	import Section from './components/fixtures/Section.svelte';
	import FixtureCard from './components/fixtures/FixtureCard.svelte';
	import ControlFlow from './components/fixtures/ControlFlow.svelte';
	import SnippetHost from './components/fixtures/SnippetHost.svelte';
	import AsyncFixture from './components/fixtures/AsyncFixture.svelte';
	import FadeToggle from './components/fixtures/FadeToggle.svelte';
	import FixtureForm from './components/fixtures/FixtureForm.svelte';
	import OverflowFixture from './components/fixtures/OverflowFixture.svelte';

	const items = ['Apples', 'Bananas', 'Cherries', 'Dates'];

	// MCP bridge from the URL, for e2e/agent-loop.spec.ts and manual runs:
	// `?mcp=1&mcpPort=4799&mcpToken=secret`. Without `mcp=1` the defaults stay
	// (enableMcp off, port 4723, no token).
	const query = new URLSearchParams(window.location.search);
	const enableMcp = query.get('mcp') === '1';
	const portParam = Number(query.get('mcpPort'));
	const mcpPort = Number.isInteger(portParam) && portParam > 0 ? portParam : undefined;
	const mcpToken = query.get('mcpToken') || undefined;
	// `?hotkeys=minimal` for e2e/annotations.spec.ts: only Alt+Click, Shift+Alt+Click,
	// Alt+Drag, Escape and N. Without it the default ('full') stays.
	const hotkeys = query.get('hotkeys') === 'minimal' ? 'minimal' : undefined;
</script>

<!--
	The full svelte-grab dev-tool suite, mounted from the REAL src/lib source via
	the Vite alias. It auto-activates because vite dev emits __svelte_meta, which
	detectDevMode() scans for. forceEnable is intentionally NOT set — we want the
	genuine dev-mode detection path to run so e2e verifies it end-to-end.
-->
<SvelteDevKit {enableMcp} {mcpPort} {mcpToken} {hotkeys} />

<main class="pg-app" data-testid="app-root">
	<header class="pg-header">
		<h1 class="pg-title">svelte-grab playground</h1>
		<p class="pg-subtitle" data-testid="subtitle">
			Alt+Click any element to grab its component stack.
		</p>
	</header>

	<section class="pg-grid">
		<Card title="Nested Card">
			{#snippet children()}
				<p data-testid="card-text">A card containing a nested Button component.</p>
			{/snippet}
		</Card>

		<div class="pg-panel" data-testid="list-panel">
			<h3 class="pg-panel-title">Fruit list</h3>
			<List {items} />
		</div>

		<Counter />

		<ContrastText />

		<div class="pg-panel" data-testid="edit-panel">
			<h3 class="pg-panel-title">Editable styles</h3>
			<EditableBox />
		</div>

		<div class="pg-panel" data-testid="form-panel">
			<h3 class="pg-panel-title">Form</h3>
			<DemoForm />
		</div>
	</section>

	<!--
		Agent-runtime fixtures (docs/agent-runtime-spec.md, Foundation fixes).
		Each one covers a Svelte 5 construct the ui_* tools must handle. Test ids
		are prefixed `fx-` and asserted by e2e/fixtures.spec.ts.
	-->
	<h2 class="pg-fixtures-title" data-testid="fixtures-title">Agent-runtime fixtures</h2>
	<section class="pg-grid" data-testid="fixtures-root">
		<!-- 3 levels: Section > FixtureCard > Button (Button reused twice). -->
		<Section title="Nested chain" testid="fx-nested">
			<FixtureCard name="a" />
			<FixtureCard name="b" />
		</Section>

		<Section title="Control flow" testid="fx-control-flow">
			<ControlFlow />
		</Section>

		<Section title="Snippets" testid="fx-snippets">
			<SnippetHost />
		</Section>

		<Section title="Async boundary" testid="fx-boundary">
			<svelte:boundary>
				<AsyncFixture />
				{#snippet pending()}
					<p data-testid="fx-async-pending">Loading regions…</p>
				{/snippet}
				{#snippet failed(error, reset)}
					<p data-testid="fx-async-failed">Failed: {String(error)}</p>
					<button onclick={reset}>retry</button>
				{/snippet}
			</svelte:boundary>
		</Section>

		<Section title="Transition" testid="fx-transition">
			<FadeToggle />
		</Section>

		<Section title="Form" testid="fx-form-section">
			<FixtureForm />
		</Section>

		<Section title="Overflow" testid="fx-overflow-section"><OverflowFixture /></Section>
	</section>
</main>

<style>
	:global(body) {
		margin: 0;
		font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
		background: #f9fafb;
		color: #111827;
	}
	.pg-app {
		max-width: 1100px;
		margin: 0 auto;
		padding: 32px 24px;
	}
	.pg-header {
		margin-bottom: 24px;
	}
	.pg-title {
		margin: 0 0 4px;
		font-size: 28px;
	}
	.pg-subtitle {
		margin: 0;
		color: #4b5563;
	}
	.pg-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
		gap: 20px;
		align-items: start;
	}
	.pg-fixtures-title {
		margin: 32px 0 12px;
		font-size: 20px;
	}
	.pg-panel {
		border: 1px solid #d1d5db;
		border-radius: 10px;
		padding: 16px;
		background: #ffffff;
	}
	.pg-panel-title {
		margin: 0 0 10px;
		font-size: 16px;
		color: #111827;
	}
</style>
