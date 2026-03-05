<script lang="ts">
	/**
	 * SvelteDevKit - Unified component that combines all dev tools.
	 *
	 * Usage:
	 *   <SvelteDevKit />
	 *
	 * This is a convenience wrapper that includes:
	 * - SvelteGrab (Alt+Click for component location)
	 * - SvelteStateGrab (Alt+Shift+Click for component state)
	 * - SvelteStyleGrab (Alt+Ctrl+Click for computed styles)
	 * - SveltePropsTracer (Alt+DoubleClick for component hierarchy)
	 * - SvelteA11yReporter (Alt+RightClick or Alt+A for accessibility)
	 * - SvelteErrorContext (Alt+E for captured errors)
	 * - SvelteRenderProfiler (Alt+P for render profiling)
	 */
	import { onMount, onDestroy } from 'svelte';
	import type { SvelteDevKitProps, DevKitTool, ThemeConfig } from './types.js';
	// All tool components are imported here, but only mounted when enabled via
	// {#if isEnabled('tool')}. Disabled tools are never mounted, so their event
	// listeners and observers are never registered. The import/parse cost is
	// negligible for dev-only components — no further tree-shaking is needed.
	import SvelteGrab from './SvelteGrab.svelte';
	import SvelteStateGrab from './SvelteStateGrab.svelte';
	import SvelteStyleGrab from './SvelteStyleGrab.svelte';
	import SveltePropsTracer from './SveltePropsTracer.svelte';
	import SvelteA11yReporter from './SvelteA11yReporter.svelte';
	import SvelteErrorContext from './SvelteErrorContext.svelte';
	import SvelteRenderProfiler from './SvelteRenderProfiler.svelte';
	import { formatUnifiedExport } from './utils/unified-export.js';
	import { copyToClipboard, detectDevMode, checkModifier, DARK_THEME, LIGHT_THEME } from './utils/shared.js';

	let {
		modifier = 'alt',
		forceEnable = false,
		theme = {},
		lightTheme = false,
		enabledTools = ['grab', 'state', 'style', 'props', 'a11y', 'errors', 'profiler'],
		editor = 'vscode',
		projectRoot = '',
		// SvelteGrab feature props
		plugins = [],
		activationMode = 'hold',
		showToolbar = false,
		showContextMenu = true,
		enableAgentRelay = false,
		agentRelayUrl = 'ws://localhost:4722',
		agentId = 'claude-code',
		enableArrowNav = true,
		enableDragSelect = true,
		enableMcp = false,
		mcpPort = 4723,
		freezeAnimations = true,
		freezePseudoStates = true,
		enableHistoryPersistence = true,
		enablePromptMode = true,
		// SvelteGrab props forwarding
		autoCopyFormat = 'agent',
		showPopup = true,
		includeHtml = true,
		copyOnKeyboard = true,
		enableScreenshot = true,
		enableMultiSelect = true,
		showActiveIndicator = true,
		maxHistorySize = 20,
		// Sub-tool config props
		stateSecondaryModifier = 'shift',
		styleSecondaryModifier = 'ctrl',
		maxSnapshots = 5,
		profileDuration = 10,
		burstThreshold = 20,
		burstWindow = 1000,
		maxErrors = 50,
		bufferMinutes = 5,
		filterNodeModules = true,
		showCategories = ['all'] as ('box-model' | 'visual' | 'typography' | 'layout' | 'all')[],
		includeSubtree = true
	}: SvelteDevKitProps = $props();

	let baseTheme = $derived(lightTheme ? LIGHT_THEME : DARK_THEME);
	let colors = $derived({ ...baseTheme, ...theme } as Required<ThemeConfig>);

	function isEnabled(tool: DevKitTool): boolean {
		return enabledTools.includes(tool);
	}

	let isDev = $state(false);
	let showHelp = $state(false);
	let copyAllCleanup: (() => void) | null = null;

	let modLabel = $derived(modifier.charAt(0).toUpperCase() + modifier.slice(1));

	// Build shortcuts list based on enabled tools
	let shortcuts = $derived.by(() => {
		const list: { keys: string; description: string }[] = [];
		if (isEnabled('grab')) list.push({ keys: `${modLabel}+Click`, description: 'Component Inspector' });
		if (isEnabled('state')) list.push({ keys: `${modLabel}+${stateSecondaryModifier.charAt(0).toUpperCase() + stateSecondaryModifier.slice(1)}+Click`, description: 'State Inspector' });
		if (isEnabled('style')) list.push({ keys: `${modLabel}+${styleSecondaryModifier.charAt(0).toUpperCase() + styleSecondaryModifier.slice(1)}+Click`, description: 'Style Inspector' });
		if (isEnabled('props')) list.push({ keys: `${modLabel}+DoubleClick`, description: 'Props Tracer' });
		if (isEnabled('a11y')) {
			list.push({ keys: `${modLabel}+RightClick`, description: 'A11y Report (element)' });
			list.push({ keys: `${modLabel}+A`, description: 'A11y Report (full page)' });
		}
		if (isEnabled('errors')) list.push({ keys: `${modLabel}+E`, description: 'Error Context' });
		if (isEnabled('profiler')) list.push({ keys: `${modLabel}+P`, description: 'Render Profiler' });
		list.push({ keys: `${modLabel}+Shift+C`, description: 'Copy All Context' });
		list.push({ keys: `${modLabel}+?`, description: 'Toggle Help' });
		return list;
	});

	onMount(() => {
		setTimeout(() => {
			isDev = detectDevMode(forceEnable);
			if (!isDev) return;

			function handleDevKitKeys(event: KeyboardEvent) {
				if (!checkModifier(event, modifier)) return;

				// Alt+Shift+C: Copy all context
				if (event.shiftKey && (event.key === 'c' || event.key === 'C')) {
					event.preventDefault();
					const unified = formatUnifiedExport();
					copyToClipboard(unified).then(ok => {
						if (ok) {
							console.log('[SvelteDevKit] All context copied to clipboard');
						}
					});
					console.log('[SvelteDevKit] Unified export:\n' + unified);
					return;
				}

				// Alt+? or Alt+/: Toggle help overlay
				if (event.key === '?' || event.key === '/') {
					event.preventDefault();
					showHelp = !showHelp;
					return;
				}
			}

			document.addEventListener('keydown', handleDevKitKeys);
			copyAllCleanup = () => document.removeEventListener('keydown', handleDevKitKeys);

			console.log(`[SvelteDevKit] ${modLabel}+Shift+C to copy all | ${modLabel}+? for help`);
		}, 100);
	});

	onDestroy(() => copyAllCleanup?.());
</script>

{#if isEnabled('grab')}
	<SvelteGrab
		{modifier}
		{forceEnable}
		{theme}
		{lightTheme}
		{editor}
		{projectRoot}
		{plugins}
		{activationMode}
		{showToolbar}
		{showContextMenu}
		{enableAgentRelay}
		{agentRelayUrl}
		{agentId}
		{enableArrowNav}
		{enableDragSelect}
		{enableMcp}
		{mcpPort}
		{autoCopyFormat}
		{showPopup}
		{includeHtml}
		{copyOnKeyboard}
		{enableScreenshot}
		{enableMultiSelect}
		{showActiveIndicator}
		{maxHistorySize}
		{freezeAnimations}
		{freezePseudoStates}
		{enableHistoryPersistence}
		{enablePromptMode}
	/>
{/if}

{#if isEnabled('state')}
	<SvelteStateGrab
		{modifier}
		secondaryModifier={stateSecondaryModifier}
		{forceEnable}
		showPopup={showPopup}
		{theme}
		{lightTheme}
		{maxSnapshots}
	/>
{/if}

{#if isEnabled('style')}
	<SvelteStyleGrab
		{modifier}
		secondaryModifier={styleSecondaryModifier}
		{forceEnable}
		showPopup={showPopup}
		{theme}
		{lightTheme}
		{showCategories}
	/>
{/if}

{#if isEnabled('props')}
	<SveltePropsTracer
		{modifier}
		{forceEnable}
		showPopup={showPopup}
		{theme}
		{lightTheme}
	/>
{/if}

{#if isEnabled('a11y')}
	<SvelteA11yReporter
		{modifier}
		{forceEnable}
		showPopup={showPopup}
		{theme}
		{lightTheme}
		{includeSubtree}
	/>
{/if}

{#if isEnabled('errors')}
	<SvelteErrorContext
		{modifier}
		{forceEnable}
		showPopup={showPopup}
		{theme}
		{lightTheme}
		{maxErrors}
		{bufferMinutes}
		{filterNodeModules}
	/>
{/if}

{#if isEnabled('profiler')}
	<SvelteRenderProfiler
		{modifier}
		{forceEnable}
		showPopup={showPopup}
		{theme}
		{lightTheme}
		{profileDuration}
		{burstThreshold}
		{burstWindow}
	/>
{/if}

{#if isDev && showHelp}
	<div
		class="sg-help-overlay"
		onclick={() => (showHelp = false)}
		onkeydown={(e) => e.key === 'Escape' && (showHelp = false)}
		role="presentation"
	>
		<div
			class="sg-help-popup"
			style="
				--sg-bg: {colors.background};
				--sg-border: {colors.border};
				--sg-text: {colors.text};
				--sg-accent: {colors.accent};
			"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			aria-label="SvelteDevKit Keyboard Shortcuts"
			tabindex="-1"
		>
			<div class="sg-help-header">
				<span class="sg-help-title">SvelteDevKit Shortcuts</span>
				<button class="sg-help-close" onclick={() => (showHelp = false)} aria-label="Close">&times;</button>
			</div>
			<div class="sg-help-content">
				<table class="sg-help-table">
					<thead>
						<tr>
							<th class="sg-help-th">Shortcut</th>
							<th class="sg-help-th">Tool</th>
						</tr>
					</thead>
					<tbody>
						{#each shortcuts as shortcut}
							<tr class="sg-help-row">
								<td class="sg-help-keys"><kbd>{shortcut.keys}</kbd></td>
								<td class="sg-help-desc">{shortcut.description}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<div class="sg-help-footer">
				Press {modLabel}+? to close
			</div>
		</div>
	</div>
{/if}

<style>
	.sg-help-overlay {
		position: fixed; inset: 0; z-index: 99999; background: rgba(0, 0, 0, 0.3);
	}

	.sg-help-popup {
		position: fixed; top: 50%; left: 50%;
		transform: translate(-50%, -50%);
		background: var(--sg-bg); border: 1px solid var(--sg-border);
		border-radius: 8px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
		min-width: 340px; max-width: 500px;
		overflow: hidden;
		font-family: ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
		font-size: 12px; color: var(--sg-text);
		display: flex; flex-direction: column;
	}

	.sg-help-header {
		display: flex; align-items: center; gap: 8px; padding: 10px 14px;
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
		border-bottom: 1px solid var(--sg-border);
	}

	.sg-help-title { color: var(--sg-accent); font-weight: 600; flex: 1; }

	.sg-help-close {
		background: none; border: none; color: #888; cursor: pointer;
		padding: 2px 6px; font-size: 14px; border-radius: 4px;
	}
	.sg-help-close:hover { color: #fff; background: rgba(255, 255, 255, 0.1); }

	.sg-help-content { padding: 8px 14px; }

	.sg-help-table { width: 100%; border-collapse: collapse; }
	.sg-help-th { text-align: left; padding: 4px 0; color: #888; font-size: 10px; font-weight: 600; text-transform: uppercase; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }

	.sg-help-row td { padding: 6px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.03); }
	.sg-help-keys kbd {
		background: rgba(255, 255, 255, 0.1); padding: 2px 6px;
		border-radius: 3px; font-size: 11px; font-family: inherit;
		border: 1px solid rgba(255, 255, 255, 0.15);
	}
	.sg-help-desc { color: #ccc; padding-left: 12px; }

	.sg-help-footer {
		padding: 8px 14px; text-align: center; color: #888; font-size: 10px;
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
		border-top: 1px solid var(--sg-border);
	}
</style>
