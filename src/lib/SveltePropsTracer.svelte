<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { SveltePropsTracerProps, PropTrace, PropTraceNode } from './types.js';
	import type { SvelteElement } from './utils/shared.js';
	import {
		findSvelteElement,
		shortenPath,
		extractComponentName,
		checkModifier,
		isExcludedPath,
		getElementPreview
	} from './utils/shared.js';
	import { registerToolOutput } from './utils/unified-export.js';
	import DevToolPopup from './ui/DevToolPopup.svelte';
	import DevToolButton from './ui/DevToolButton.svelte';
	import { resolveTheme } from './utils/resolve-theme.js';
	import { createCopyFeedback } from './utils/copy-with-feedback.js';
	import { useDevtoolMount } from './utils/use-devtool-mount.svelte.js';

	let {
		modifier = 'alt',
		secondaryModifier = 'shift',
		forceEnable = false,
		showPopup = true,
		theme = {},
		lightTheme = false
	}: SveltePropsTracerProps = $props();

	let colors = $derived(resolveTheme(theme, lightTheme));

	let isDev = $state(false);
	let visible = $state(false);
	let copied = $state(false);
	let copyFailed = $state(false);
	let trace = $state<PropTrace | null>(null);

	const copyFb = createCopyFeedback({
		get copied() { return copied; },
		set copied(v) { copied = v; },
		get copyFailed() { return copyFailed; },
		set copyFailed(v) { copyFailed = v; }
	});

	/**
	 * Build the component hierarchy trace by walking __svelte_meta.parent chain
	 */
	/**
	 * Extract meaningful HTML attributes from an element as a proxy for props
	 */
	function extractPropsProxy(el: HTMLElement): Record<string, string> {
		const proxy: Record<string, string> = {};
		for (const attr of Array.from(el.attributes)) {
			// Skip internal/svelte attributes and class/style (too noisy)
			if (attr.name.startsWith('__') || attr.name.startsWith('svelte-')) continue;
			if (attr.name === 'class' || attr.name === 'style') continue;
			proxy[attr.name] = attr.value.slice(0, 80);
		}
		return proxy;
	}

	function buildTrace(element: SvelteElement): PropTrace {
		const chain: PropTraceNode[] = [];
		const seen = new Set<string>();
		const meta = element.__svelte_meta;

		// Add the element's own location
		if (meta?.loc && !isExcludedPath(meta.loc.file)) {
			const key = `${meta.loc.file}:${meta.loc.line}`;
			if (!seen.has(key)) {
				seen.add(key);
				chain.push({
					file: meta.loc.file,
					line: meta.loc.line,
					column: meta.loc.column,
					componentName: extractComponentName(meta.loc.file),
					depth: 0,
					propsProxy: extractPropsProxy(element)
				});
			}
		}

		// Walk the parent chain
		let parent = meta?.parent;
		let depth = 1;
		while (parent) {
			if (parent.file && parent.line && !isExcludedPath(parent.file)) {
				const key = `${parent.file}:${parent.line}`;
				if (!seen.has(key)) {
					seen.add(key);
					chain.push({
						file: parent.file,
						line: parent.line,
						column: parent.column || 0,
						componentName: extractComponentName(parent.file),
						depth
					});
					depth++;
				}
			}
			parent = parent.parent;
		}

		// Also walk up the DOM to find additional component boundaries
		let current: HTMLElement | null = element.parentElement;
		while (current) {
			const currentMeta = (current as SvelteElement).__svelte_meta;
			if (currentMeta?.loc && !isExcludedPath(currentMeta.loc.file)) {
				const key = `${currentMeta.loc.file}:${currentMeta.loc.line}`;
				if (!seen.has(key)) {
					seen.add(key);
					chain.push({
						file: currentMeta.loc.file,
						line: currentMeta.loc.line,
						column: currentMeta.loc.column,
						componentName: extractComponentName(currentMeta.loc.file),
						depth,
						propsProxy: extractPropsProxy(current)
					});
					depth++;
				}
			}
			current = current.parentElement;
		}

		return {
			chain,
			elementTag: element.tagName.toLowerCase(),
			elementPreview: getElementPreview(element)
		};
	}

	/**
	 * Format trace for LLM agent
	 */
	function formatForAgent(t: PropTrace): string {
		if (t.chain.length === 0) return 'No component trace found.';

		const parts: string[] = [
			`=== Props Trace: ${t.elementPreview} ===\n`,
			`\u{1F4CD} COMPONENT CHAIN:\n`
		];

		for (let i = t.chain.length - 1; i >= 0; i--) {
			const node = t.chain[i];
			const name = node.componentName || 'element';
			const file = shortenPath(node.file);
			const marker = i === 0 ? ' \u2190 YOU ARE HERE' : '';

			parts.push(`  [${t.chain.length - i}] ${file}:${node.line}${marker}`);
			parts.push(`      \u2502 <${name}>`);

			// Show props proxy (HTML attributes) as a proxy for actual props
			if (node.propsProxy && Object.keys(node.propsProxy).length > 0) {
				const attrs = Object.entries(node.propsProxy)
					.map(([k, v]) => `${k}="${v}"`)
					.join(', ');
				parts.push(`      \u2502   attrs: ${attrs}`);
			}

			if (i > 0) {
				parts.push(`      \u2193`);
			}
		}

		parts.push('');
		parts.push(`\u{1F333} Depth: ${t.chain.length} component${t.chain.length !== 1 ? 's' : ''}`);

		// Categorize nesting chain
		const hasDataAttrs = t.chain.some(n => n.propsProxy && Object.keys(n.propsProxy).some(k => k.startsWith('data-')));
		const allLayoutOnly = t.chain.every(n => !n.propsProxy || Object.keys(n.propsProxy).length === 0);
		if (allLayoutOnly && t.chain.length > 3) {
			parts.push(`\u{1F4A1} Chain type: layout-only (no data attributes) - may be over-wrapped`);
		} else if (hasDataAttrs) {
			parts.push(`\u{1F4A1} Chain type: data-carrying (has data attributes)`);
		}

		// Insight about deep nesting
		if (t.chain.length > 5) {
			parts.push(`\n\u{1F4A1} INSIGHT:`);
			parts.push(`  Deep nesting (${t.chain.length} levels). Consider:`);
			parts.push(`  - Using Context API to avoid prop drilling`);
			parts.push(`  - Using stores for shared state`);
		}

		return parts.join('\n');
	}

	function handleClick(event: MouseEvent) {
		// Double-click with modifier for props tracer
		if (!checkModifier(event, modifier)) return;
		if (!event.detail || event.detail < 2) return; // require double-click

		event.preventDefault();
		event.stopPropagation();

		const target = event.target as HTMLElement;
		const svelteEl = findSvelteElement(target);
		if (!svelteEl) {
			const tag = target.tagName?.toLowerCase() || 'unknown';
			console.log(`[SveltePropsTracer] No Svelte component found for <${tag}>. This element may be plain HTML, rendered by a third-party library, or outside Svelte's component tree. Try clicking a parent element.`);
			return;
		}

		trace = buildTrace(svelteEl);
		const formatted = formatForAgent(trace);
		registerToolOutput('PropsTracer', formatted);
		copyFb.copy(formatted);

		console.log('[SveltePropsTracer] Component trace:\n' + formatted);
		if (showPopup) visible = true;
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && visible) visible = false;
	}

	const mount = useDevtoolMount(() => forceEnable, () => {
		document.addEventListener('dblclick', handleClick, true);
		document.addEventListener('keydown', handleKeydown);
		return () => {
			document.removeEventListener('dblclick', handleClick, true);
			document.removeEventListener('keydown', handleKeydown);
		};
	}, {
		onDev: () => {
			isDev = true;
			const modLabel = modifier.charAt(0).toUpperCase() + modifier.slice(1);
			console.log(`[SveltePropsTracer] Active! ${modLabel}+DoubleClick to trace component hierarchy`);
		}
	});

	onMount(mount.start);
	onDestroy(() => {
		mount.stop();
		copyFb.reset();
	});
</script>

{#if isDev && showPopup && trace}
	<DevToolPopup
		title="PropsTracer"
		bind:visible
		{colors}
		titleColor="#34d399"
		{copied}
		{copyFailed}
		ariaLabel="SveltePropsTracer"
		minWidth={380}
	>
		{#snippet headerExtra()}
			<span class="sg-trace-element">{trace?.elementPreview}</span>
		{/snippet}

		<div class="sg-trace-content">
			<div class="sg-trace-chain">
				{#each trace.chain as node, i (`${node.file}:${node.line}`)}
					<div class="sg-trace-node" class:sg-trace-node-current={i === 0}>
						<div class="sg-trace-depth">{i === 0 ? '◉' : '○'}</div>
						<div class="sg-trace-node-info">
							<span class="sg-trace-component">&lt;{node.componentName || 'element'}&gt;</span>
							<span class="sg-trace-file">{shortenPath(node.file)}:{node.line}</span>
							{#if node.propsProxy && Object.keys(node.propsProxy).length > 0}
								<span class="sg-trace-attrs">{Object.entries(node.propsProxy).map(([k, v]) => `${k}="${v}"`).join(' ')}</span>
							{/if}
							{#if i === 0}
								<span class="sg-trace-marker">← target</span>
							{/if}
						</div>
					</div>
					{#if i < trace.chain.length - 1}
						<div class="sg-trace-connector">│</div>
					{/if}
				{/each}
			</div>

			<div class="sg-trace-summary">
				🌳 {trace.chain.length} component{trace.chain.length !== 1 ? 's' : ''} in hierarchy
				{#if trace.chain.length > 5}
					<span class="sg-trace-warning">⚠️ Deep nesting - consider Context API or stores</span>
				{/if}
			</div>
		</div>

		{#snippet footer()}
			<DevToolButton
				onclick={() => {
					if (trace) copyFb.copy(formatForAgent(trace));
				}}
			>Copy for Agent</DevToolButton>
		{/snippet}
	</DevToolPopup>
{/if}

<style>
	.sg-trace-element {
		color: #60a5fa;
		font-size: 11px;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sg-trace-content { padding: 12px; }

	.sg-trace-chain { padding: 0 8px; }

	.sg-trace-node {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 0;
	}
	.sg-trace-node-current {
		background: rgba(52, 211, 153, 0.1);
		border-radius: 4px;
		padding: 6px 8px;
		margin: 0 -8px;
	}

	.sg-trace-depth {
		color: #34d399;
		font-size: 14px;
		flex-shrink: 0;
		width: 20px;
		text-align: center;
	}

	.sg-trace-node-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.sg-trace-component { color: #60a5fa; font-weight: 600; }
	.sg-trace-file { color: #888; font-size: 10px; }
	.sg-trace-attrs {
		color: #fbbf24; font-size: 9px;
		max-width: 300px; overflow: hidden;
		text-overflow: ellipsis; white-space: nowrap;
	}
	.sg-trace-marker {
		color: #34d399;
		font-size: 10px;
		font-weight: 600;
	}

	.sg-trace-connector {
		padding-left: 9px;
		color: #4a4a6a;
		font-size: 14px;
		line-height: 1;
	}

	.sg-trace-summary {
		margin-top: 12px;
		padding: 8px 12px;
		background: rgba(255, 255, 255, 0.03);
		border-radius: 4px;
		font-size: 11px;
		color: #888;
	}

	.sg-trace-warning {
		display: block;
		color: #fbbf24;
		margin-top: 4px;
		font-size: 10px;
	}
</style>
