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
		getElementPreview
	} from './utils/shared.js';

	let {
		modifier = 'alt',
		secondaryModifier = 'shift',
		forceEnable = false,
		showPopup = true,
		theme = {},
		lightTheme = false
	}: SveltePropsTracerProps = $props();

	let baseTheme = $derived(lightTheme ? { background: '#ffffff', border: '#e0e0e0', text: '#1a1a2e', accent: '#e85d04' } : { background: '#1a1a2e', border: '#4a4a6a', text: '#e0e0e0', accent: '#ff6b35' });
	let colors = $derived({ ...baseTheme, ...theme } as Required<ThemeConfig>);

	let isDev = $state(false);
	let visible = $state(false);
	let copied = $state(false);
	let trace = $state<PropTrace | null>(null);

	/**
	 * Build the component hierarchy trace by walking __svelte_meta.parent chain
	 */
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
					depth: 0
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
						depth
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
			`=== Trace de Props: ${t.elementPreview} ===\n`,
			`\u{1F4CD} CADEIA DE COMPONENTES:\n`
		];

		for (let i = t.chain.length - 1; i >= 0; i--) {
			const node = t.chain[i];
			const name = node.componentName || 'element';
			const file = shortenPath(node.file);
			const marker = i === 0 ? ' \u2190 VOC\u00CA EST\u00C1 AQUI' : '';

			parts.push(`  [${t.chain.length - i}] ${file}:${node.line}${marker}`);
			parts.push(`      \u2502 <${name}>`);

			if (i > 0) {
				parts.push(`      \u2193`);
			}
		}

		parts.push('');
		parts.push(`\u{1F333} Profundidade: ${t.chain.length} componente${t.chain.length !== 1 ? 's' : ''}`);

		// Insight about deep nesting
		if (t.chain.length > 5) {
			parts.push(`\n\u{1F4A1} INSIGHT:`);
			parts.push(`  Nesting profundo (${t.chain.length} n\u00EDveis). Considere:`);
			parts.push(`  - Usar Context API para evitar prop drilling`);
			parts.push(`  - Usar stores para estado compartilhado`);
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
			console.log('[SveltePropsTracer] No Svelte component found');
			return;
		}

		trace = buildTrace(svelteEl);
		const formatted = formatForAgent(trace);
		copyToClipboard(formatted).then(ok => {
			if (ok) { copied = true; setTimeout(() => (copied = false), 1500); }
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
