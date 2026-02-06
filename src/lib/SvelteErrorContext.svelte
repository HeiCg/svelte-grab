<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { SvelteErrorContextProps, CapturedError, ThemeConfig } from './types.js';
	import {
		detectDevMode,
		copyToClipboard,
		checkModifier,
		modifierKeyName
	} from './utils/shared.js';
	import {
		parseStackTrace,
		filterFrames,
		findSvelteFrame,
		extractComponentFromFrame,
		shortenFramePath,
		errorId,
		detectErrorPattern,
		formatErrorsForAgent
	} from './utils/error-parser.js';

	let {
		modifier = 'alt',
		secondaryModifier = 'shift',
		forceEnable = false,
		showPopup = true,
		theme = {},
		lightTheme = false,
		maxErrors = 50,
		bufferMinutes = 5,
		filterNodeModules = true
	}: SvelteErrorContextProps = $props();

	let baseTheme = $derived(lightTheme ? { background: '#ffffff', border: '#e0e0e0', text: '#1a1a2e', accent: '#e85d04' } : { background: '#1a1a2e', border: '#4a4a6a', text: '#e0e0e0', accent: '#ff6b35' });
	let colors = $derived({ ...baseTheme, ...theme } as Required<ThemeConfig>);

	let isDev = $state(false);
	let visible = $state(false);
	let copied = $state(false);
	let errors = $state<CapturedError[]>([]);
	let filterType = $state<'all' | 'error' | 'warning'>('all');

	let filteredErrors = $derived(
		filterType === 'all' ? errors : errors.filter(e =>
			filterType === 'error'
				? e.type === 'error' || e.type === 'unhandled-rejection'
				: e.type === 'warning'
		)
	);

	let errorCount = $derived(errors.filter(e => e.type === 'error' || e.type === 'unhandled-rejection').length);
	let warningCount = $derived(errors.filter(e => e.type === 'warning').length);

	// Original console functions
	let originalConsoleError: typeof console.error;
	let originalConsoleWarn: typeof console.warn;

	function addError(type: CapturedError['type'], message: string, errorObj?: Error) {
		const stack = errorObj?.stack
			? filterFrames(parseStackTrace(errorObj.stack), filterNodeModules)
			: [];

		const svelteFrame = findSvelteFrame(stack);
		const id = errorId(message, stack);

		// Deduplication
		const existing = errors.find(e => e.id === id);
		if (existing) {
			existing.count++;
			existing.timestamp = Date.now();
			errors = [...errors];
			return;
		}

		const newError: CapturedError = {
			id,
			type,
			message: String(message).slice(0, 500),
			timestamp: Date.now(),
			count: 1,
			stack,
			svelteFile: svelteFrame ? shortenFramePath(svelteFrame.file) : undefined,
			svelteLine: svelteFrame?.line,
			componentName: svelteFrame ? extractComponentFromFrame(svelteFrame) ?? undefined : undefined
		};

		errors = [newError, ...errors].slice(0, maxErrors);
	}

	function pruneOldErrors() {
		const cutoff = Date.now() - bufferMinutes * 60 * 1000;
		errors = errors.filter(e => e.timestamp > cutoff);
	}

	function clearErrors() {
		errors = [];
	}

	function handleKeyCombo(event: KeyboardEvent) {
		// Alt+E (or configured modifier+E) to toggle popup
		if (checkModifier(event, modifier) && (event.key === 'e' || event.key === 'E')) {
			event.preventDefault();
			visible = !visible;
		}
		if (event.key === 'Escape' && visible) {
			visible = false;
		}
	}

	let cleanup: (() => void) | null = null;
	let pruneInterval: ReturnType<typeof setInterval>;

	onMount(() => {
		setTimeout(() => {
			isDev = detectDevMode(forceEnable);
			if (!isDev) return;

			// Intercept console.error
			originalConsoleError = console.error;
			console.error = (...args: unknown[]) => {
				originalConsoleError.apply(console, args);
				const message = args.map(a => {
					if (a instanceof Error) return a.message;
					if (typeof a === 'string') return a;
					try { return JSON.stringify(a); } catch { return String(a); }
				}).join(' ');
				const errorObj = args.find(a => a instanceof Error) as Error | undefined;
				addError('error', message, errorObj || new Error(message));
			};

			// Intercept console.warn
			originalConsoleWarn = console.warn;
			console.warn = (...args: unknown[]) => {
				originalConsoleWarn.apply(console, args);
				const message = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
				addError('warning', message);
			};

			// Global error handler
			const onError = (event: ErrorEvent) => {
				addError('error', event.message, event.error);
			};

			// Unhandled rejection handler
			const onRejection = (event: PromiseRejectionEvent) => {
				const message = event.reason instanceof Error
					? event.reason.message
					: String(event.reason);
				addError('unhandled-rejection', message, event.reason instanceof Error ? event.reason : undefined);
			};

			window.addEventListener('error', onError);
			window.addEventListener('unhandledrejection', onRejection);
			document.addEventListener('keydown', handleKeyCombo);

			// Periodic prune
			pruneInterval = setInterval(pruneOldErrors, 30000);

			const modLabel = modifier.charAt(0).toUpperCase() + modifier.slice(1);
			console.log(`[SvelteErrorContext] Active! Press ${modLabel}+E to view captured errors`);

			cleanup = () => {
				console.error = originalConsoleError;
				console.warn = originalConsoleWarn;
				window.removeEventListener('error', onError);
				window.removeEventListener('unhandledrejection', onRejection);
				document.removeEventListener('keydown', handleKeyCombo);
				clearInterval(pruneInterval);
			};
		}, 100);
	});

	onDestroy(() => cleanup?.());
</script>

<!-- Error badge indicator -->
{#if isDev && errors.length > 0 && !visible}
	<button
		class="sg-error-badge"
		class:sg-error-badge-light={lightTheme}
		onclick={() => (visible = true)}
		title="View captured errors ({errors.length})"
		aria-label="{errors.length} errors captured"
	>
		{#if errorCount > 0}
			<span class="sg-error-badge-count sg-error-badge-error">{errorCount}</span>
		{/if}
		{#if warningCount > 0}
			<span class="sg-error-badge-count sg-error-badge-warn">{warningCount}</span>
		{/if}
	</button>
{/if}

{#if isDev && showPopup && visible}
	<div
		class="sg-error-overlay"
		onclick={() => (visible = false)}
		onkeydown={(e) => e.key === 'Escape' && (visible = false)}
		role="presentation"
	>
		<div
			class="sg-error-popup"
			style="
				--sg-bg: {colors.background};
				--sg-border: {colors.border};
				--sg-text: {colors.text};
				--sg-accent: {colors.accent};
			"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			aria-label="SvelteErrorContext"
			tabindex="-1"
		>
			<div class="sg-error-header">
				<span class="sg-error-title">ErrorContext</span>
				<div class="sg-error-filters">
					<button
						class="sg-error-filter"
						class:sg-error-filter-active={filterType === 'all'}
						onclick={() => (filterType = 'all')}
					>All ({errors.length})</button>
					<button
						class="sg-error-filter"
						class:sg-error-filter-active={filterType === 'error'}
						onclick={() => (filterType = 'error')}
					>🔴 ({errorCount})</button>
					<button
						class="sg-error-filter"
						class:sg-error-filter-active={filterType === 'warning'}
						onclick={() => (filterType = 'warning')}
					>🟡 ({warningCount})</button>
				</div>
				{#if copied}<span class="sg-error-copied">Copied!</span>{/if}
				<button class="sg-error-close" onclick={() => (visible = false)} aria-label="Close">&times;</button>
			</div>

			<div class="sg-error-content">
				{#if filteredErrors.length === 0}
					<div class="sg-error-empty">
						{errors.length === 0 ? `No errors captured (last ${bufferMinutes}min)` : 'No errors in this filter'}
					</div>
				{:else}
					{#each filteredErrors as error (error.id)}
						{@const pattern = detectErrorPattern(error)}
						<div class="sg-error-item" class:sg-error-item-error={error.type !== 'warning'} class:sg-error-item-warning={error.type === 'warning'}>
							<div class="sg-error-item-header">
								<span class="sg-error-icon">
									{error.type === 'warning' ? '🟡' : '🔴'}
								</span>
								<span class="sg-error-message">{error.message}</span>
								{#if error.count > 1}
									<span class="sg-error-count">{error.count}x</span>
								{/if}
								<span class="sg-error-time">{new Date(error.timestamp).toLocaleTimeString()}</span>
							</div>

							{#if error.svelteFile}
								<div class="sg-error-location">
									📍 {error.svelteFile}{error.svelteLine ? ':' + error.svelteLine : ''}
									{#if error.componentName}
										<span class="sg-error-comp">&lt;{error.componentName}&gt;</span>
									{/if}
								</div>
							{/if}

							{#if error.stack.length > 0}
								<div class="sg-error-stack">
									{#each error.stack.slice(0, 4) as frame}
										<div class="sg-error-frame">
											{frame.functionName} → {shortenFramePath(frame.file)}:{frame.line}
										</div>
									{/each}
								</div>
							{/if}

							{#if pattern}
								<div class="sg-error-pattern">
									<div class="sg-error-cause">💡 {pattern.cause}</div>
									<div class="sg-error-suggestion">✅ {pattern.suggestion}</div>
								</div>
							{/if}
						</div>
					{/each}
				{/if}
			</div>

			<div class="sg-error-footer">
				<button
					class="sg-error-btn"
					onclick={() => {
						copyToClipboard(formatErrorsForAgent(filteredErrors, bufferMinutes)).then(ok => {
							if (ok) { copied = true; setTimeout(() => (copied = false), 1500); }
						});
					}}
				>Copy for Agent</button>
				<button class="sg-error-btn sg-error-btn-secondary" onclick={clearErrors}>Clear All</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.sg-error-badge {
		position: fixed;
		bottom: 16px;
		left: 16px;
		z-index: 99997;
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 6px 10px;
		background: rgba(26, 26, 46, 0.95);
		border: 1px solid rgba(239, 68, 68, 0.4);
		border-radius: 20px;
		cursor: pointer;
		font-family: ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
		font-size: 11px;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
	}
	.sg-error-badge:hover { border-color: rgba(239, 68, 68, 0.7); }
	.sg-error-badge-light { background: rgba(255, 255, 255, 0.95); }

	.sg-error-badge-count {
		padding: 1px 6px;
		border-radius: 10px;
		font-weight: 600;
		font-size: 10px;
	}
	.sg-error-badge-error { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
	.sg-error-badge-warn { background: rgba(251, 191, 36, 0.2); color: #fbbf24; }

	.sg-error-overlay {
		position: fixed;
		inset: 0;
		z-index: 99999;
		background: rgba(0, 0, 0, 0.3);
	}

	.sg-error-popup {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		background: var(--sg-bg);
		border: 1px solid var(--sg-border);
		border-radius: 8px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
		min-width: 450px;
		max-width: 700px;
		max-height: 550px;
		overflow: hidden;
		font-family: ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
		font-size: 12px;
		color: var(--sg-text);
		display: flex;
		flex-direction: column;
	}

	.sg-error-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
		border-bottom: 1px solid var(--sg-border);
	}

	.sg-error-title { color: #ef4444; font-weight: 600; }

	.sg-error-filters { display: flex; gap: 4px; flex: 1; }

	.sg-error-filter {
		padding: 2px 8px;
		background: none;
		border: 1px solid transparent;
		border-radius: 4px;
		color: #888;
		cursor: pointer;
		font-family: inherit;
		font-size: 10px;
	}
	.sg-error-filter:hover { color: var(--sg-text); }
	.sg-error-filter-active { border-color: var(--sg-border); color: var(--sg-text); background: rgba(255, 255, 255, 0.05); }

	.sg-error-copied { color: #4ade80; font-size: 11px; }
	.sg-error-close {
		background: none; border: none; color: #888; cursor: pointer;
		padding: 2px 6px; font-size: 14px; border-radius: 4px;
	}
	.sg-error-close:hover { color: #fff; background: rgba(255, 255, 255, 0.1); }

	.sg-error-content { flex: 1; overflow-y: auto; }

	.sg-error-empty {
		padding: 24px;
		text-align: center;
		color: #888;
		font-size: 13px;
	}

	.sg-error-item {
		padding: 10px 12px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.05);
	}
	.sg-error-item-error { border-left: 3px solid #ef4444; }
	.sg-error-item-warning { border-left: 3px solid #fbbf24; }

	.sg-error-item-header {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin-bottom: 4px;
	}
	.sg-error-icon { flex-shrink: 0; }
	.sg-error-message { flex: 1; word-break: break-word; line-height: 1.4; }
	.sg-error-count {
		flex-shrink: 0;
		background: rgba(239, 68, 68, 0.2);
		color: #ef4444;
		padding: 1px 5px;
		border-radius: 8px;
		font-size: 10px;
		font-weight: 600;
	}
	.sg-error-time { flex-shrink: 0; color: #666; font-size: 10px; }

	.sg-error-location {
		padding: 4px 0 4px 20px;
		font-size: 11px;
		color: #60a5fa;
	}
	.sg-error-comp {
		color: #a78bfa;
		margin-left: 4px;
	}

	.sg-error-stack {
		padding: 4px 0 4px 20px;
		font-size: 10px;
		color: #888;
	}
	.sg-error-frame { padding: 1px 0; }

	.sg-error-pattern {
		margin-top: 6px;
		padding: 6px 8px;
		background: rgba(255, 255, 255, 0.03);
		border-radius: 4px;
		font-size: 11px;
	}
	.sg-error-cause { color: #fbbf24; margin-bottom: 4px; }
	.sg-error-suggestion { color: #4ade80; white-space: pre-line; }

	.sg-error-footer {
		display: flex;
		gap: 8px;
		padding: 8px 12px;
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
		border-top: 1px solid var(--sg-border);
	}

	.sg-error-btn {
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
	.sg-error-btn:hover { background: rgba(255, 255, 255, 0.15); }
	.sg-error-btn-secondary { flex: 0; }
</style>
