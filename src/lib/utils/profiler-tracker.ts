import type { RenderEvent, ComponentProfile, RenderBurst } from '../types.js';
import { type SvelteElement, shortenPath, extractComponentName } from './shared.js';

/**
 * Render profiler that tracks DOM mutations and correlates with Svelte components
 */
export class ProfilerTracker {
	private events: RenderEvent[] = [];
	private observer: MutationObserver | null = null;
	private startTime = 0;
	private burstThreshold: number;
	private burstWindow: number;

	constructor(burstThreshold = 20, burstWindow = 1000) {
		this.burstThreshold = burstThreshold;
		this.burstWindow = burstWindow;
	}

	/**
	 * Start profiling
	 */
	start(): void {
		this.events = [];
		this.startTime = performance.now();

		this.observer = new MutationObserver((mutations) => {
			const now = performance.now();

			// Group mutations by their closest Svelte component
			const componentMutations = new Map<string, { file: string; name: string; count: number }>();

			for (const mutation of mutations) {
				const target = mutation.target as HTMLElement;
				if (!target || !(target instanceof HTMLElement)) continue;

				// Skip our own UI elements
				if (target.closest('[class*="svelte-grab-"]') || target.closest('[class*="svelte-devkit-"]')) continue;

				const svelteEl = this.findClosestSvelteElement(target);
				if (!svelteEl) continue;

				const meta = svelteEl.__svelte_meta;
				if (!meta?.loc) continue;

				const file = meta.loc.file;
				const key = file;

				if (componentMutations.has(key)) {
					componentMutations.get(key)!.count++;
				} else {
					componentMutations.set(key, {
						file,
						name: extractComponentName(file) || 'unknown',
						count: 1
					});
				}
			}

			// Record events
			for (const [, comp] of componentMutations) {
				this.events.push({
					componentFile: comp.file,
					componentName: comp.name,
					timestamp: now,
					type: 'mutation',
					mutationCount: comp.count
				});
			}
		});

		this.observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			characterData: true
		});
	}

	/**
	 * Stop profiling
	 */
	stop(): void {
		this.observer?.disconnect();
		this.observer = null;
	}

	/**
	 * Find closest ancestor with __svelte_meta
	 */
	private findClosestSvelteElement(el: HTMLElement): SvelteElement | null {
		let current: HTMLElement | null = el;
		while (current) {
			if ((current as SvelteElement).__svelte_meta?.loc) {
				return current as SvelteElement;
			}
			current = current.parentElement;
		}
		return null;
	}

	/**
	 * Get profiling duration in seconds
	 */
	getDuration(): number {
		return (performance.now() - this.startTime) / 1000;
	}

	/**
	 * Get aggregated component profiles
	 */
	getProfiles(): ComponentProfile[] {
		const profileMap = new Map<string, ComponentProfile>();

		for (const event of this.events) {
			const existing = profileMap.get(event.componentFile);
			if (existing) {
				existing.renderCount += event.mutationCount;
				existing.lastRender = event.timestamp;
			} else {
				profileMap.set(event.componentFile, {
					file: event.componentFile,
					name: event.componentName,
					renderCount: event.mutationCount,
					firstRender: event.timestamp,
					lastRender: event.timestamp,
					burstCount: 0,
					averageInterval: 0
				});
			}
		}

		// Calculate averages and detect bursts
		for (const [file, profile] of profileMap) {
			const fileEvents = this.events.filter(e => e.componentFile === file);
			if (fileEvents.length > 1) {
				const intervals: number[] = [];
				for (let i = 1; i < fileEvents.length; i++) {
					intervals.push(fileEvents[i].timestamp - fileEvents[i - 1].timestamp);
				}
				profile.averageInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
			}

			profile.burstCount = this.detectBursts(file).length;
		}

		return Array.from(profileMap.values())
			.sort((a, b) => b.renderCount - a.renderCount);
	}

	/**
	 * Detect render bursts for a component
	 */
	detectBursts(componentFile?: string): RenderBurst[] {
		const events = componentFile
			? this.events.filter(e => e.componentFile === componentFile)
			: this.events;

		if (events.length < this.burstThreshold) return [];

		const bursts: RenderBurst[] = [];
		const byComponent = new Map<string, RenderEvent[]>();

		for (const event of events) {
			const key = event.componentFile;
			if (!byComponent.has(key)) byComponent.set(key, []);
			byComponent.get(key)!.push(event);
		}

		for (const [file, compEvents] of byComponent) {
			// Sliding window burst detection
			let windowStart = 0;
			for (let windowEnd = 0; windowEnd < compEvents.length; windowEnd++) {
				while (compEvents[windowEnd].timestamp - compEvents[windowStart].timestamp > this.burstWindow) {
					windowStart++;
				}

				const windowCount = windowEnd - windowStart + 1;
				if (windowCount >= this.burstThreshold) {
					const name = compEvents[0].componentName;
					// Avoid duplicate bursts
					const existingBurst = bursts.find(
						b => b.file === file && Math.abs(b.startTime - compEvents[windowStart].timestamp) < this.burstWindow
					);
					if (!existingBurst) {
						bursts.push({
							componentName: name,
							file,
							count: windowCount,
							startTime: compEvents[windowStart].timestamp,
							endTime: compEvents[windowEnd].timestamp,
							duration: compEvents[windowEnd].timestamp - compEvents[windowStart].timestamp
						});
					}
				}
			}
		}

		return bursts.sort((a, b) => b.count - a.count);
	}

	/**
	 * Get all raw events
	 */
	getEvents(): RenderEvent[] {
		return [...this.events];
	}

	/**
	 * Format profile for LLM
	 */
	formatForAgent(): string {
		const duration = this.getDuration();
		const profiles = this.getProfiles();
		const bursts = this.detectBursts();

		const parts: string[] = [`=== Render Profile: \u00FAltimos ${duration.toFixed(1)} segundos ===\n`];

		// Hot components
		const hot = profiles.filter(p => p.renderCount > 10 || p.burstCount > 0);
		if (hot.length > 0) {
			parts.push(`\u{1F534} HOT COMPONENTS (re-renders excessivos):\n`);
			for (const profile of hot.slice(0, 10)) {
				parts.push(`  ${profile.name} - ${profile.renderCount} renders`);
				parts.push(`     \u2502 \u{1F4CD} ${shortenPath(profile.file)}`);
				if (profile.burstCount > 0) {
					parts.push(`     \u2502 \u26A0\uFE0F ${profile.burstCount} burst(s) detectado(s)`);
				}
				if (profile.averageInterval > 0 && profile.averageInterval < 100) {
					parts.push(`     \u2502 \u23F1\uFE0F Intervalo m\u00E9dio: ${profile.averageInterval.toFixed(0)}ms (muito frequente)`);
				}
				parts.push('');
			}
		}

		// Healthy components
		const healthy = profiles.filter(p => p.renderCount <= 10 && p.burstCount === 0);
		if (healthy.length > 0) {
			parts.push(`\u{1F7E2} COMPONENTES SAUD\u00C1VEIS:\n`);
			for (const profile of healthy.slice(0, 10)) {
				parts.push(`  <${profile.name}> - ${profile.renderCount} render${profile.renderCount !== 1 ? 's' : ''} \u2713`);
			}
			parts.push('');
		}

		// Bursts timeline
		if (bursts.length > 0) {
			parts.push(`\u{1F4CA} BURSTS DETECTADOS:\n`);
			for (const burst of bursts) {
				parts.push(`  \u256D\u2500 ${burst.componentName} (burst: ${burst.count} renders em ${burst.duration.toFixed(0)}ms)`);
				parts.push(`  \u2570\u2500 ${shortenPath(burst.file)}`);
				parts.push('');
			}
		}

		if (profiles.length === 0) {
			parts.push('Nenhuma muta\u00E7\u00E3o DOM detectada durante o per\u00EDodo de profiling.');
		}

		return parts.join('\n');
	}
}
