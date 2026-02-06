<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { SvelteRenderProfilerProps, ComponentProfile, RenderBurst, ThemeConfig } from './types.js';
	import { detectDevMode, copyToClipboard, checkModifier, shortenPath } from './utils/shared.js';
	import { ProfilerTracker } from './utils/profiler-tracker.js';

	let {
		modifier = 'alt',
		secondaryModifier = 'shift',
		forceEnable = false,
		showPopup = true,
		theme = {},
		lightTheme = false,
		profileDuration = 10,
		burstThreshold = 20,
		burstWindow = 1000
	}: SvelteRenderProfilerProps = $props();

	let baseTheme = $derived(lightTheme ? { background: '#ffffff', border: '#e0e0e0', text: '#1a1a2e', accent: '#e85d04' } : { background: '#1a1a2e', border: '#4a4a6a', text: '#e0e0e0', accent: '#ff6b35' });
	let colors = $derived({ ...baseTheme, ...theme } as Required<ThemeConfig>);

	let isDev = $state(false);
	let visible = $state(false);
	let copied = $state(false);
	let isProfiling = $state(false);
	let profiles = $state<ComponentProfile[]>([]);
	let bursts = $state<RenderBurst[]>([]);
	let duration = $state(0);
	let countdown = $state(0);

	let tracker: ProfilerTracker | null = null;
	let countdownInterval: ReturnType<typeof setInterval>;

	function startProfiling() {
		tracker = new ProfilerTracker(burstThreshold, burstWindow);
		tracker.start();
		isProfiling = true;
		countdown = profileDuration;
		profiles = [];
		bursts = [];

		countdownInterval = setInterval(() => {
			countdown--;
			if (countdown <= 0) {
				stopProfiling();
			}
		}, 1000);
	}

	function stopProfiling() {
		if (!tracker) return;
		clearInterval(countdownInterval);

		tracker.stop();
		profiles = tracker.getProfiles();
		bursts = tracker.detectBursts();
		duration = tracker.getDuration();
		isProfiling = false;
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && visible) {
			visible = false;
			return;
		}

		// Alt+P to toggle profiler
		if (checkModifier(event, modifier) && (event.key === 'p' || event.key === 'P')) {
			event.preventDefault();
			if (isProfiling) {
				stopProfiling();
			} else if (visible) {
				startProfiling();
			} else {
				visible = true;
				startProfiling();
			}
		}
	}

	function getHeatColor(renderCount: number): string {
		if (renderCount > 50) return '#ef4444';
		if (renderCount > 20) return '#fbbf24';
		if (renderCount > 10) return '#fb923c';
		return '#4ade80';
	}

	let cleanup: (() => void) | null = null;

	onMount(() => {
		setTimeout(() => {
			isDev = detectDevMode(forceEnable);
			if (!isDev) return;

			const modLabel = modifier.charAt(0).toUpperCase() + modifier.slice(1);
			console.log(`[SvelteRenderProfiler] Active! Press ${modLabel}+P to start profiling`);

			document.addEventListener('keydown', handleKeydown);
			cleanup = () => {
				document.removeEventListener('keydown', handleKeydown);
				tracker?.stop();
				clearInterval(countdownInterval);
			};
		}, 100);
	});

	onDestroy(() => cleanup?.());
</script>

{#if isDev && showPopup && visible}
	<div
		class="sg-prof-overlay"
		onclick={() => { if (!isProfiling) visible = false; }}
		onkeydown={(e) => e.key === 'Escape' && !isProfiling && (visible = false)}
		role="presentation"
	>
		<div
			class="sg-prof-popup"
			style="
				--sg-bg: {colors.background};
				--sg-border: {colors.border};
				--sg-text: {colors.text};
				--sg-accent: {colors.accent};
			"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			aria-label="SvelteRenderProfiler"
			tabindex="-1"
		>
			<div class="sg-prof-header">
				<span class="sg-prof-title">RenderProfiler</span>
				{#if isProfiling}
					<span class="sg-prof-recording">🔴 Recording... {countdown}s</span>
				{:else if profiles.length > 0}
					<span class="sg-prof-duration">{duration.toFixed(1)}s captured</span>
				{/if}
				{#if copied}<span class="sg-prof-copied">Copied!</span>{/if}
				<button class="sg-prof-close" onclick={() => { if (!isProfiling) visible = false; }} aria-label="Close">&times;</button>
			</div>

			<div class="sg-prof-content">
				{#if isProfiling}
					<div class="sg-prof-recording-ui">
						<div class="sg-prof-pulse"></div>
						<p>Profiling in progress...</p>
						<p class="sg-prof-hint">Interact with the page normally. The profiler is monitoring DOM mutations.</p>
						<button class="sg-prof-btn sg-prof-btn-stop" onclick={stopProfiling}>
							Stop ({countdown}s remaining)
						</button>
					</div>
				{:else if profiles.length === 0}
					<div class="sg-prof-empty">
						<p>Press "Start" to begin recording mutations.</p>
						<p class="sg-prof-hint">The profiler monitors DOM changes and correlates them with Svelte components.</p>
					</div>
				{:else}
					<!-- Hot components -->
					{@const hot = profiles.filter(p => p.renderCount > 10 || p.burstCount > 0)}
					{#if hot.length > 0}
						<div class="sg-prof-section-title">🔴 HOT COMPONENTS</div>
						{#each hot as profile}
							<div class="sg-prof-row">
								<div class="sg-prof-bar" style="width: {Math.min(100, (profile.renderCount / (profiles[0]?.renderCount || 1)) * 100)}%; background: {getHeatColor(profile.renderCount)};"></div>
								<div class="sg-prof-row-info">
									<span class="sg-prof-name">&lt;{profile.name}&gt;</span>
									<span class="sg-prof-count" style="color: {getHeatColor(profile.renderCount)}">{profile.renderCount}</span>
									<span class="sg-prof-file">{shortenPath(profile.file)}</span>
									{#if profile.burstCount > 0}
										<span class="sg-prof-burst-badge">⚠️ {profile.burstCount} burst{profile.burstCount > 1 ? 's' : ''}</span>
									{/if}
								</div>
							</div>
						{/each}
					{/if}

					<!-- Healthy components -->
					{@const healthy = profiles.filter(p => p.renderCount <= 10 && p.burstCount === 0)}
					{#if healthy.length > 0}
						<div class="sg-prof-section-title">🟢 HEALTHY COMPONENTS</div>
						{#each healthy as profile}
							<div class="sg-prof-row sg-prof-row-healthy">
								<div class="sg-prof-row-info">
									<span class="sg-prof-name">&lt;{profile.name}&gt;</span>
									<span class="sg-prof-count" style="color: #4ade80">{profile.renderCount}</span>
									<span class="sg-prof-file">{shortenPath(profile.file)}</span>
								</div>
							</div>
						{/each}
					{/if}

					<!-- Bursts -->
					{#if bursts.length > 0}
						<div class="sg-prof-section-title">📊 DETECTED BURSTS</div>
						{#each bursts as burst}
							<div class="sg-prof-burst">
								<span class="sg-prof-burst-name">{burst.componentName}</span>
								<span class="sg-prof-burst-info">{burst.count} renders in {burst.duration.toFixed(0)}ms</span>
							</div>
						{/each}
					{/if}
				{/if}
			</div>

			<div class="sg-prof-footer">
				{#if !isProfiling}
					<button class="sg-prof-btn sg-prof-btn-primary" onclick={startProfiling}>
						{profiles.length > 0 ? 'Profile Again' : 'Start Profiling'}
					</button>
				{/if}
				{#if profiles.length > 0 && !isProfiling}
					<button
						class="sg-prof-btn"
						onclick={() => {
							if (tracker) copyToClipboard(tracker.formatForAgent()).then(ok => {
								if (ok) { copied = true; setTimeout(() => (copied = false), 1500); }
							});
						}}
					>Copy for Agent</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.sg-prof-overlay {
		position: fixed; inset: 0; z-index: 99999; background: rgba(0, 0, 0, 0.3);
	}

	.sg-prof-popup {
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

	.sg-prof-header {
		display: flex; align-items: center; gap: 8px; padding: 8px 12px;
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
		border-bottom: 1px solid var(--sg-border);
	}

	.sg-prof-title { color: #f97316; font-weight: 600; }
	.sg-prof-recording { color: #ef4444; font-size: 11px; flex: 1; animation: blink 1s infinite; }
	.sg-prof-duration { color: #888; font-size: 11px; flex: 1; }
	.sg-prof-copied { color: #4ade80; font-size: 11px; }

	@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

	.sg-prof-close {
		background: none; border: none; color: #888; cursor: pointer;
		padding: 2px 6px; font-size: 14px; border-radius: 4px;
	}
	.sg-prof-close:hover { color: #fff; background: rgba(255, 255, 255, 0.1); }

	.sg-prof-content { flex: 1; overflow-y: auto; }

	.sg-prof-recording-ui {
		padding: 24px; text-align: center;
	}

	.sg-prof-pulse {
		width: 16px; height: 16px; margin: 0 auto 12px;
		background: #ef4444; border-radius: 50%;
		animation: pulse-anim 1.5s infinite;
	}

	@keyframes pulse-anim {
		0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5); }
		70% { box-shadow: 0 0 0 12px rgba(239, 68, 68, 0); }
		100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
	}

	.sg-prof-hint { color: #888; font-size: 11px; margin-top: 8px; }

	.sg-prof-empty { padding: 24px; text-align: center; color: #888; }

	.sg-prof-section-title {
		padding: 8px 12px; font-size: 10px; font-weight: 600;
		text-transform: uppercase; color: #888; letter-spacing: 0.5px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.05);
		margin-top: 4px;
	}

	.sg-prof-row {
		position: relative; padding: 6px 12px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.03);
	}

	.sg-prof-bar {
		position: absolute; left: 0; top: 0; bottom: 0;
		opacity: 0.1; border-radius: 0 4px 4px 0;
	}

	.sg-prof-row-info {
		position: relative; display: flex; align-items: center; gap: 8px;
	}

	.sg-prof-row-healthy { opacity: 0.7; }

	.sg-prof-name { color: #60a5fa; font-weight: 500; min-width: 100px; }
	.sg-prof-count { font-weight: 700; min-width: 40px; text-align: right; }
	.sg-prof-file { color: #888; font-size: 10px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

	.sg-prof-burst-badge {
		font-size: 9px; padding: 1px 5px;
		background: rgba(251, 191, 36, 0.2); color: #fbbf24;
		border-radius: 8px; flex-shrink: 0;
	}

	.sg-prof-burst {
		display: flex; align-items: center; gap: 8px;
		padding: 6px 12px; font-size: 11px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.03);
	}
	.sg-prof-burst-name { color: #fbbf24; font-weight: 500; }
	.sg-prof-burst-info { color: #888; }

	.sg-prof-footer {
		display: flex; gap: 8px; padding: 8px 12px;
		background: color-mix(in srgb, var(--sg-bg) 70%, white 10%);
		border-top: 1px solid var(--sg-border);
	}

	.sg-prof-btn {
		flex: 1; padding: 6px 12px;
		background: rgba(255, 255, 255, 0.1); border: 1px solid var(--sg-border);
		border-radius: 4px; color: var(--sg-text); cursor: pointer;
		font-size: 11px; font-family: inherit;
	}
	.sg-prof-btn:hover { background: rgba(255, 255, 255, 0.15); }

	.sg-prof-btn-primary {
		background: rgba(249, 115, 22, 0.2); border-color: #f97316; color: #f97316;
	}
	.sg-prof-btn-primary:hover { background: rgba(249, 115, 22, 0.3); }

	.sg-prof-btn-stop {
		background: rgba(239, 68, 68, 0.2); border-color: #ef4444; color: #ef4444;
		margin-top: 12px;
	}
	.sg-prof-btn-stop:hover { background: rgba(239, 68, 68, 0.3); }
</style>
