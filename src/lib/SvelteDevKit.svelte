<script lang="ts">
	/**
	 * SvelteDevKit - Unified component that combines all dev tools.
	 *
	 * Usage:
	 *   <SvelteDevKit />
	 *
	 * This is a convenience wrapper that includes:
	 * - SvelteGrab (Alt+Click for component location)
	 * - SvelteStateGrab (Alt+Meta+Click for component state; Alt+Shift+Click when
 *   SvelteGrab multi-select is off, since Shift+Alt+Click is multi-select)
	 * - SvelteStyleGrab (Alt+Ctrl+Click for computed styles)
	 * - SveltePropsTracer (Alt+DoubleClick for component hierarchy)
	 * - SvelteA11yReporter (Alt+RightClick or Alt+A for accessibility)
	 * - SvelteErrorContext (Alt+E for captured errors)
	 * - SvelteRenderProfiler (Alt+P for render profiling)
	 *
	 * `hotkeys="minimal"` keeps only Alt+Click, Shift+Alt+Click, Alt+Drag, Escape
	 * and N (annotate); the other tools stay mounted with their triggers off.
	 */
	import { onMount, onDestroy } from 'svelte';
	import type { SvelteDevKitProps, DevKitTool } from './types.js';
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
	import { copyToClipboard, checkModifier } from './utils/shared.js';
	import DevToolPopup from './ui/DevToolPopup.svelte';
	import { resolveTheme } from './utils/resolve-theme.js';
	import { useDevtoolMount } from './utils/use-devtool-mount.svelte.js';
	import { ANNOTATION_KEY_LABEL, toolHotkeysEnabled } from './utils/hotkeys.js';

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
		mcpToken,
		enableAgentRuntime = true,
		freezeAnimations = true,
		freezePseudoStates = true,
		enableHistoryPersistence = true,
		enablePromptMode = true,
		enableAnnotations = true,
		hotkeys = 'full',
		// SvelteGrab props forwarding
		autoCopyFormat = 'agent',
		showPopup = true,
		includeHtml = true,
		copyOnKeyboard = true,
		enableScreenshot = true,
		screenshotSkipFonts = true,
		screenshotPixelRatio,
		enableMultiSelect = true,
		showActiveIndicator = true,
		maxHistorySize = 20,
		// Sub-tool config props
		stateSecondaryModifier,
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

	let colors = $derived(resolveTheme(theme, lightTheme));

	function isEnabled(tool: DevKitTool): boolean {
		return enabledTools.includes(tool);
	}

	let isDev = $state(false);
	let showHelp = $state(false);

	let modLabel = $derived(modifier.charAt(0).toUpperCase() + modifier.slice(1));

	// 'minimal' turns off every trigger except SvelteGrab's point/multi/region/annotate.
	let toolHotkeys = $derived(toolHotkeysEnabled(hotkeys));

	// StateGrab's standalone trigger (Alt+Shift+Click) is SvelteGrab's multi-select
	// (Shift+Alt+Click): both fire, and the StateGrab popup blocks the next click.
	// When both tools are mounted with multi-select on, default StateGrab to
	// Alt+Meta+Click (Ctrl is StyleGrab's). An explicit stateSecondaryModifier wins.
	let stateModifier = $derived<'shift' | 'ctrl' | 'meta'>(
		stateSecondaryModifier ??
			(isEnabled('grab') && enableMultiSelect && modifier !== 'meta' ? 'meta' : 'shift')
	);

	// Build shortcuts list based on enabled tools
	let shortcuts = $derived.by(() => {
		const list: { keys: string; description: string }[] = [];
		if (isEnabled('grab')) list.push({ keys: `${modLabel}+Click`, description: 'Component Inspector' });
		if (isEnabled('grab') && enableMultiSelect) list.push({ keys: `Shift+${modLabel}+Click`, description: 'Multi-select' });
		if (isEnabled('grab') && enableDragSelect) list.push({ keys: `${modLabel}+Drag`, description: 'Region select' });
		if (isEnabled('grab') && enableAnnotations) {
			list.push({ keys: `${modLabel} held + ${ANNOTATION_KEY_LABEL}`, description: 'Annotate selection' });
		}
		if (!toolHotkeys) return list;
		if (isEnabled('state')) list.push({ keys: `${modLabel}+${stateModifier.charAt(0).toUpperCase() + stateModifier.slice(1)}+Click`, description: 'State Inspector' });
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

	function handleDevKitKeys(event: KeyboardEvent) {
		if (!toolHotkeys) return;
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

	const mount = useDevtoolMount(() => forceEnable, () => {
		document.addEventListener('keydown', handleDevKitKeys);
		return () => document.removeEventListener('keydown', handleDevKitKeys);
	}, {
		onDev: () => {
			isDev = true;
			console.log(`[SvelteDevKit] ${modLabel}+Shift+C to copy all | ${modLabel}+? for help`);
		}
	});

	onMount(mount.start);
	onDestroy(mount.stop);
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
		{mcpToken}
		{enableAgentRuntime}
		{autoCopyFormat}
		{showPopup}
		{includeHtml}
		{copyOnKeyboard}
		{enableScreenshot}
		{screenshotSkipFonts}
		{screenshotPixelRatio}
		{enableMultiSelect}
		{showActiveIndicator}
		{maxHistorySize}
		{freezeAnimations}
		{freezePseudoStates}
		{enableHistoryPersistence}
		{enablePromptMode}
		{enableAnnotations}
		{hotkeys}
	/>
{/if}

{#if isEnabled('state')}
	<SvelteStateGrab
		{modifier}
		enableHotkeys={toolHotkeys}
		secondaryModifier={stateModifier}
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
		enableHotkeys={toolHotkeys}
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
		enableHotkeys={toolHotkeys}
		{forceEnable}
		showPopup={showPopup}
		{theme}
		{lightTheme}
	/>
{/if}

{#if isEnabled('a11y')}
	<SvelteA11yReporter
		{modifier}
		enableHotkeys={toolHotkeys}
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
		enableHotkeys={toolHotkeys}
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
		enableHotkeys={toolHotkeys}
		{forceEnable}
		showPopup={showPopup}
		{theme}
		{lightTheme}
		{profileDuration}
		{burstThreshold}
		{burstWindow}
	/>
{/if}

{#if isDev}
	<DevToolPopup
		title="SvelteDevKit Shortcuts"
		bind:visible={showHelp}
		{colors}
		ariaLabel="SvelteDevKit Keyboard Shortcuts"
		minWidth={340}
	>
		<div class="sg-help-content">
			<table class="sg-help-table">
				<thead>
					<tr>
						<th class="sg-help-th">Shortcut</th>
						<th class="sg-help-th">Tool</th>
					</tr>
				</thead>
				<tbody>
					{#each shortcuts as shortcut (shortcut.keys)}
						<tr class="sg-help-row">
							<td class="sg-help-keys"><kbd>{shortcut.keys}</kbd></td>
							<td class="sg-help-desc">{shortcut.description}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#snippet footer()}
			<span class="sg-help-footer-text">Press {modLabel}+? to close</span>
		{/snippet}
	</DevToolPopup>
{/if}

<style>
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

	.sg-help-footer-text {
		flex: 1; text-align: center; color: #888; font-size: 10px;
	}
</style>
