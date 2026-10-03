<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { SvelteStyleGrabProps, StyleCategory, StyleConflict, ThemeConfig } from './types.js';
	import {
		detectDevMode,
		findSvelteElement,
		shortenPath,
		extractComponentName,
		copyToClipboard,
		checkModifier,
		DARK_THEME,
		LIGHT_THEME
	} from './utils/shared.js';
	import { getSvelteLoc } from './utils/component-stack.js';
	import { analyzeStyles, formatStylesForAgent } from './utils/css-analyzer.js';
	import { registerToolOutput } from './utils/unified-export.js';
	import { createCopyFeedback } from './utils/copy-with-feedback.js';
	import { hideFromThirdParties } from './utils/hide-from-third-parties.js';
	import {
		EDITABLE_PROPERTIES,
		groupedEditableProperties,
		resolveTailwindClass,
		applyPreview,
		restoreAll,
		formatEditPrompt,
		type EditablePropertyDef,
		type EditChange,
		type EditTarget
	} from './utils/css-edit/index.js';

	let {
		modifier = 'alt',
		secondaryModifier = 'ctrl',
		forceEnable = false,
		showPopup = true,
		theme = {},
		lightTheme = false,
		showCategories = ['all']
	}: SvelteStyleGrabProps = $props();

	let baseTheme = $derived(lightTheme ? LIGHT_THEME : DARK_THEME);
	let colors = $derived({ ...baseTheme, ...theme } as Required<ThemeConfig>);

	let isDev = $state(false);
	let visible = $state(false);
	let copied = $state(false);
	let copyFailed = $state(false);
	let categories = $state<StyleCategory[]>([]);
	let conflicts = $state<StyleConflict[]>([]);
	let elementTag = $state('');
	let elementFile = $state<string | undefined>();
	let elementLine = $state<number | undefined>();
	let activeCategory = $state<string | null>(null);
	let showConflicts = $state(false);
	let capturedElement = $state<HTMLElement | null>(null);

	const copyFb = createCopyFeedback({
		get copied() { return copied; }, set copied(v) { copied = v; },
		get copyFailed() { return copyFailed; }, set copyFailed(v) { copyFailed = v; }
	});

	// --- Live edit mode (opt-in, default OFF) ---
	interface EditRow {
		def: EditablePropertyDef;
		/** Current displayed value (numeric value, hex, or enum value). */
		current: string;
		/** Original computed value captured on open, for the diff + prompt. */
		original: string;
	}

	let editMode = $state(false);
	let editRows = $state<EditRow[]>([]);
	let tailwindInput = $state('');
	let tailwindError = $state<string | null>(null);
	let overlayEl = $state<HTMLDivElement | undefined>();
	const editGroups = groupedEditableProperties();

	// Opt the whole popup subtree out of third-party session-replay / analytics
	// whenever it (re)mounts, so source paths and styles never leak.
	$effect(() => {
		if (overlayEl) hideFromThirdParties(overlayEl);
	});

	/** Pending changes (current !== original), in table order. */
	let pendingChanges = $derived(editRows.filter((r) => r.current !== r.original));

	function rgbToHex(value: string): string {
		const m = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
		if (!m) return value.startsWith('#') ? value : '#000000';
		const hex = (n: string) =>
			Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0');
		return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
	}

	/** Read the editable rows for an element from its computed style. */
	function buildEditRows(el: HTMLElement): EditRow[] {
		const computed = getComputedStyle(el);
		return EDITABLE_PROPERTIES.map((def): EditRow => {
			// Read from the first concrete longhand (aggregates share a value).
			const raw = computed.getPropertyValue(def.cssProperties[0]).trim();
			let current = raw;
			if (def.kind === 'color') {
				current = rgbToHex(raw);
			} else if (def.kind === 'numeric-stepper') {
				if (def.key === 'opacity') {
					current = String(Math.round((Number(raw) || 1) * 100));
				} else {
					const n = Number.parseFloat(raw);
					current = Number.isFinite(n) ? String(Math.round(n)) : '0';
				}
			}
			return { def, current, original: current };
		});
	}

	/** Format a row's `current` into the concrete CSS value written to the DOM. */
	function cssValueFor(def: EditablePropertyDef, current: string): string {
		if (def.kind === 'color' || def.kind === 'enum-cycle') return current;
		if (def.key === 'opacity') return String((Number(current) || 0) / 100);
		const n = Number(current);
		return `${Number.isFinite(n) ? n : 0}${def.unit === '%' ? '' : def.unit}`;
	}

	/** Display value used in the diff / prompt (e.g. "16px", "60%"). */
	function displayValueFor(def: EditablePropertyDef, value: string): string {
		if (def.kind === 'color' || def.kind === 'enum-cycle') return value;
		if (def.key === 'opacity') return `${value}%`;
		return `${value}${def.unit === '%' ? '%' : def.unit}`;
	}

	function applyRow(row: EditRow): void {
		if (!capturedElement) return;
		applyPreview(capturedElement, row.def.cssProperties, cssValueFor(row.def, row.current));
	}

	function setRowValue(key: string, value: string): void {
		const row = editRows.find((r) => r.def.key === key);
		if (!row) return;
		row.current = value;
		editRows = [...editRows];
		applyRow(row);
	}

	function stepNumeric(key: string, delta: number): void {
		const row = editRows.find((r) => r.def.key === key);
		if (!row || row.def.kind !== 'numeric-stepper') return;
		const next = Math.max(row.def.min, Math.min(row.def.max, (Number(row.current) || 0) + delta));
		setRowValue(key, String(next));
	}

	function cycleEnum(key: string, dir: 1 | -1): void {
		const row = editRows.find((r) => r.def.key === key);
		if (!row || row.def.kind !== 'enum-cycle') return;
		const options = row.def.options;
		const idx = options.findIndex((o) => o.value === row.current);
		const nextIdx = (((idx < 0 ? 0 : idx) + dir) % options.length + options.length) % options.length;
		setRowValue(key, options[nextIdx].value);
	}

	/** Apply a raw `prop: value` or a Tailwind class typed into the text input. */
	function applyTailwindOrRaw(): void {
		tailwindError = null;
		const input = tailwindInput.trim();
		if (!input || !capturedElement) return;

		// Raw `prop: value` form.
		const colon = input.indexOf(':');
		if (colon > 0 && !input.includes('[')) {
			const property = input.slice(0, colon).trim();
			const value = input.slice(colon + 1).trim().replace(/;$/, '');
			if (property && value) {
				applyPreview(capturedElement, [property], value);
				syncRowFromRaw(property, value);
				tailwindInput = '';
				return;
			}
		}

		// Tailwind class form.
		const resolved = resolveTailwindClass(input);
		if (!resolved) {
			tailwindError = `Unrecognized: ${input}`;
			return;
		}
		const properties = resolved.property.split(',');
		applyPreview(capturedElement, properties, resolved.value);
		for (const property of properties) syncRowFromRaw(property, resolved.value);
		tailwindInput = '';
	}

	/** Reflect a raw/tailwind write back into the matching edit row (if any). */
	function syncRowFromRaw(cssProperty: string, cssValue: string): void {
		const row = editRows.find((r) => r.def.cssProperties.includes(cssProperty));
		if (!row) return;
		if (row.def.kind === 'color') row.current = rgbToHex(cssValue);
		else if (row.def.kind === 'enum-cycle') row.current = cssValue;
		else if (row.def.key === 'opacity') {
			const n = Number.parseFloat(cssValue);
			row.current = String(Math.round((Number.isFinite(n) ? n : 1) * 100));
		} else {
			const n = Number.parseFloat(cssValue);
			row.current = Number.isFinite(n) ? String(Math.round(n)) : row.current;
		}
		editRows = [...editRows];
	}

	function buildEditChanges(): EditChange[] {
		return pendingChanges.map((row): EditChange => {
			const from = displayValueFor(row.def, row.original);
			const to = displayValueFor(row.def, row.current);
			const value = cssValueFor(row.def, row.current);
			const declarations = row.def.cssProperties.map((p) => `${p}: ${value};`);
			return { key: row.def.key, label: row.def.label, from, to, declarations };
		});
	}

	function editTarget(): EditTarget {
		return {
			filePath: elementFile,
			lineNumber: elementLine,
			componentName: elementFile ? (extractComponentName(elementFile) ?? undefined) : undefined
		};
	}

	function buildEditPrompt(): string {
		return formatEditPrompt(editTarget(), buildEditChanges());
	}

	/** Register the current edit prompt into the unified export path. */
	function registerEditOutput(): void {
		const changes = buildEditChanges();
		if (changes.length === 0) return;
		registerToolOutput('StyleEdit', buildEditPrompt());
	}

	function copyEditPrompt(): void {
		const changes = buildEditChanges();
		if (changes.length === 0) return;
		const prompt = buildEditPrompt();
		registerToolOutput('StyleEdit', prompt);
		copyFb.copy(prompt);
	}

	function resetEdits(): void {
		restoreAll();
		editRows = editRows.map((r) => ({ ...r, current: r.original }));
		tailwindInput = '';
		tailwindError = null;
	}

	function toggleEditMode(): void {
		editMode = !editMode;
		if (editMode) {
			if (capturedElement) editRows = buildEditRows(capturedElement);
		} else {
			// Leaving edit mode restores the live DOM to its original styles.
			resetEdits();
		}
	}

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

		// Switching elements drops any active preview on the previous element so
		// the page never keeps stray inline styles.
		if (editMode && capturedElement && capturedElement !== svelteEl) {
			restoreAll();
		}

		const tag = svelteEl.tagName.toLowerCase();
		const cls = svelteEl.className ? ` class="${String(svelteEl.className).slice(0, 40)}"` : '';
		elementTag = `<${tag}${cls}>`;

		const loc = getSvelteLoc(svelteEl);
		elementFile = loc ? shortenPath(loc.file) : undefined;
		elementLine = loc?.line;

		capturedElement = svelteEl;
		const result = analyzeStyles(svelteEl);
		const showAll = showCategories.includes('all');
		const categoryKeyMap: Record<string, string> = {
			'Box Model': 'box-model',
			'Visual': 'visual',
			'Typography': 'typography',
			'Layout': 'layout'
		};
		categories = showAll
			? result.categories
			: result.categories.filter(c => showCategories.includes(categoryKeyMap[c.name] as any));
		conflicts = result.conflicts;
		activeCategory = categories.length > 0 ? categories[0].name : null;

		const formatted = formatStylesForAgent(svelteEl, categories, conflicts, elementFile, elementLine);
		registerToolOutput('StyleGrab', formatted);
		copyToClipboard(formatted).then(ok => {
			if (ok) { copied = true; setTimeout(() => (copied = false), 1500); }
			else { copyFailed = true; setTimeout(() => (copyFailed = false), 3000); }
		});

		console.log('[SvelteStyleGrab] Styles captured:\n' + formatted);

		// Rebuild edit rows for the newly captured element if edit mode is on.
		if (editMode) editRows = buildEditRows(svelteEl);

		if (showPopup) visible = true;
	}

	/**
	 * Close the popup. Registers the current edit prompt into the unified-export
	 * path (so DevKit's Copy-All still includes the pending edits) and then
	 * restores the live DOM so no inline preview styles are left on the page.
	 */
	function closePopup(): void {
		registerEditOutput();
		restoreAll();
		// Reset rows back to original so a re-open starts clean (no stale diff).
		if (editRows.length > 0) editRows = editRows.map((r) => ({ ...r, current: r.original }));
		tailwindInput = '';
		tailwindError = null;
		visible = false;
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && visible) closePopup();
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

	onDestroy(() => {
		cleanup?.();
		copyFb.reset();
		// Never leave preview inline styles on the page after teardown.
		restoreAll();
	});
</script>

{#if isDev && showPopup && visible}
	<div
		bind:this={overlayEl}
		class="sg-style-overlay"
		onclick={closePopup}
		onkeydown={(e) => e.key === 'Escape' && closePopup()}
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
				{#if copyFailed}
					<span class="sg-style-copied-failed" style="color: #ef4444; font-size: 11px;">Copy failed</span>
				{/if}
				<button
					class="sg-style-edit-toggle"
					class:sg-style-edit-toggle-on={editMode}
					onclick={toggleEditMode}
					aria-pressed={editMode}
					title="Toggle live edit mode"
				>✎ Edit</button>
				<button class="sg-style-close" onclick={closePopup} aria-label="Close">&times;</button>
			</div>

			{#if elementFile}
				<div class="sg-style-location">{elementFile}{elementLine ? ':' + elementLine : ''}</div>
			{/if}

			{#if !editMode}
			<!-- Category tabs -->
			<div class="sg-style-tabs">
				{#each categories as cat (cat.name)}
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
					{#each conflicts as conflict (conflict.property)}
						<div class="sg-style-conflict">
							<div class="sg-style-conflict-prop">{conflict.property}</div>
							{#each conflict.rules as rule (rule.selector)}
								<div class="sg-style-conflict-rule" class:sg-style-conflict-won={rule.won}>
									<span class="sg-style-conflict-status">{rule.won ? '✅' : '❌'}</span>
									<span class="sg-style-conflict-selector">{rule.selector}</span>
									<span class="sg-style-conflict-value">{rule.value}{rule.important ? ' !important' : ''}</span>
									<span class="sg-style-conflict-spec">[{rule.specificity.join(',')}]</span>
								</div>
							{/each}
							{#if conflict.suggestion}
								<div class="sg-style-conflict-suggestion">{conflict.suggestion}</div>
							{/if}
						</div>
					{/each}
				{:else}
					{#each categories.filter(c => c.name === activeCategory) as cat (cat.name)}
						{#each cat.properties as prop (prop.name)}
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
						if (!capturedElement) return;
						const text = formatStylesForAgent(
							capturedElement,
							categories,
							conflicts,
							elementFile,
							elementLine
						);
						copyToClipboard(text).then(ok => {
							if (ok) { copied = true; setTimeout(() => (copied = false), 1500); }
							else { copyFailed = true; setTimeout(() => (copyFailed = false), 3000); }
						});
					}}
				>Copy for Agent</button>
			</div>
			{:else}
			<!-- ===== Live edit mode ===== -->
			<div class="sg-style-content sg-style-edit-content">
				{#each editGroups as section (section.group)}
					<div class="sg-style-edit-group">{section.label}</div>
					{#each section.properties as def (def.key)}
						{@const row = editRows.find((r) => r.def.key === def.key)}
						{#if row}
							<div class="sg-style-edit-row" class:sg-style-edit-row-changed={row.current !== row.original}>
								<span class="sg-style-edit-label">{def.label}</span>
								{#if def.kind === 'numeric-stepper'}
									<div class="sg-style-edit-stepper">
										<button class="sg-style-step-btn" onclick={() => stepNumeric(def.key, -def.step)} aria-label="decrease {def.label}">−</button>
										<input
											class="sg-style-edit-num"
											type="number"
											min={def.min}
											max={def.max}
											step={def.step}
											value={row.current}
											oninput={(e) => setRowValue(def.key, (e.currentTarget as HTMLInputElement).value)}
										/>
										<span class="sg-style-edit-unit">{def.unit || ''}</span>
										<button class="sg-style-step-btn" onclick={() => stepNumeric(def.key, def.step)} aria-label="increase {def.label}">+</button>
									</div>
								{:else if def.kind === 'color'}
									<div class="sg-style-edit-color">
										<input
											class="sg-style-edit-swatch"
											type="color"
											value={row.current}
											oninput={(e) => setRowValue(def.key, (e.currentTarget as HTMLInputElement).value)}
											aria-label={def.label}
										/>
										<span class="sg-style-edit-hex">{row.current}</span>
									</div>
								{:else}
									<div class="sg-style-edit-cycle">
										<button class="sg-style-step-btn" onclick={() => cycleEnum(def.key, -1)} aria-label="previous {def.label}">‹</button>
										<span class="sg-style-edit-enum">{(def.options.find((o) => o.value === row.current)?.label) ?? row.current}</span>
										<button class="sg-style-step-btn" onclick={() => cycleEnum(def.key, 1)} aria-label="next {def.label}">›</button>
									</div>
								{/if}
							</div>
						{/if}
					{/each}
				{/each}

				<!-- Tailwind / raw declaration input -->
				<div class="sg-style-edit-group">Tailwind class or prop: value</div>
				<div class="sg-style-edit-tw">
					<input
						class="sg-style-edit-tw-input"
						type="text"
						placeholder="e.g. p-4, bg-blue-500, text-[13px], color: #fff"
						bind:value={tailwindInput}
						onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyTailwindOrRaw(); } }}
					/>
					<button class="sg-style-step-btn sg-style-tw-apply" onclick={applyTailwindOrRaw}>Apply</button>
				</div>
				{#if tailwindError}
					<div class="sg-style-edit-tw-error">{tailwindError}</div>
				{/if}

				<!-- Pending changes diff -->
				{#if pendingChanges.length > 0}
					<div class="sg-style-edit-group">Pending changes ({pendingChanges.length})</div>
					{#each pendingChanges as row (row.def.key)}
						<div class="sg-style-edit-diff">
							<span class="sg-style-edit-diff-name">{row.def.label}</span>
							<span class="sg-style-edit-diff-from">{displayValueFor(row.def, row.original)}</span>
							<span class="sg-style-edit-diff-arrow">→</span>
							<span class="sg-style-edit-diff-to">{displayValueFor(row.def, row.current)}</span>
						</div>
					{/each}
				{:else}
					<div class="sg-style-edit-empty">No pending changes. Tweak a value to preview it live.</div>
				{/if}
			</div>

			<div class="sg-style-footer">
				<button
					class="sg-style-btn"
					disabled={pendingChanges.length === 0}
					onclick={copyEditPrompt}
				>Copy edit prompt</button>
				<button
					class="sg-style-btn"
					disabled={pendingChanges.length === 0}
					onclick={resetEdits}
				>Reset</button>
			</div>
			{/if}
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
	.sg-style-conflict-suggestion {
		margin-top: 4px;
		padding: 4px 8px;
		font-size: 10px;
		color: #4ade80;
		background: rgba(74, 222, 128, 0.05);
		border-radius: 3px;
		line-height: 1.4;
	}

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
	.sg-style-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.15); }
	.sg-style-btn:disabled { opacity: 0.45; cursor: default; }

	/* ===== Live edit mode ===== */
	.sg-style-edit-toggle {
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid var(--sg-border);
		color: #888;
		cursor: pointer;
		padding: 2px 8px;
		font-size: 10px;
		font-family: inherit;
		border-radius: 4px;
		margin-left: auto;
	}
	.sg-style-edit-toggle:hover { color: var(--sg-text); background: rgba(255, 255, 255, 0.14); }
	.sg-style-edit-toggle-on {
		color: var(--sg-bg);
		background: var(--sg-accent);
		border-color: var(--sg-accent);
	}

	.sg-style-edit-content { padding: 4px 0 8px; }

	.sg-style-edit-group {
		padding: 6px 12px 2px;
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #888;
	}

	.sg-style-edit-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 3px 12px;
		font-size: 11px;
	}
	.sg-style-edit-row:hover { background: rgba(255, 255, 255, 0.03); }
	.sg-style-edit-row-changed .sg-style-edit-label { color: #4ade80; }

	.sg-style-edit-label { color: #60a5fa; min-width: 110px; flex-shrink: 0; }

	.sg-style-edit-stepper,
	.sg-style-edit-color,
	.sg-style-edit-cycle {
		display: flex;
		align-items: center;
		gap: 4px;
		margin-left: auto;
	}

	.sg-style-step-btn {
		width: 20px;
		height: 20px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid var(--sg-border);
		border-radius: 4px;
		color: var(--sg-text);
		cursor: pointer;
		font-size: 12px;
		line-height: 1;
		font-family: inherit;
	}
	.sg-style-step-btn:hover { background: rgba(255, 255, 255, 0.16); }

	.sg-style-edit-num {
		width: 52px;
		background: rgba(0, 0, 0, 0.25);
		border: 1px solid var(--sg-border);
		border-radius: 4px;
		color: #fbbf24;
		font-size: 11px;
		font-family: inherit;
		padding: 2px 4px;
		text-align: right;
	}
	.sg-style-edit-unit { color: #888; font-size: 10px; width: 18px; }

	.sg-style-edit-swatch {
		width: 22px;
		height: 22px;
		padding: 0;
		border: 1px solid var(--sg-border);
		border-radius: 4px;
		background: none;
		cursor: pointer;
	}
	.sg-style-edit-hex { color: #fbbf24; font-size: 11px; min-width: 64px; }

	.sg-style-edit-enum {
		color: #fbbf24;
		font-size: 11px;
		min-width: 80px;
		text-align: center;
	}

	.sg-style-edit-tw {
		display: flex;
		gap: 6px;
		padding: 4px 12px;
	}
	.sg-style-edit-tw-input {
		flex: 1;
		background: rgba(0, 0, 0, 0.25);
		border: 1px solid var(--sg-border);
		border-radius: 4px;
		color: var(--sg-text);
		font-size: 11px;
		font-family: inherit;
		padding: 4px 6px;
	}
	.sg-style-tw-apply { width: auto; padding: 0 10px; }
	.sg-style-edit-tw-error {
		padding: 2px 12px;
		font-size: 10px;
		color: #ef4444;
	}

	.sg-style-edit-diff {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 2px 12px;
		font-size: 11px;
	}
	.sg-style-edit-diff-name { color: #60a5fa; min-width: 110px; flex-shrink: 0; }
	.sg-style-edit-diff-from { color: #888; text-decoration: line-through; }
	.sg-style-edit-diff-arrow { color: #888; }
	.sg-style-edit-diff-to { color: #4ade80; }

	.sg-style-edit-empty {
		padding: 8px 12px;
		font-size: 10px;
		color: #888;
		font-style: italic;
	}
</style>
