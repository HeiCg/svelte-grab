<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { SvelteStateGrabProps, ComponentStateInfo, ThemeConfig, StateSnapshot, StateDiff } from './types.js';
	import type { SvelteElement } from './utils/shared.js';
	import {
		detectDevMode,
		findSvelteElement,
		shortenPath,
		extractComponentName,
		copyToClipboard,
		checkModifier,
		modifierKeyName,
		getElementPreview,
		DARK_THEME,
		LIGHT_THEME
	} from './utils/shared.js';
	import { safeSerialize, inlinePreview, getTypeDescription } from './utils/serializer.js';
	import { getInspectableState, getInspectableIds } from './utils/inspectable.js';
	import { registerToolOutput } from './utils/unified-export.js';

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

	let baseTheme = $derived(lightTheme ? LIGHT_THEME : DARK_THEME);
	let colors = $derived({ ...baseTheme, ...theme } as Required<ThemeConfig>);

	let isDev = $state(false);
	let visible = $state(false);
	let stateInfo = $state<ComponentStateInfo | null>(null);
	let copied = $state(false);
	let copyFailed = $state(false);
	let expandedSections = $state<Set<string>>(new Set(['props', 'attributes']));
	let snapshots = $state<StateSnapshot[]>([]);
	let diffs = $state<StateDiff[]>([]);

	function toggleSection(section: string) {
		const next = new Set(expandedSections);
		if (next.has(section)) next.delete(section);
		else next.add(section);
		expandedSections = next;
	}

	/**
	 * Extract component state from an element
	 */
	function extractState(element: SvelteElement): ComponentStateInfo {
		const meta = element.__svelte_meta;
		const file = meta?.loc?.file || 'unknown';
		const line = meta?.loc?.line || 0;
		const componentName = extractComponentName(file);
		const tag = element.tagName.toLowerCase();

		// Collect regular attributes
		const attributes: Record<string, string> = {};
		const dataAttributes: Record<string, string> = {};
		for (const attr of Array.from(element.attributes)) {
			if (attr.name.startsWith('data-')) {
				dataAttributes[attr.name] = attr.value;
			} else if (!attr.name.startsWith('__') && attr.name !== 'class' && attr.name !== 'style') {
				attributes[attr.name] = attr.value;
			}
		}

		// Try to extract props from Svelte component context
		const props: Record<string, unknown> = {};
		const boundValues: Record<string, unknown> = {};

		// Access class and style separately as they're common props
		if (element.className) {
			props['class'] = String(element.className);
		}
		if (element.style.cssText) {
			props['style'] = element.style.cssText;
		}

		// Try to access Svelte 5 component internals
		// In Svelte 5, component instances may expose state via $$
		const svelteInternals = (element as any).$$;
		if (svelteInternals) {
			// Try to read props
			if (svelteInternals.props) {
				try {
					const p = svelteInternals.props;
					if (typeof p === 'object' && p !== null) {
						for (const key of Object.keys(p)) {
							props[key] = p[key];
						}
					}
				} catch { /* props not accessible */ }
			}

			// Try to read context/state
			if (svelteInternals.ctx) {
				try {
					const ctx = svelteInternals.ctx;
					if (Array.isArray(ctx)) {
						ctx.forEach((val: unknown, idx: number) => {
							if (val !== undefined && val !== null && typeof val !== 'function') {
								boundValues[`ctx[${idx}]`] = val;
							}
						});
					}
				} catch { /* ctx not accessible */ }
			}
		}

		// Extract observable properties from common form elements
		if (element instanceof HTMLInputElement) {
			boundValues['value'] = element.value;
			boundValues['checked'] = element.checked;
			boundValues['type'] = element.type;
			if (element.name) boundValues['name'] = element.name;
		} else if (element instanceof HTMLSelectElement) {
			boundValues['value'] = element.value;
			boundValues['selectedIndex'] = element.selectedIndex;
		} else if (element instanceof HTMLTextAreaElement) {
			boundValues['value'] = element.value;
		}

		// Text content for leaf elements
		if (element.children.length === 0 && element.textContent?.trim()) {
			boundValues['textContent'] = element.textContent.trim().slice(0, 200);
		}

		// Collect child components with details
		const childMap = new Map<string, { name: string; file: string; count: number }>();
		element.querySelectorAll('*').forEach(child => {
			const childMeta = (child as SvelteElement).__svelte_meta;
			if (childMeta?.loc) {
				const childFile = childMeta.loc.file;
				if (childFile !== file) {
					const existing = childMap.get(childFile);
					if (existing) {
						existing.count++;
					} else {
						childMap.set(childFile, {
							name: extractComponentName(childFile) || 'unknown',
							file: shortenPath(childFile),
							count: 1
						});
					}
				}
			}
		});
		const childComponents = Array.from(childMap.values());
		const childComponentCount = childComponents.reduce((sum, c) => sum + c.count, 0);

		// Look up inspectable() state by component name
		let inspectableState: Record<string, unknown> | undefined;
		if (componentName) {
			inspectableState = getInspectableState(componentName);
			// Also try partial matches (e.g., "Counter" matches "MyCounter")
			if (!inspectableState) {
				const ids = getInspectableIds();
				const match = ids.find(id =>
					id === componentName ||
					id.toLowerCase() === componentName!.toLowerCase()
				);
				if (match) inspectableState = getInspectableState(match);
			}
		}

		return {
			componentName,
			file: shortenPath(file),
			line,
			props,
			attributes,
			dataAttributes,
			boundValues,
			inspectableState,
			childComponentCount,
			childComponents,
			elementTag: tag
		};
	}

	/**
	 * Format state for LLM agent
	 */
	function formatForAgent(info: ComponentStateInfo): string {
		const parts: string[] = [
			`=== Component State: ${info.componentName || info.elementTag} ===\n`
		];

		if (Object.keys(info.props).length > 0) {
			parts.push('\u{1F4E5} OBSERVABLE PROPS/ATTRIBUTES:');
			for (const [key, value] of Object.entries(info.props)) {
				parts.push(`  ${key}: ${inlinePreview(value)}`);
			}
			parts.push('');
		}

		if (Object.keys(info.attributes).length > 0) {
			parts.push('\u{1F3F7}\uFE0F HTML ATTRIBUTES:');
			for (const [key, value] of Object.entries(info.attributes)) {
				parts.push(`  ${key}: "${value}"`);
			}
			parts.push('');
		}

		if (Object.keys(info.dataAttributes).length > 0) {
			parts.push('\u{1F4CA} DATA ATTRIBUTES:');
			for (const [key, value] of Object.entries(info.dataAttributes)) {
				parts.push(`  ${key}: "${value}"`);
			}
			parts.push('');
		}

		if (Object.keys(info.boundValues).length > 0) {
			parts.push('\u{1F517} BOUND/OBSERVABLE VALUES:');
			for (const [key, value] of Object.entries(info.boundValues)) {
				parts.push(`  ${key}: ${inlinePreview(value)}`);
			}
			parts.push('');
		}

		if (info.inspectableState && Object.keys(info.inspectableState).length > 0) {
			parts.push('\u{1F50D} INSPECTABLE STATE ($state):');
			for (const [key, value] of Object.entries(info.inspectableState)) {
				parts.push(`  ${key}: ${inlinePreview(value)}`);
			}
			parts.push('');
		}

		if (info.childComponents.length > 0) {
			parts.push(`\u{1F333} CHILD COMPONENTS (${info.childComponentCount} total, ${info.childComponents.length} unique):`);
			for (const child of info.childComponents) {
				parts.push(`  <${child.name}> ${child.file}${child.count > 1 ? ` (x${child.count})` : ''}`);
			}
			parts.push('');
		}

		if (diffs.length > 0) {
			parts.push('\u{1F504} STATE CHANGES (since last capture):');
			for (const diff of diffs) {
				const oldStr = diff.oldValue === undefined ? '(new)' : inlinePreview(diff.oldValue);
				const newStr = diff.newValue === undefined ? '(removed)' : inlinePreview(diff.newValue);
				parts.push(`  ${diff.key}: ${oldStr} \u2192 ${newStr}`);
			}
			parts.push('');
		}

		if (snapshots.length > 1) {
			const componentSnapshots = snapshots.filter(s => s.file === info.file);
			if (componentSnapshots.length > 1) {
				parts.push(`\u{1F4F8} SNAPSHOT HISTORY (${componentSnapshots.length} captures for this component):`);
				for (const snap of componentSnapshots.slice(0, 5)) {
					parts.push(`  [${new Date(snap.timestamp).toLocaleTimeString()}] ${Object.keys(snap.state).length} values`);
				}
				parts.push('');
			}
		}

		parts.push(`\u{1F4CD} Location: ${info.file}:${info.line}`);

		return parts.join('\n');
	}

	/**
	 * Collect all state values into a flat record for snapshot comparison
	 */
	function collectStateValues(info: ComponentStateInfo): Record<string, unknown> {
		const values: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(info.props)) values[`props.${k}`] = v;
		for (const [k, v] of Object.entries(info.boundValues)) values[`bound.${k}`] = v;
		if (info.inspectableState) {
			for (const [k, v] of Object.entries(info.inspectableState)) values[`state.${k}`] = v;
		}
		return values;
	}

	/**
	 * Compare two snapshots and return the diffs
	 */
	function computeDiffs(prev: Record<string, unknown>, curr: Record<string, unknown>): StateDiff[] {
		const result: StateDiff[] = [];
		const allKeys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
		for (const key of allKeys) {
			const oldVal = prev[key];
			const newVal = curr[key];
			if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
				result.push({ key, oldValue: oldVal, newValue: newVal });
			}
		}
		return result;
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
			diffs = computeDiffs(prevSnapshot.state, state);
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
			console.log('[SvelteStateGrab] No Svelte component found');
			return;
		}

		stateInfo = extractState(svelteEl);
		takeSnapshot(stateInfo);
		const formatted = formatForAgent(stateInfo);
		registerToolOutput('StateGrab', formatted);
		copyToClipboard(formatted).then(ok => {
			if (ok) {
				copied = true;
				setTimeout(() => (copied = false), 1500);
			} else {
				copyFailed = true;
				setTimeout(() => (copyFailed = false), 3000);
			}
		});

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

	let cleanup: (() => void) | null = null;

	onMount(() => {
		setTimeout(() => {
			isDev = detectDevMode(forceEnable);
			if (!isDev) return;

			const modLabel = modifier.charAt(0).toUpperCase() + modifier.slice(1);
			const secLabel = secondaryModifier.charAt(0).toUpperCase() + secondaryModifier.slice(1);
			console.log(`[SvelteStateGrab] Active! Use ${modLabel}+${secLabel}+Click to inspect state`);

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

{#if isDev && showPopup && visible && stateInfo}
	<div
		class="sg-state-overlay"
		onclick={() => (visible = false)}
		onkeydown={(e) => e.key === 'Escape' && (visible = false)}
		role="presentation"
	>
		<div
			class="sg-state-popup"
			style="
				--sg-bg: {colors.background};
				--sg-border: {colors.border};
				--sg-text: {colors.text};
				--sg-accent: {colors.accent};
			"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			aria-label="SvelteStateGrab inspector"
			tabindex="-1"
		>
			<div class="sg-state-header">
				<span class="sg-state-title">StateGrab</span>
				{#if stateInfo.componentName}
					<span class="sg-state-component">&lt;{stateInfo.componentName}&gt;</span>
				{/if}
				{#if copied}
					<span class="sg-state-copied">Copied!</span>
				{/if}
				{#if copyFailed}
					<span class="sg-state-copied-failed" style="color: #ef4444; font-size: 11px;">Copy failed</span>
				{/if}
				<button class="sg-state-close" onclick={() => (visible = false)} aria-label="Close">&times;</button>
			</div>

			<div class="sg-state-content">
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
							{#each Object.entries(stateInfo.props) as [key, value]}
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
							{#each Object.entries(stateInfo.attributes) as [key, value]}
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
							{#each Object.entries(stateInfo.dataAttributes) as [key, value]}
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
							{#each Object.entries(stateInfo.boundValues) as [key, value]}
								<div class="sg-state-entry">
									<span class="sg-state-key">{key}</span>
									<span class="sg-state-type">{getTypeDescription(value)}</span>
									<span class="sg-state-value">{inlinePreview(value)}</span>
								</div>
							{/each}
						</div>
					{/if}
				{/if}

				{#if stateInfo.inspectableState && Object.keys(stateInfo.inspectableState).length > 0}
					<button class="sg-state-section" onclick={() => toggleSection('inspectable')}>
						<span class="sg-state-section-icon">{expandedSections.has('inspectable') ? '▼' : '▶'}</span>
						<span>🔍 Inspectable State ({Object.keys(stateInfo.inspectableState).length})</span>
					</button>
					{#if expandedSections.has('inspectable')}
						<div class="sg-state-entries">
							{#each Object.entries(stateInfo.inspectableState) as [key, value]}
								<div class="sg-state-entry">
									<span class="sg-state-key">{key}</span>
									<span class="sg-state-type">{getTypeDescription(value)}</span>
									<span class="sg-state-value">{inlinePreview(value)}</span>
								</div>
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
							{#each diffs as diff}
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
							{#each stateInfo.childComponents as child}
								<div class="sg-state-entry">
									<span class="sg-state-key">&lt;{child.name}&gt;</span>
									<span class="sg-state-type">{child.count > 1 ? `x${child.count}` : ''}</span>
									<span class="sg-state-value">{child.file}</span>
								</div>
							{/each}
						</div>
					{/if}
				{/if}
			</div>

			<div class="sg-state-footer">
				<button
					class="sg-state-btn"
					onclick={() => {
						if (stateInfo) copyToClipboard(formatForAgent(stateInfo)).then(ok => {
							if (ok) { copied = true; setTimeout(() => (copied = false), 1500); }
							else { copyFailed = true; setTimeout(() => (copyFailed = false), 3000); }
						});
					}}
				>Copy for Agent</button>
				<button
					class="sg-state-btn"
					onclick={() => {
						if (stateInfo) copyToClipboard(safeSerialize({
							component: stateInfo.componentName,
							file: stateInfo.file,
							line: stateInfo.line,
							props: stateInfo.props,
							attributes: stateInfo.attributes,
							dataAttributes: stateInfo.dataAttributes,
							boundValues: stateInfo.boundValues
						})).then(ok => {
							if (ok) { copied = true; setTimeout(() => (copied = false), 1500); }
							else { copyFailed = true; setTimeout(() => (copyFailed = false), 3000); }
						});
					}}
				>Copy JSON</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.sg-state-overlay {
		position: fixed;
		inset: 0;
		z-index: 99999;
		background: rgba(0, 0, 0, 0.3);
	}

	.sg-state-popup {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		background: var(--sg-bg);
		border: 1px solid var(--sg-border);
		border-radius: 8px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
		min-width: 360px;
		max-width: 600px;
		max-height: 500px;
		overflow: hidden;
		font-family: ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
		font-size: 12px;
		color: var(--sg-text);
		display: flex;
		flex-direction: column;
	}

	.sg-state-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
		border-bottom: 1px solid var(--sg-border);
	}

	.sg-state-title {
		color: #a78bfa;
		font-weight: 600;
	}

	.sg-state-component {
		color: #60a5fa;
		font-size: 11px;
		padding: 2px 6px;
		background: rgba(96, 165, 250, 0.1);
		border-radius: 4px;
		flex: 1;
	}

	.sg-state-copied {
		color: #4ade80;
		font-size: 11px;
	}

	.sg-state-close {
		background: none;
		border: none;
		color: #888;
		cursor: pointer;
		padding: 2px 6px;
		font-size: 14px;
		border-radius: 4px;
	}

	.sg-state-close:hover {
		color: #fff;
		background: rgba(255, 255, 255, 0.1);
	}

	.sg-state-content {
		overflow-y: auto;
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

	.sg-state-footer {
		display: flex;
		gap: 8px;
		padding: 8px 12px;
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
		border-top: 1px solid var(--sg-border);
	}

	.sg-state-btn {
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

	.sg-state-btn:hover {
		background: rgba(255, 255, 255, 0.15);
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
