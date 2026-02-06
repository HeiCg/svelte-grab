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
	import type { SvelteDevKitProps, DevKitTool, ThemeConfig } from './types.js';
	import SvelteGrab from './SvelteGrab.svelte';
	import SvelteStateGrab from './SvelteStateGrab.svelte';
	import SvelteStyleGrab from './SvelteStyleGrab.svelte';
	import SveltePropsTracer from './SveltePropsTracer.svelte';
	import SvelteA11yReporter from './SvelteA11yReporter.svelte';
	import SvelteErrorContext from './SvelteErrorContext.svelte';
	import SvelteRenderProfiler from './SvelteRenderProfiler.svelte';

	let {
		modifier = 'alt',
		forceEnable = false,
		theme = {},
		lightTheme = false,
		enabledTools = ['grab', 'state', 'style', 'props', 'a11y', 'errors', 'profiler'],
		editor = 'vscode',
		projectRoot = '',
		// New feature props forwarded to SvelteGrab
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
		mcpPort = 4723
	}: SvelteDevKitProps = $props();

	function isEnabled(tool: DevKitTool): boolean {
		return enabledTools.includes(tool);
	}
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
	/>
{/if}

{#if isEnabled('state')}
	<SvelteStateGrab
		{modifier}
		secondaryModifier="shift"
		{forceEnable}
		{theme}
		{lightTheme}
	/>
{/if}

{#if isEnabled('style')}
	<SvelteStyleGrab
		{modifier}
		secondaryModifier="ctrl"
		{forceEnable}
		{theme}
		{lightTheme}
	/>
{/if}

{#if isEnabled('props')}
	<SveltePropsTracer
		{modifier}
		{forceEnable}
		{theme}
		{lightTheme}
	/>
{/if}

{#if isEnabled('a11y')}
	<SvelteA11yReporter
		{modifier}
		{forceEnable}
		{theme}
		{lightTheme}
	/>
{/if}

{#if isEnabled('errors')}
	<SvelteErrorContext
		{modifier}
		{forceEnable}
		{theme}
		{lightTheme}
	/>
{/if}

{#if isEnabled('profiler')}
	<SvelteRenderProfiler
		{modifier}
		{forceEnable}
		{theme}
		{lightTheme}
	/>
{/if}
