<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { SvelteStyleGrabProps, StyleCategory, StyleConflict, ThemeConfig } from './types.js';
	import {
		detectDevMode,
		findSvelteElement,
		shortenPath,
		copyToClipboard,
		checkModifier
	} from './utils/shared.js';
	import type { SvelteElement } from './utils/shared.js';
	import { analyzeStyles, formatStylesForAgent } from './utils/css-analyzer.js';

	let {
		modifier = 'alt',
		secondaryModifier = 'ctrl',
		forceEnable = false,
		showPopup = true,
		theme = {},
		lightTheme = false,
		showCategories = ['all']
	}: SvelteStyleGrabProps = $props();

	let baseTheme = $derived(lightTheme ? { background: '#ffffff', border: '#e0e0e0', text: '#1a1a2e', accent: '#e85d04' } : { background: '#1a1a2e', border: '#4a4a6a', text: '#e0e0e0', accent: '#ff6b35' });
	let colors = $derived({ ...baseTheme, ...theme } as Required<ThemeConfig>);

	let isDev = $state(false);
	let visible = $state(false);
	let copied = $state(false);
	let categories = $state<StyleCategory[]>([]);
	let conflicts = $state<StyleConflict[]>([]);
	let elementTag = $state('');
	let elementFile = $state<string | undefined>();
	let elementLine = $state<number | undefined>();
	let activeCategory = $state<string | null>(null);
	let showConflicts = $state(false);

	function handleClick(event: MouseEvent) {
		if (!checkModifier(event, modifier)) return;
		// Require Ctrl as secondary (not Shift which is StateGrab)
		if (secondaryModifier === 'ctrl' && !event.ctrlKey) return;
		if (secondaryModifier === 'meta' && !event.metaKey) return;
		if (secondaryModifier === 'shift' && !event.shiftKey) return;

		event.preventDefault();
		event.stopPropagation();

		const target = event.target as HTMLElement;
		const svelteEl = findSvelteElement(target) || target;

		const tag = svelteEl.tagName.toLowerCase();
		const cls = svelteEl.className ? ` class="${String(svelteEl.className).slice(0, 40)}"` : '';
		elementTag = `<${tag}${cls}>`;

		const meta = (svelteEl as SvelteElement).__svelte_meta;
		elementFile = meta?.loc ? shortenPath(meta.loc.file) : undefined;
		elementLine = meta?.loc?.line;

		const result = analyzeStyles(svelteEl);
		categories = result.categories;
		conflicts = result.conflicts;
		activeCategory = categories.length > 0 ? categories[0].name : null;

		const formatted = formatStylesForAgent(svelteEl, categories, conflicts, elementFile, elementLine);
		copyToClipboard(formatted).then(ok => {
			if (ok) { copied = true; setTimeout(() => (copied = false), 1500); }
		});

		console.log('[SvelteStyleGrab] Styles captured:\n' + formatted);

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

			console.log(`[SvelteStyleGrab] Active! Use ${modifier.charAt(0).toUpperCase() + modifier.slice(1)}+${secondaryModifier.charAt(0).toUpperCase() + secondaryModifier.slice(1)}+Click to inspect styles`);

			document.addEventListener('click', handleClick, true);
			document.addEventListener('keydown', handleKeydown);
			cleanup = () => {
				document.removeEventListener('click', handleClick, true);
				document.removeEventListener('keydown', handleKeydown);
			};
		}, 100);
	});

	onDestroy(() => cleanup?.());
</script>

{#if isDev && showPopup && visible}
	<div
		class="sg-style-overlay"
		onclick={() => (visible = false)}
		onkeydown={(e) => e.key === 'Escape' && (visible = false)}
		role="presentation"
	>
		<div
			class="sg-style-popup"
			style="
				--sg-bg: {colors.background};
				--sg-border: {colors.border};
				--sg-text: {colors.text};
				--sg-accent: {colors.accent};
			"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			aria-label="SvelteStyleGrab inspector"
			tabindex="-1"
		>
			<div class="sg-style-header">
				<span class="sg-style-title">StyleGrab</span>
				<span class="sg-style-element">{elementTag}</span>
				{#if copied}
					<span class="sg-style-copied">Copied!</span>
				{/if}
				<button class="sg-style-close" onclick={() => (visible = false)} aria-label="Close">&times;</button>
			</div>

			{#if elementFile}
				<div class="sg-style-location">{elementFile}{elementLine ? ':' + elementLine : ''}</div>
			{/if}

			<!-- Category tabs -->
			<div class="sg-style-tabs">
				{#each categories as cat}
					<button
						class="sg-style-tab"
						class:sg-style-tab-active={activeCategory === cat.name}
						onclick={() => (activeCategory = cat.name)}
					>
						{cat.icon} {cat.name}
					</button>
				{/each}
				{#if conflicts.length > 0}
					<button
						class="sg-style-tab sg-style-tab-conflict"
						class:sg-style-tab-active={showConflicts}
						onclick={() => { showConflicts = !showConflicts; if (showConflicts) activeCategory = null; }}
					>
						⚠️ Conflicts ({conflicts.length})
					</button>
				{/if}
			</div>

			<div class="sg-style-content">
				{#if showConflicts}
					{#each conflicts as conflict}
						<div class="sg-style-conflict">
							<div class="sg-style-conflict-prop">{conflict.property}</div>
							{#each conflict.rules as rule}
								<div class="sg-style-conflict-rule" class:sg-style-conflict-won={rule.won}>
									<span class="sg-style-conflict-status">{rule.won ? '✅' : '❌'}</span>
									<span class="sg-style-conflict-selector">{rule.selector}</span>
									<span class="sg-style-conflict-value">{rule.value}</span>
									<span class="sg-style-conflict-spec">[{rule.specificity.join(',')}]</span>
								</div>
							{/each}
						</div>
					{/each}
				{:else}
					{#each categories.filter(c => c.name === activeCategory) as cat}
						{#each cat.properties as prop}
							<div class="sg-style-prop" class:sg-style-prop-overridden={prop.isOverridden}>
								<span class="sg-style-prop-name">{prop.name}</span>
								<span class="sg-style-prop-value">{prop.value}</span>
								<span class="sg-style-prop-source sg-style-source-{prop.source.type}">
									{#if prop.source.type === 'inline'}inline
									{:else if prop.source.type === 'svelte-scoped'}scoped
									{:else if prop.source.type === 'tailwind'}tw
									{:else if prop.source.type === 'stylesheet'}css
									{:else if prop.source.type === 'inherited'}inherit
									{:else}ua{/if}
								</span>
							</div>
						{/each}
					{/each}
				{/if}
			</div>

			<div class="sg-style-footer">
				<button
					class="sg-style-btn"
					onclick={() => {
						const el = document.querySelector('[class*="sg-style-"]')?.closest('[role="dialog"]')?.parentElement;
						const text = formatStylesForAgent(
							document.createElement('div'),
							categories,
							conflicts,
							elementFile,
							elementLine
						);
						copyToClipboard(text).then(ok => {
							if (ok) { copied = true; setTimeout(() => (copied = false), 1500); }
						});
					}}
				>Copy for Agent</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.sg-style-overlay {
		position: fixed;
		inset: 0;
		z-index: 99999;
		background: rgba(0, 0, 0, 0.3);
	}

	.sg-style-popup {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		background: var(--sg-bg);
		border: 1px solid var(--sg-border);
		border-radius: 8px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
		min-width: 400px;
		max-width: 650px;
		max-height: 500px;
		overflow: hidden;
		font-family: ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
		font-size: 12px;
		color: var(--sg-text);
		display: flex;
		flex-direction: column;
	}

	.sg-style-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
		border-bottom: 1px solid var(--sg-border);
	}

	.sg-style-title { color: #f472b6; font-weight: 600; }

	.sg-style-element {
		color: #60a5fa;
		font-size: 11px;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sg-style-copied { color: #4ade80; font-size: 11px; }

	.sg-style-close {
		background: none;
		border: none;
		color: #888;
		cursor: pointer;
		padding: 2px 6px;
		font-size: 14px;
		border-radius: 4px;
	}
	.sg-style-close:hover { color: #fff; background: rgba(255, 255, 255, 0.1); }

	.sg-style-location {
		padding: 4px 12px;
		font-size: 10px;
		color: #888;
		background: color-mix(in srgb, var(--sg-bg) 50%, black 10%);
	}

	.sg-style-tabs {
		display: flex;
		gap: 2px;
		padding: 4px 8px;
		border-bottom: 1px solid var(--sg-border);
		overflow-x: auto;
	}

	.sg-style-tab {
		padding: 4px 8px;
		background: none;
		border: none;
		border-radius: 4px;
		color: #888;
		cursor: pointer;
		font-family: inherit;
		font-size: 10px;
		white-space: nowrap;
	}
	.sg-style-tab:hover { color: var(--sg-text); background: rgba(255, 255, 255, 0.05); }
	.sg-style-tab-active { color: var(--sg-accent); background: rgba(255, 255, 255, 0.1); }
	.sg-style-tab-conflict { color: #fbbf24; }

	.sg-style-content {
		flex: 1;
		overflow-y: auto;
		padding: 4px 0;
	}

	.sg-style-prop {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 3px 12px;
		font-size: 11px;
	}
	.sg-style-prop:hover { background: rgba(255, 255, 255, 0.03); }
	.sg-style-prop-overridden { opacity: 0.5; text-decoration: line-through; }

	.sg-style-prop-name { color: #60a5fa; min-width: 140px; flex-shrink: 0; }
	.sg-style-prop-value { flex: 1; color: #fbbf24; word-break: break-all; }

	.sg-style-prop-source {
		font-size: 9px;
		padding: 1px 4px;
		border-radius: 3px;
		flex-shrink: 0;
	}
	.sg-style-source-inline { background: rgba(251, 191, 36, 0.2); color: #fbbf24; }
	.sg-style-source-svelte-scoped { background: rgba(244, 114, 182, 0.2); color: #f472b6; }
	.sg-style-source-tailwind { background: rgba(56, 189, 248, 0.2); color: #38bdf8; }
	.sg-style-source-stylesheet { background: rgba(96, 165, 250, 0.2); color: #60a5fa; }
	.sg-style-source-inherited { background: rgba(167, 139, 250, 0.2); color: #a78bfa; }
	.sg-style-source-user-agent { background: rgba(136, 136, 136, 0.2); color: #888; }

	.sg-style-conflict {
		padding: 8px 12px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.05);
	}
	.sg-style-conflict-prop { color: #fbbf24; font-weight: 600; margin-bottom: 4px; }

	.sg-style-conflict-rule {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 2px 0;
		font-size: 11px;
		opacity: 0.6;
	}
	.sg-style-conflict-won { opacity: 1; }
	.sg-style-conflict-status { font-size: 10px; }
	.sg-style-conflict-selector { color: #60a5fa; flex: 1; }
	.sg-style-conflict-value { color: #fbbf24; }
	.sg-style-conflict-spec { color: #888; font-size: 9px; }

	.sg-style-footer {
		display: flex;
		gap: 8px;
		padding: 8px 12px;
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
		border-top: 1px solid var(--sg-border);
	}

	.sg-style-btn {
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
	.sg-style-btn:hover { background: rgba(255, 255, 255, 0.15); }
</style>
