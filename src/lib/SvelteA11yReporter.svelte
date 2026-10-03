<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { SvelteA11yReporterProps, A11yReport } from './types.js';
	import {
		findSvelteElement,
		checkModifier
	} from './utils/shared.js';
	import { analyzeA11y, formatA11yForAgent } from './utils/a11y-checker.js';
	import { registerToolOutput } from './utils/unified-export.js';
	import DevToolPopup from './ui/DevToolPopup.svelte';
	import DevToolButton from './ui/DevToolButton.svelte';
	import { resolveTheme } from './utils/resolve-theme.js';
	import { createCopyFeedback } from './utils/copy-with-feedback.js';
	import { useDevtoolMount } from './utils/use-devtool-mount.svelte.js';

	let {
		modifier = 'alt',
		forceEnable = false,
		showPopup = true,
		theme = {},
		lightTheme = false,
		includeSubtree = true,
		enableHotkeys = true
	}: SvelteA11yReporterProps = $props();

	let colors = $derived(resolveTheme(theme, lightTheme));

	let isDev = $state(false);
	let visible = $state(false);
	let copied = $state(false);
	let copyFailed = $state(false);
	let report = $state<A11yReport | null>(null);
	let activeTab = $state<'critical' | 'warnings' | 'passes'>('critical');

	const copyFb = createCopyFeedback({
		get copied() { return copied; },
		set copied(v) { copied = v; },
		get copyFailed() { return copyFailed; },
		set copyFailed(v) { copyFailed = v; }
	});

	// DevToolPopup closes (overlay click / × / Escape) by setting `visible = false`
	// directly, so mirror the old "clear highlights on close" behavior here.
	$effect(() => {
		if (!visible) clearHighlights();
	});

	function handleClick(event: MouseEvent) {
		if (!enableHotkeys) return;
		if (!checkModifier(event, modifier)) return;
		// Triple-click or Alt+A keyboard shortcut for a11y
		// We'll use right-click with modifier instead
		if (event.button !== 2) return; // right-click only

		event.preventDefault();
		event.stopPropagation();

		const target = event.target as HTMLElement;
		const svelteEl = findSvelteElement(target) || target;

		report = analyzeA11y(svelteEl, includeSubtree);

		if (report.critical.length > 0) {
			activeTab = 'critical';
		} else if (report.warnings.length > 0) {
			activeTab = 'warnings';
		} else {
			activeTab = 'passes';
		}

		const formatted = formatA11yForAgent(report);
		registerToolOutput('A11yReporter', formatted);
		copyFb.copy(formatted);

		console.log('[SvelteA11yReporter] A11y report:\n' + formatted);
		if (showPopup) {
			visible = true;
			applyHighlights(report);
		}
	}

	function handleContextMenu(event: MouseEvent) {
		if (!enableHotkeys) return;
		if (!checkModifier(event, modifier)) return;
		event.preventDefault(); // Prevent default context menu
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && visible) { visible = false; clearHighlights(); }

		// Alt+A to analyze full page
		if (enableHotkeys && checkModifier(event, modifier) && (event.key === 'a' || event.key === 'A')) {
			event.preventDefault();
			report = analyzeA11y(document.body, true);
			if (report.critical.length > 0) activeTab = 'critical';
			else if (report.warnings.length > 0) activeTab = 'warnings';
			else activeTab = 'passes';

			const formatted = formatA11yForAgent(report);
			registerToolOutput("A11yReporter", formatted);
			copyFb.copy(formatted);
			console.log('[SvelteA11yReporter] Full page a11y report:\n' + formatted);
			if (showPopup) {
				visible = true;
				applyHighlights(report);
			}
		}
	}

	function getScoreColor(score: number): string {
		if (score >= 80) return '#4ade80';
		if (score >= 60) return '#fbbf24';
		return '#ef4444';
	}

	let highlightStyleEl: HTMLStyleElement | null = null;

	function applyHighlights(r: A11yReport) {
		clearHighlights();
		const allIssues = [...r.critical, ...r.warnings];
		for (const issue of allIssues) {
			if (issue.element && issue.element.isConnected) {
				issue.element.setAttribute('data-sg-a11y-highlight', issue.severity);
			}
		}
		// Inject highlight CSS
		highlightStyleEl = document.createElement('style');
		highlightStyleEl.textContent = `
			[data-sg-a11y-highlight="critical"] { outline: 2px solid #ef4444 !important; outline-offset: 2px; }
			[data-sg-a11y-highlight="warning"] { outline: 2px solid #fbbf24 !important; outline-offset: 2px; }
			[data-sg-a11y-highlight="info"] { outline: 2px dashed #60a5fa !important; outline-offset: 2px; }
		`;
		document.head.appendChild(highlightStyleEl);
	}

	function clearHighlights() {
		if (typeof document === 'undefined') return;
		document.querySelectorAll('[data-sg-a11y-highlight]').forEach(el => {
			el.removeAttribute('data-sg-a11y-highlight');
		});
		if (highlightStyleEl) {
			highlightStyleEl.remove();
			highlightStyleEl = null;
		}
	}

	const mount = useDevtoolMount(() => forceEnable, () => {
		document.addEventListener('mousedown', handleClick, true);
		document.addEventListener('contextmenu', handleContextMenu, true);
		document.addEventListener('keydown', handleKeydown);
		return () => {
			document.removeEventListener('mousedown', handleClick, true);
			document.removeEventListener('contextmenu', handleContextMenu, true);
			document.removeEventListener('keydown', handleKeydown);
		};
	}, {
		onDev: () => {
			isDev = true;
			const modLabel = modifier.charAt(0).toUpperCase() + modifier.slice(1);
			console.log(`[SvelteA11yReporter] Active! ${modLabel}+RightClick element or ${modLabel}+A for full page audit`);
		}
	});

	onMount(mount.start);
	onDestroy(() => {
		mount.stop();
		clearHighlights();
		copyFb.reset();
	});
</script>

{#if isDev && showPopup && report}
	<DevToolPopup
		title="A11yReporter"
		bind:visible
		{colors}
		titleColor="#818cf8"
		{copied}
		{copyFailed}
		ariaLabel="SvelteA11yReporter"
		minWidth={420}
	>
		{#snippet headerExtra()}
			<span class="sg-a11y-element">{report?.elementTag}</span>
			{#if report}
				<span class="sg-a11y-score" style="color: {getScoreColor(report.score)}">
					{report.score}/100
				</span>
			{/if}
		{/snippet}

		<div class="sg-a11y-body">
		{#if report.file}
			<div class="sg-a11y-location">{report.file}{report.line ? ':' + report.line : ''}</div>
		{/if}

		<div class="sg-a11y-tabs">
				<button
					class="sg-a11y-tab"
					class:sg-a11y-tab-active={activeTab === 'critical'}
					onclick={() => (activeTab = 'critical')}
				>
					🔴 Critical ({report.critical.length})
				</button>
				<button
					class="sg-a11y-tab"
					class:sg-a11y-tab-active={activeTab === 'warnings'}
					onclick={() => (activeTab = 'warnings')}
				>
					🟡 Warnings ({report.warnings.length})
				</button>
				<button
					class="sg-a11y-tab"
					class:sg-a11y-tab-active={activeTab === 'passes'}
					onclick={() => (activeTab = 'passes')}
				>
					🟢 Good ({report.passes.length})
				</button>
			</div>

			<div class="sg-a11y-content">
				{#if activeTab === 'critical'}
					{#if report.critical.length === 0}
						<div class="sg-a11y-empty">No critical issues found ✅</div>
					{:else}
						{#each report.critical as issue, i (i)}
							<div class="sg-a11y-issue sg-a11y-issue-critical">
								<div class="sg-a11y-issue-header">
									<span class="sg-a11y-issue-num">{i + 1}</span>
									<span class="sg-a11y-issue-msg">{issue.message}</span>
								</div>
								<div class="sg-a11y-issue-element">{issue.elementHtml}</div>
								{#if issue.file}
									<div class="sg-a11y-issue-file">{issue.file}{issue.line ? ':' + issue.line : ''}</div>
								{/if}
								{#if issue.why}
									<div class="sg-a11y-issue-why">{issue.why}</div>
								{/if}
								<div class="sg-a11y-issue-fix">
									<span class="sg-a11y-fix-label">✅ Fix:</span>
									{issue.fix}
								</div>
								{#if issue.fixCode}
									<pre class="sg-a11y-fix-code">{issue.fixCode}</pre>
								{/if}
							</div>
						{/each}
					{/if}
				{:else if activeTab === 'warnings'}
					{#if report.warnings.length === 0}
						<div class="sg-a11y-empty">No warnings found ✅</div>
					{:else}
						{#each report.warnings as issue, i (i)}
							<div class="sg-a11y-issue sg-a11y-issue-warning">
								<div class="sg-a11y-issue-header">
									<span class="sg-a11y-issue-num">{i + 1}</span>
									<span class="sg-a11y-issue-msg">{issue.message}</span>
								</div>
								<div class="sg-a11y-issue-element">{issue.elementHtml}</div>
								{#if issue.file}
									<div class="sg-a11y-issue-file">{issue.file}{issue.line ? ':' + issue.line : ''}</div>
								{/if}
								{#if issue.why}
									<div class="sg-a11y-issue-why">{issue.why}</div>
								{/if}
								<div class="sg-a11y-issue-fix">
									<span class="sg-a11y-fix-label">⚠️</span> {issue.fix}
								</div>
								{#if issue.fixCode}
									<pre class="sg-a11y-fix-code">{issue.fixCode}</pre>
								{/if}
							</div>
						{/each}
					{/if}
				{:else}
					{#if report.passes.length === 0}
						<div class="sg-a11y-empty">No positive checks</div>
					{:else}
						{#each report.passes as pass, i (i)}
							<div class="sg-a11y-pass">✓ {pass}</div>
						{/each}
					{/if}
				{/if}
			</div>
		</div>

		{#snippet footer()}
			<DevToolButton
				onclick={() => {
					if (report) copyFb.copy(formatA11yForAgent(report));
				}}
			>Copy for Agent</DevToolButton>
			<DevToolButton
				onclick={() => {
					report = analyzeA11y(document.body, true);
					const formatted = formatA11yForAgent(report);
					registerToolOutput("A11yReporter", formatted);
					copyFb.copy(formatted);
				}}
			>Audit Full Page</DevToolButton>
		{/snippet}
	</DevToolPopup>
{/if}

<style>
	.sg-a11y-body {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.sg-a11y-element { color: #60a5fa; font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.sg-a11y-score { font-weight: 700; font-size: 13px; }

	.sg-a11y-location {
		padding: 4px 12px; font-size: 10px; color: #888;
		background: color-mix(in srgb, var(--sg-bg) 50%, black 10%);
	}

	.sg-a11y-tabs {
		display: flex; gap: 2px; padding: 4px 8px;
		border-bottom: 1px solid var(--sg-border);
	}

	.sg-a11y-tab {
		padding: 4px 8px; background: none; border: none; border-radius: 4px;
		color: #888; cursor: pointer; font-family: inherit; font-size: 10px;
	}
	.sg-a11y-tab:hover { color: var(--sg-text); background: rgba(255, 255, 255, 0.05); }
	.sg-a11y-tab-active { color: var(--sg-accent); background: rgba(255, 255, 255, 0.1); }

	.sg-a11y-content { flex: 1; overflow-y: auto; }

	.sg-a11y-empty { padding: 24px; text-align: center; color: #888; }

	.sg-a11y-issue {
		padding: 10px 12px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.05);
	}
	.sg-a11y-issue-critical { border-left: 3px solid #ef4444; }
	.sg-a11y-issue-warning { border-left: 3px solid #fbbf24; }

	.sg-a11y-issue-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
	.sg-a11y-issue-num {
		background: rgba(255, 255, 255, 0.1); width: 20px; height: 20px;
		border-radius: 50%; display: flex; align-items: center; justify-content: center;
		font-size: 10px; flex-shrink: 0;
	}
	.sg-a11y-issue-msg { flex: 1; line-height: 1.3; }

	.sg-a11y-issue-element {
		padding: 4px 8px; margin: 4px 0;
		background: rgba(255, 255, 255, 0.03); border-radius: 3px;
		font-size: 10px; color: #888; overflow-x: auto;
		white-space: nowrap;
	}

	.sg-a11y-issue-file { font-size: 10px; color: #60a5fa; padding: 2px 0; }
	.sg-a11y-issue-why {
		font-size: 10px; color: #a78bfa; padding: 4px 8px; margin: 4px 0;
		background: rgba(167, 139, 250, 0.05); border-radius: 3px;
		line-height: 1.4; font-style: italic;
	}

	.sg-a11y-issue-fix {
		margin-top: 6px; font-size: 11px; color: #4ade80; line-height: 1.4;
	}
	.sg-a11y-fix-label { font-weight: 600; }

	.sg-a11y-fix-code {
		margin: 4px 0 0; padding: 6px 8px;
		background: rgba(0, 0, 0, 0.2); border-radius: 4px;
		font-size: 10px; color: #fbbf24; overflow-x: auto;
		white-space: pre;
	}

	.sg-a11y-pass {
		padding: 8px 12px; font-size: 11px; color: #4ade80;
		border-bottom: 1px solid rgba(255, 255, 255, 0.03);
	}
</style>
