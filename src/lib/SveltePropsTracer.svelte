<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { SveltePropsTracerProps, PropTrace, PropTraceNode, ThemeConfig } from './types.js';
	import type { SvelteElement } from './utils/shared.js';
	import {
		detectDevMode,
		findSvelteElement,
		shortenPath,
		extractComponentName,
		copyToClipboard,
		checkModifier,
		isExcludedPath,
		getElementPreview,
		DARK_THEME,
		LIGHT_THEME
	} from './utils/shared.js';
	import { registerToolOutput } from './utils/unified-export.js';

	let {
		modifier = 'alt',
		secondaryModifier = 'shift',
		forceEnable = false,
		showPopup = true,
		theme = {},
		lightTheme = false
	}: SveltePropsTracerProps = $props();

	let baseTheme = $derived(lightTheme ? LIGHT_THEME : DARK_THEME);
	let colors = $derived({ ...baseTheme, ...theme } as Required<ThemeConfig>);

	let isDev = $state(false);
	let visible = $state(false);
	let copied = $state(false);
	let copyFailed = $state(false);
	let trace = $state<PropTrace | null>(null);

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
		copyToClipboard(formatted).then(ok => {
			if (ok) { copied = true; setTimeout(() => (copied = false), 1500); }
			else { copyFailed = true; setTimeout(() => (copyFailed = false), 3000); }
		});

		console.log('[SveltePropsTracer] Component trace:\n' + formatted);
		if (showPopup) visible = true;
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && visible) visible = false;
	}

	let cleanup: (() => void) | null = null;

	onMount(() => {
		setTimeout(() => {
			isDev = detectDevMode(forceEnable);
			if (!isDev) return;

			const modLabel = modifier.charAt(0).toUpperCase() + modifier.slice(1);
			console.log(`[SveltePropsTracer] Active! ${modLabel}+DoubleClick to trace component hierarchy`);

			document.addEventListener('dblclick', handleClick, true);
			document.addEventListener('keydown', handleKeydown);
			cleanup = () => {
				document.removeEventListener('dblclick', handleClick, true);
				document.removeEventListener('keydown', handleKeydown);
			};
		}, 100);
	});

	onDestroy(() => cleanup?.());
</script>

{#if isDev && showPopup && visible && trace}
	<div
		class="sg-trace-overlay"
		onclick={() => (visible = false)}
		onkeydown={(e) => e.key === 'Escape' && (visible = false)}
		role="presentation"
	>
		<div
			class="sg-trace-popup"
			style="
				--sg-bg: {colors.background};
				--sg-border: {colors.border};
				--sg-text: {colors.text};
				--sg-accent: {colors.accent};
			"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			aria-label="SveltePropsTracer"
			tabindex="-1"
		>
			<div class="sg-trace-header">
				<span class="sg-trace-title">PropsTracer</span>
				<span class="sg-trace-element">{trace.elementPreview}</span>
				{#if copied}<span class="sg-trace-copied">Copied!</span>{/if}
				{#if copyFailed}<span class="sg-trace-copied-failed" style="color: #ef4444; font-size: 11px;">Copy failed</span>{/if}
				<button class="sg-trace-close" onclick={() => (visible = false)} aria-label="Close">&times;</button>
			</div>

			<div class="sg-trace-content">
				<div class="sg-trace-chain">
					{#each trace.chain as node, i}
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

			<div class="sg-trace-footer">
				<button
					class="sg-trace-btn"
					onclick={() => {
						if (trace) copyToClipboard(formatForAgent(trace)).then(ok => {
							if (ok) { copied = true; setTimeout(() => (copied = false), 1500); }
							else { copyFailed = true; setTimeout(() => (copyFailed = false), 3000); }
						});
					}}
				>Copy for Agent</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.sg-trace-overlay {
		position: fixed;
		inset: 0;
		z-index: 99999;
		background: rgba(0, 0, 0, 0.3);
	}

	.sg-trace-popup {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		background: var(--sg-bg);
		border: 1px solid var(--sg-border);
		border-radius: 8px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
		min-width: 380px;
		max-width: 600px;
		max-height: 500px;
		overflow: hidden;
		font-family: ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
		font-size: 12px;
		color: var(--sg-text);
		display: flex;
		flex-direction: column;
	}

	.sg-trace-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
		border-bottom: 1px solid var(--sg-border);
	}

	.sg-trace-title { color: #34d399; font-weight: 600; }

	.sg-trace-element {
		color: #60a5fa;
		font-size: 11px;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sg-trace-copied { color: #4ade80; font-size: 11px; }

	.sg-trace-close {
		background: none; border: none; color: #888; cursor: pointer;
		padding: 2px 6px; font-size: 14px; border-radius: 4px;
	}
	.sg-trace-close:hover { color: #fff; background: rgba(255, 255, 255, 0.1); }

	.sg-trace-content { flex: 1; overflow-y: auto; padding: 12px; }

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

	.sg-trace-footer {
		display: flex;
		gap: 8px;
		padding: 8px 12px;
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
		border-top: 1px solid var(--sg-border);
	}

	.sg-trace-btn {
		flex: 1;
		padding: 6px 12px;
		background: rgba(255, 255, 255, 0.1);
		border: 1px solid var(--sg-border);
		border-radius: 4px;
		color: var(--sg-text);
		cursor: pointer;
		font-size: 11px;
		font-family: inherit;
	}
	.sg-trace-btn:hover { background: rgba(255, 255, 255, 0.15); }
</style>
