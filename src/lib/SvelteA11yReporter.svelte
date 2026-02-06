<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { SvelteA11yReporterProps, A11yReport, ThemeConfig } from './types.js';
	import {
		detectDevMode,
		findSvelteElement,
		copyToClipboard,
		checkModifier
	} from './utils/shared.js';
	import { analyzeA11y, formatA11yForAgent } from './utils/a11y-checker.js';

	let {
		modifier = 'alt',
		secondaryModifier = 'shift',
		forceEnable = false,
		showPopup = true,
		theme = {},
		lightTheme = false,
		includeSubtree = true
	}: SvelteA11yReporterProps = $props();

	let baseTheme = $derived(lightTheme ? { background: '#ffffff', border: '#e0e0e0', text: '#1a1a2e', accent: '#e85d04' } : { background: '#1a1a2e', border: '#4a4a6a', text: '#e0e0e0', accent: '#ff6b35' });
	let colors = $derived({ ...baseTheme, ...theme } as Required<ThemeConfig>);

	let isDev = $state(false);
	let visible = $state(false);
	let copied = $state(false);
	let report = $state<A11yReport | null>(null);
	let activeTab = $state<'critical' | 'warnings' | 'passes'>('critical');

	function handleClick(event: MouseEvent) {
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
		copyToClipboard(formatted).then(ok => {
			if (ok) { copied = true; setTimeout(() => (copied = false), 1500); }
		});

		console.log('[SvelteA11yReporter] A11y report:\n' + formatted);
		if (showPopup) visible = true;
	}

	function handleContextMenu(event: MouseEvent) {
		if (!checkModifier(event, modifier)) return;
		event.preventDefault(); // Prevent default context menu
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && visible) visible = false;

		// Alt+A to analyze full page
		if (checkModifier(event, modifier) && (event.key === 'a' || event.key === 'A')) {
			event.preventDefault();
			report = analyzeA11y(document.body, true);
			if (report.critical.length > 0) activeTab = 'critical';
			else if (report.warnings.length > 0) activeTab = 'warnings';
			else activeTab = 'passes';

			const formatted = formatA11yForAgent(report);
			copyToClipboard(formatted);
			console.log('[SvelteA11yReporter] Full page a11y report:\n' + formatted);
			if (showPopup) visible = true;
		}
	}

	function getScoreColor(score: number): string {
		if (score >= 80) return '#4ade80';
		if (score >= 60) return '#fbbf24';
		return '#ef4444';
	}

	let cleanup: (() => void) | null = null;

	onMount(() => {
		setTimeout(() => {
			isDev = detectDevMode(forceEnable);
			if (!isDev) return;

			const modLabel = modifier.charAt(0).toUpperCase() + modifier.slice(1);
			console.log(`[SvelteA11yReporter] Active! ${modLabel}+RightClick element or ${modLabel}+A for full page audit`);

			document.addEventListener('mousedown', handleClick, true);
			document.addEventListener('contextmenu', handleContextMenu, true);
			document.addEventListener('keydown', handleKeydown);
			cleanup = () => {
				document.removeEventListener('mousedown', handleClick, true);
				document.removeEventListener('contextmenu', handleContextMenu, true);
				document.removeEventListener('keydown', handleKeydown);
			};
		}, 100);
	});

	onDestroy(() => cleanup?.());
</script>

{#if isDev && showPopup && visible && report}
	<div
		class="sg-a11y-overlay"
		onclick={() => (visible = false)}
		onkeydown={(e) => e.key === 'Escape' && (visible = false)}
		role="presentation"
	>
		<div
			class="sg-a11y-popup"
			style="
				--sg-bg: {colors.background};
				--sg-border: {colors.border};
				--sg-text: {colors.text};
				--sg-accent: {colors.accent};
			"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			aria-label="SvelteA11yReporter"
			tabindex="-1"
		>
			<div class="sg-a11y-header">
				<span class="sg-a11y-title">A11yReporter</span>
				<span class="sg-a11y-element">{report.elementTag}</span>
				<span class="sg-a11y-score" style="color: {getScoreColor(report.score)}">
					{report.score}/100
				</span>
				{#if copied}<span class="sg-a11y-copied">Copied!</span>{/if}
				<button class="sg-a11y-close" onclick={() => (visible = false)} aria-label="Close">&times;</button>
			</div>

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
						{#each report.critical as issue, i}
							<div class="sg-a11y-issue sg-a11y-issue-critical">
								<div class="sg-a11y-issue-header">
									<span class="sg-a11y-issue-num">{i + 1}</span>
									<span class="sg-a11y-issue-msg">{issue.message}</span>
								</div>
								<div class="sg-a11y-issue-element">{issue.elementHtml}</div>
								{#if issue.file}
									<div class="sg-a11y-issue-file">{issue.file}{issue.line ? ':' + issue.line : ''}</div>
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
						{#each report.warnings as issue, i}
							<div class="sg-a11y-issue sg-a11y-issue-warning">
								<div class="sg-a11y-issue-header">
									<span class="sg-a11y-issue-num">{i + 1}</span>
									<span class="sg-a11y-issue-msg">{issue.message}</span>
								</div>
								<div class="sg-a11y-issue-element">{issue.elementHtml}</div>
								{#if issue.file}
									<div class="sg-a11y-issue-file">{issue.file}{issue.line ? ':' + issue.line : ''}</div>
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
						{#each report.passes as pass}
							<div class="sg-a11y-pass">✓ {pass}</div>
						{/each}
					{/if}
				{/if}
			</div>

			<div class="sg-a11y-footer">
				<button
					class="sg-a11y-btn"
					onclick={() => {
						if (report) copyToClipboard(formatA11yForAgent(report)).then(ok => {
							if (ok) { copied = true; setTimeout(() => (copied = false), 1500); }
						});
					}}
				>Copy for Agent</button>
				<button
					class="sg-a11y-btn"
					onclick={() => {
						report = analyzeA11y(document.body, true);
						const formatted = formatA11yForAgent(report);
						copyToClipboard(formatted);
					}}
				>Audit Full Page</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.sg-a11y-overlay {
		position: fixed; inset: 0; z-index: 99999; background: rgba(0, 0, 0, 0.3);
	}

	.sg-a11y-popup {
		position: fixed; top: 50%; left: 50%;
		transform: translate(-50%, -50%);
		background: var(--sg-bg); border: 1px solid var(--sg-border);
		border-radius: 8px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
		min-width: 420px; max-width: 650px; max-height: 550px;
		overflow: hidden;
		font-family: ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
		font-size: 12px; color: var(--sg-text);
		display: flex; flex-direction: column;
	}

	.sg-a11y-header {
		display: flex; align-items: center; gap: 8px; padding: 8px 12px;
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
		border-bottom: 1px solid var(--sg-border);
	}

	.sg-a11y-title { color: #818cf8; font-weight: 600; }
	.sg-a11y-element { color: #60a5fa; font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.sg-a11y-score { font-weight: 700; font-size: 13px; }
	.sg-a11y-copied { color: #4ade80; font-size: 11px; }

	.sg-a11y-close {
		background: none; border: none; color: #888; cursor: pointer;
		padding: 2px 6px; font-size: 14px; border-radius: 4px;
	}
	.sg-a11y-close:hover { color: #fff; background: rgba(255, 255, 255, 0.1); }

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

	.sg-a11y-footer {
		display: flex; gap: 8px; padding: 8px 12px;
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
		border-top: 1px solid var(--sg-border);
	}

	.sg-a11y-btn {
		flex: 1; padding: 6px 12px;
		background: rgba(255, 255, 255, 0.1); border: 1px solid var(--sg-border);
		border-radius: 4px; color: var(--sg-text); cursor: pointer;
		font-size: 11px; font-family: inherit;
	}
	.sg-a11y-btn:hover { background: rgba(255, 255, 255, 0.15); }
</style>
