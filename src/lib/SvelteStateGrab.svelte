<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type {
		SvelteStateGrabProps,
		ComponentStateInfo,
		StateSnapshot,
		StateDiff
	} from './types.js';
	import type { SvelteElement } from './utils/shared.js';
	import { findSvelteElement, checkModifier } from './utils/shared.js';
	import { safeSerialize, inlinePreview, getTypeDescription } from './utils/serializer.js';
	import {
		extractComponentState,
		formatStateForAgent,
		collectStateValues,
		computeStateDiffs
	} from './utils/state-capture.js';
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
		lightTheme = false,
		maxDepth = 3,
		maxStringLength = 200,
		maxSnapshots = 5
	}: SvelteStateGrabProps = $props();

	let colors = $derived(resolveTheme(theme, lightTheme));

	let isDev = $state(false);
	let visible = $state(false);
	let stateInfo = $state<ComponentStateInfo | null>(null);
	let copied = $state(false);
	let copyFailed = $state(false);
	let expandedSections = $state<Set<string>>(new Set(['props', 'attributes']));
	let snapshots = $state<StateSnapshot[]>([]);
	let diffs = $state<StateDiff[]>([]);

	const copyFb = createCopyFeedback({
		get copied() { return copied; },
		set copied(v) { copied = v; },
		get copyFailed() { return copyFailed; },
		set copyFailed(v) { copyFailed = v; }
	});

	function toggleSection(section: string) {
		const next = new Set(expandedSections);
		if (next.has(section)) next.delete(section);
		else next.add(section);
		expandedSections = next;
	}

	/** Capture logic lives in utils/state-capture.ts (shared with the agent runtime). */
	function extractState(element: SvelteElement): ComponentStateInfo {
		return extractComponentState(element);
	}

	/** Format with this popup's capture history (diffs + snapshots). */
	function formatForAgent(info: ComponentStateInfo): string {
		return formatStateForAgent(info, diffs, snapshots);
	}

	/**
	 * Take a snapshot and compute diffs from previous
	 */
	function takeSnapshot(info: ComponentStateInfo) {
		const state = collectStateValues(info);
		const snapshot: StateSnapshot = {
			timestamp: Date.now(),
			componentName: info.componentName,
			file: info.file,
			state
		};

		// Compute diff against the most recent snapshot for the same component
		const prevSnapshot = snapshots.find(s => s.file === info.file);
		if (prevSnapshot) {
			diffs = computeStateDiffs(prevSnapshot.state, state);
		} else {
			diffs = [];
		}

		// Add to front, limit size
		snapshots = [snapshot, ...snapshots.filter(s => s.file !== info.file || s.timestamp !== snapshot.timestamp)].slice(0, maxSnapshots);
	}

	function handleClick(event: MouseEvent) {
		if (!checkModifier(event, modifier)) return;
		if (!event.shiftKey && secondaryModifier === 'shift') return;
		if (secondaryModifier === 'ctrl' && !event.ctrlKey) return;
		if (secondaryModifier === 'meta' && !event.metaKey) return;

		event.preventDefault();
		event.stopPropagation();

		const target = event.target as HTMLElement;
		const svelteEl = findSvelteElement(target);
		if (!svelteEl) {
			const tag = target.tagName?.toLowerCase() || 'unknown';
			console.log(`[SvelteStateGrab] No Svelte component found for <${tag}>. This element may be plain HTML, rendered by a third-party library, or outside Svelte's component tree. Try clicking a parent element.`);
			return;
		}

		stateInfo = extractState(svelteEl);
		takeSnapshot(stateInfo);
		const formatted = formatForAgent(stateInfo);
		registerToolOutput('StateGrab', formatted);
		copyFb.copy(formatted);

		console.log('[SvelteStateGrab] Component state captured:\n' + formatted);

		if (showPopup) {
			visible = true;
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && visible) {
			visible = false;
		}
	}

	const mount = useDevtoolMount(() => forceEnable, () => {
		document.addEventListener('click', handleClick, true);
		document.addEventListener('keydown', handleKeydown);

		return () => {
			document.removeEventListener('click', handleClick, true);
			document.removeEventListener('keydown', handleKeydown);
		};
	}, {
		onDev: () => {
			isDev = true;
			const modLabel = modifier.charAt(0).toUpperCase() + modifier.slice(1);
			const secLabel = secondaryModifier.charAt(0).toUpperCase() + secondaryModifier.slice(1);
			console.log(`[SvelteStateGrab] Active! Use ${modLabel}+${secLabel}+Click to inspect state`);
		}
	});

	onMount(mount.start);
	onDestroy(() => {
		mount.stop();
		copyFb.reset();
	});
</script>

{#if isDev && showPopup && stateInfo}
	<DevToolPopup
		title="StateGrab"
		bind:visible
		{colors}
		titleColor="#a78bfa"
		{copied}
		{copyFailed}
		ariaLabel="SvelteStateGrab inspector"
	>
		{#snippet headerExtra()}
			{#if stateInfo?.componentName}
				<span class="sg-state-component">&lt;{stateInfo.componentName}&gt;</span>
			{/if}
		{/snippet}

		<div class="sg-state-location">
			{stateInfo.file}:{stateInfo.line}
		</div>

		{#if Object.keys(stateInfo.props).length > 0}
					<button class="sg-state-section" onclick={() => toggleSection('props')}>
						<span class="sg-state-section-icon">{expandedSections.has('props') ? '▼' : '▶'}</span>
						<span>📥 Props ({Object.keys(stateInfo.props).length})</span>
					</button>
					{#if expandedSections.has('props')}
						<div class="sg-state-entries">
							{#each Object.entries(stateInfo.props) as [key, value] (key)}
								<div class="sg-state-entry">
									<span class="sg-state-key">{key}</span>
									<span class="sg-state-type">{getTypeDescription(value)}</span>
									<span class="sg-state-value">{inlinePreview(value)}</span>
								</div>
							{/each}
						</div>
					{/if}
				{/if}

				{#if Object.keys(stateInfo.attributes).length > 0}
					<button class="sg-state-section" onclick={() => toggleSection('attributes')}>
						<span class="sg-state-section-icon">{expandedSections.has('attributes') ? '▼' : '▶'}</span>
						<span>🏷️ Attributes ({Object.keys(stateInfo.attributes).length})</span>
					</button>
					{#if expandedSections.has('attributes')}
						<div class="sg-state-entries">
							{#each Object.entries(stateInfo.attributes) as [key, value] (key)}
								<div class="sg-state-entry">
									<span class="sg-state-key">{key}</span>
									<span class="sg-state-value">"{value}"</span>
								</div>
							{/each}
						</div>
					{/if}
				{/if}

				{#if Object.keys(stateInfo.dataAttributes).length > 0}
					<button class="sg-state-section" onclick={() => toggleSection('data')}>
						<span class="sg-state-section-icon">{expandedSections.has('data') ? '▼' : '▶'}</span>
						<span>📊 Data Attributes ({Object.keys(stateInfo.dataAttributes).length})</span>
					</button>
					{#if expandedSections.has('data')}
						<div class="sg-state-entries">
							{#each Object.entries(stateInfo.dataAttributes) as [key, value] (key)}
								<div class="sg-state-entry">
									<span class="sg-state-key">{key}</span>
									<span class="sg-state-value">"{value}"</span>
								</div>
							{/each}
						</div>
					{/if}
				{/if}

				{#if Object.keys(stateInfo.boundValues).length > 0}
					<button class="sg-state-section" onclick={() => toggleSection('bound')}>
						<span class="sg-state-section-icon">{expandedSections.has('bound') ? '▼' : '▶'}</span>
						<span>🔗 Bound Values ({Object.keys(stateInfo.boundValues).length})</span>
					</button>
					{#if expandedSections.has('bound')}
						<div class="sg-state-entries">
							{#each Object.entries(stateInfo.boundValues) as [key, value] (key)}
								<div class="sg-state-entry">
									<span class="sg-state-key">{key}</span>
									<span class="sg-state-type">{getTypeDescription(value)}</span>
									<span class="sg-state-value">{inlinePreview(value)}</span>
								</div>
							{/each}
						</div>
					{/if}
				{/if}

				{#if stateInfo.inspectableInstances && stateInfo.inspectableInstances.length > 0}
					{@const instances = stateInfo.inspectableInstances}
					<button class="sg-state-section" onclick={() => toggleSection('inspectable')}>
						<span class="sg-state-section-icon">{expandedSections.has('inspectable') ? '▼' : '▶'}</span>
						<span>🔍 Inspectable State ({instances.length > 1 ? `${instances.length} instances` : Object.keys(instances[0].values).length})</span>
					</button>
					{#if expandedSections.has('inspectable')}
						<div class="sg-state-entries">
							{#each instances as inst (inst.instance)}
								{#if instances.length > 1}
									<div class="sg-state-instance">{inst.label}</div>
								{/if}
								{#each Object.entries(inst.values) as [key, value] (key)}
									<div class="sg-state-entry">
										<span class="sg-state-key">{key}</span>
										<span class="sg-state-type">{getTypeDescription(value)}</span>
										<span class="sg-state-value">{inlinePreview(value)}</span>
									</div>
								{/each}
							{/each}
						</div>
					{/if}
				{/if}

				{#if diffs.length > 0}
					<button class="sg-state-section" onclick={() => toggleSection('diffs')}>
						<span class="sg-state-section-icon">{expandedSections.has('diffs') ? '▼' : '▶'}</span>
						<span>🔄 State Changes ({diffs.length})</span>
					</button>
					{#if expandedSections.has('diffs')}
						<div class="sg-state-entries">
							{#each diffs as diff (diff.key)}
								<div class="sg-state-entry">
									<span class="sg-state-key">{diff.key}</span>
									<span class="sg-state-diff-old">{diff.oldValue === undefined ? '(new)' : inlinePreview(diff.oldValue)}</span>
									<span class="sg-state-diff-arrow">&rarr;</span>
									<span class="sg-state-diff-new">{diff.newValue === undefined ? '(removed)' : inlinePreview(diff.newValue)}</span>
								</div>
							{/each}
						</div>
					{/if}
				{/if}

				{#if stateInfo.childComponents.length > 0}
					<button class="sg-state-section" onclick={() => toggleSection('children')}>
						<span class="sg-state-section-icon">{expandedSections.has('children') ? '▼' : '▶'}</span>
						<span>🌳 Children ({stateInfo.childComponents.length} unique, {stateInfo.childComponentCount} total)</span>
					</button>
					{#if expandedSections.has('children')}
						<div class="sg-state-entries">
							{#each stateInfo.childComponents as child (child.file)}
								<div class="sg-state-entry">
									<span class="sg-state-key">&lt;{child.name}&gt;</span>
									<span class="sg-state-type">{child.count > 1 ? `x${child.count}` : ''}</span>
									<span class="sg-state-value">{child.file}</span>
								</div>
							{/each}
						</div>
					{/if}
				{/if}

		{#snippet footer()}
			<DevToolButton
				onclick={() => {
					if (stateInfo) copyFb.copy(formatForAgent(stateInfo));
				}}
			>Copy for Agent</DevToolButton>
			<DevToolButton
				onclick={() => {
					if (stateInfo) copyFb.copy(safeSerialize({
						component: stateInfo.componentName,
						file: stateInfo.file,
						line: stateInfo.line,
						props: stateInfo.props,
						attributes: stateInfo.attributes,
						dataAttributes: stateInfo.dataAttributes,
						boundValues: stateInfo.boundValues
					}, maxDepth, maxStringLength));
				}}
			>Copy JSON</DevToolButton>
		{/snippet}
	</DevToolPopup>
{/if}

<style>
	.sg-state-component {
		color: #60a5fa;
		font-size: 11px;
		padding: 2px 6px;
		background: rgba(96, 165, 250, 0.1);
		border-radius: 4px;
		flex: 1;
	}

	.sg-state-location {
		padding: 6px 12px;
		font-size: 10px;
		color: #888;
		background: color-mix(in srgb, var(--sg-bg) 50%, black 10%);
		border-bottom: 1px solid var(--sg-border);
	}

	.sg-state-section {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 8px 12px;
		background: none;
		border: none;
		border-bottom: 1px solid rgba(255, 255, 255, 0.05);
		color: var(--sg-text);
		cursor: pointer;
		font-family: inherit;
		font-size: 11px;
		font-weight: 600;
		text-align: left;
	}

	.sg-state-section:hover {
		background: rgba(255, 255, 255, 0.05);
	}

	.sg-state-section-icon {
		font-size: 9px;
		color: #888;
	}

	.sg-state-entries {
		padding: 0 12px 8px;
	}

	.sg-state-instance {
		padding: 6px 0 2px;
		font-size: 10px;
		font-weight: 600;
		color: #888;
	}

	.sg-state-entry {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 3px 0;
		font-size: 11px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.03);
	}

	.sg-state-key {
		color: #60a5fa;
		min-width: 80px;
		flex-shrink: 0;
	}

	.sg-state-type {
		color: #888;
		font-size: 9px;
		min-width: 60px;
		flex-shrink: 0;
	}

	.sg-state-value {
		color: #fbbf24;
		word-break: break-all;
		flex: 1;
	}

	.sg-state-diff-old {
		color: #ef4444;
		text-decoration: line-through;
		font-size: 10px;
	}

	.sg-state-diff-arrow {
		color: #888;
		font-size: 10px;
		flex-shrink: 0;
	}

	.sg-state-diff-new {
		color: #4ade80;
		font-size: 10px;
	}
</style>
