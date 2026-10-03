<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { SvelteErrorContextProps, CapturedError } from './types.js';
	import {
		checkModifier
	} from './utils/shared.js';
	import {
		parseStackTrace,
		filterFrames,
		findSvelteFrame,
		extractComponentFromFrame,
		shortenFramePath,
		errorId,
		detectErrorPattern,
		formatErrorsForAgent,
		fetchSourceContext
	} from './utils/error-parser.js';
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
		maxErrors = 50,
		bufferMinutes = 5,
		filterNodeModules = true,
		enableHotkeys = true
	}: SvelteErrorContextProps = $props();

	let colors = $derived(resolveTheme(theme, lightTheme));

	let isDev = $state(false);
	let visible = $state(false);
	let copied = $state(false);
	let copyFailed = $state(false);
	let errors = $state<CapturedError[]>([]);
	let filterType = $state<'all' | 'error' | 'warning'>('all');

	const copyFb = createCopyFeedback({
		get copied() { return copied; },
		set copied(v) { copied = v; },
		get copyFailed() { return copyFailed; },
		set copyFailed(v) { copyFailed = v; }
	});

	let filteredErrors = $derived(
		filterType === 'all' ? errors : errors.filter(e =>
			filterType === 'error'
				? e.type === 'error' || e.type === 'unhandled-rejection'
				: e.type === 'warning'
		)
	);

	let errorCount = $derived(errors.filter(e => e.type === 'error' || e.type === 'unhandled-rejection').length);
	let warningCount = $derived(errors.filter(e => e.type === 'warning').length);

	// Non-enumerable marker stamped on the wrappers we install. Lets us (a) detect
	// if console.error/warn is already one of our wrappers (avoid double-patching)
	// and (b) only restore the original if WE are still the outermost patcher.
	const SG_WRAPPER_MARKER = '__sgErrorContextWrapper';

	// Original console functions + the wrappers we install, so restore can be
	// conditional (don't clobber another patcher installed after us).
	let originalConsoleError: typeof console.error;
	let originalConsoleWarn: typeof console.warn;
	let ourConsoleError: typeof console.error | null = null;
	let ourConsoleWarn: typeof console.warn | null = null;

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

		// Register for unified export
		setTimeout(() => {
			registerToolOutput('ErrorContext', formatErrorsForAgent(errors, bufferMinutes));
		}, 0);

		// Try to fetch source context asynchronously
		if (svelteFrame) {
			fetchSourceContext(svelteFrame.file, svelteFrame.line).then(ctx => {
				if (ctx) {
					const idx = errors.findIndex(e => e.id === id);
					if (idx !== -1) {
						errors[idx].sourceContext = ctx;
						errors = [...errors];
					}
				}
			}).catch(() => { /* source fetch failed, ignore */ });
		}
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
		if (enableHotkeys && checkModifier(event, modifier) && (event.key === 'e' || event.key === 'E')) {
			event.preventDefault();
			visible = !visible;
		}
		if (event.key === 'Escape' && visible) {
			visible = false;
		}
	}

	let pruneInterval: ReturnType<typeof setInterval>;

	const mount = useDevtoolMount(() => forceEnable, () => {
		// Intercept console.error — but only if it isn't already one of OUR wrappers
		// (HMR / a second instance), so we never double-patch the same instance.
		if (!(console.error as unknown as Record<string, unknown>)[SG_WRAPPER_MARKER]) {
			originalConsoleError = console.error;
			const wrapped: typeof console.error = (...args: unknown[]) => {
				originalConsoleError.apply(console, args);
				const message = args.map(a => {
					if (a instanceof Error) return a.message;
					if (typeof a === 'string') return a;
					try { return JSON.stringify(a); } catch { return String(a); }
				}).join(' ');
				const errorObj = args.find(a => a instanceof Error) as Error | undefined;
				addError('error', message, errorObj || new Error(message));
			};
			Object.defineProperty(wrapped, SG_WRAPPER_MARKER, { value: true });
			ourConsoleError = wrapped;
			console.error = wrapped;
		}

		// Intercept console.warn (same double-patch guard)
		if (!(console.warn as unknown as Record<string, unknown>)[SG_WRAPPER_MARKER]) {
			originalConsoleWarn = console.warn;
			const wrapped: typeof console.warn = (...args: unknown[]) => {
				originalConsoleWarn.apply(console, args);
				const message = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
				addError('warning', message);
			};
			Object.defineProperty(wrapped, SG_WRAPPER_MARKER, { value: true });
			ourConsoleWarn = wrapped;
			console.warn = wrapped;
		}

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

		return () => {
			// Only restore the originals if WE are still the current (outermost)
			// patcher. If another library/instance patched console AFTER us, our
			// wrapper sits in the middle of the chain; blindly assigning the
			// original would clobber the later patcher. In that case we leave our
			// wrapper in place — the later patcher chains through to it.
			if (console.error === ourConsoleError) {
				console.error = originalConsoleError;
			}
			if (console.warn === ourConsoleWarn) {
				console.warn = originalConsoleWarn;
			}
			ourConsoleError = null;
			ourConsoleWarn = null;
			window.removeEventListener('error', onError);
			window.removeEventListener('unhandledrejection', onRejection);
			document.removeEventListener('keydown', handleKeyCombo);
			clearInterval(pruneInterval);
		};
	}, {
		onDev: () => {
			isDev = true;
			const modLabel = modifier.charAt(0).toUpperCase() + modifier.slice(1);
			console.log(`[SvelteErrorContext] Active! Press ${modLabel}+E to view captured errors`);
		}
	});

	onMount(mount.start);
	onDestroy(() => {
		mount.stop();
		copyFb.reset();
	});
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

{#if isDev && showPopup}
	<DevToolPopup
		title="ErrorContext"
		bind:visible
		{colors}
		titleColor="#ef4444"
		{copied}
		{copyFailed}
		ariaLabel="SvelteErrorContext"
		minWidth={450}
	>
		{#snippet headerExtra()}
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
		{/snippet}

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
									{#each error.stack.slice(0, 4) as frame (`${frame.file}:${frame.line}:${frame.functionName}`)}
										<div class="sg-error-frame">
											{frame.functionName} → {shortenFramePath(frame.file)}:{frame.line}
										</div>
									{/each}
								</div>
							{/if}

							{#if error.sourceContext}
								<pre class="sg-error-source">{#each error.sourceContext.lines as line (line.num)}<span class={line.isCurrent ? 'sg-error-source-current' : ''}>{line.isCurrent ? '>' : ' '} {String(line.num).padStart(4)} | {line.text}
</span>{/each}</pre>
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

		{#snippet footer()}
			<DevToolButton
				onclick={() => {
					const formatted = formatErrorsForAgent(filteredErrors, bufferMinutes);
					registerToolOutput('ErrorContext', formatted);
					copyFb.copy(formatted);
				}}
			>Copy for Agent</DevToolButton>
			<DevToolButton block={false} onclick={clearErrors}>Clear All</DevToolButton>
		{/snippet}
	</DevToolPopup>
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

	.sg-error-source {
		margin: 6px 0 0 20px;
		padding: 6px 8px;
		background: rgba(0, 0, 0, 0.3);
		border-radius: 4px;
		font-size: 10px;
		color: #888;
		overflow-x: auto;
		white-space: pre;
		line-height: 1.5;
	}

	.sg-error-source-current {
		color: #fbbf24;
		background: rgba(251, 191, 36, 0.1);
	}
</style>
