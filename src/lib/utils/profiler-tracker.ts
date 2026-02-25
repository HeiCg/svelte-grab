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

	private mutationTypeCounts = new Map<string, { childList: number; attributes: number; characterData: number }>();
	private userEvents: { type: string; timestamp: number }[] = [];
	private userEventCleanup: (() => void) | null = null;

	// Burst detection cache
	private _burstsCache: Map<string, RenderBurst[]> = new Map();
	private _burstsCacheDirty = true;
	private _allBurstsCache: RenderBurst[] | null = null;

	// Pre-grouped events by component file for O(1) lookup
	private _eventsByFile: Map<string, RenderEvent[]> = new Map();

	constructor(burstThreshold = 20, burstWindow = 1000) {
		this.burstThreshold = burstThreshold;
		this.burstWindow = burstWindow;
	}

	private addEvent(event: RenderEvent): void {
		this.events.push(event);
		// Keep pre-grouped index in sync
		const fileEvents = this._eventsByFile.get(event.componentFile);
		if (fileEvents) {
			fileEvents.push(event);
		} else {
			this._eventsByFile.set(event.componentFile, [event]);
		}
		// Invalidate burst cache
		this._burstsCacheDirty = true;
		this._allBurstsCache = null;
	}

	/**
	 * Start profiling
	 */
	start(): void {
		this.events = [];
		this._eventsByFile.clear();
		this._burstsCacheDirty = true;
		this._allBurstsCache = null;
		this._burstsCache.clear();
		this.startTime = performance.now();
		this.mutationTypeCounts.clear();

		this.observer = new MutationObserver((mutations) => {
			const now = performance.now();

			// Group mutations by their closest Svelte component, tracking type breakdown
			const componentMutations = new Map<string, {
				file: string;
				name: string;
				count: number;
				type: 'childList' | 'attributes' | 'characterData';
				childList: number;
				attributes: number;
				characterData: number;
			}>();

			for (const mutation of mutations) {
				// For characterData mutations, the target is a Text node — use parentElement
				let target: HTMLElement | null;
				if (mutation.type === 'characterData') {
					target = mutation.target.parentElement;
				} else {
					target = mutation.target as HTMLElement;
				}
				if (!target || !(target instanceof HTMLElement)) continue;

				// Skip our own UI elements
				if (target.closest('[class*="svelte-grab-"]') || target.closest('[class*="svelte-devkit-"]')) continue;

				const svelteEl = this.findClosestSvelteElement(target);
				if (!svelteEl) continue;

				const meta = svelteEl.__svelte_meta;
				if (!meta?.loc) continue;

				const file = meta.loc.file;
				const mutType = mutation.type as 'childList' | 'attributes' | 'characterData';

				if (componentMutations.has(file)) {
					const entry = componentMutations.get(file)!;
					entry.count++;
					entry[mutType]++;
				} else {
					componentMutations.set(file, {
						file,
						name: extractComponentName(file) || 'unknown',
						count: 1,
						type: mutType,
						childList: mutType === 'childList' ? 1 : 0,
						attributes: mutType === 'attributes' ? 1 : 0,
						characterData: mutType === 'characterData' ? 1 : 0
					});
				}
			}

			// Record events and accumulate type counts
			for (const [, comp] of componentMutations) {
				// Determine dominant mutation type
				const dominant: 'childList' | 'attributes' | 'characterData' =
					comp.attributes >= comp.childList && comp.attributes >= comp.characterData ? 'attributes' :
					comp.childList >= comp.characterData ? 'childList' : 'characterData';

				this.addEvent({
					componentFile: comp.file,
					componentName: comp.name,
					timestamp: now,
					type: dominant === 'attributes' ? 'attribute' : dominant,
					mutationCount: comp.count
				});

				// Accumulate totals per component
				const existing = this.mutationTypeCounts.get(comp.file) || { childList: 0, attributes: 0, characterData: 0 };
				existing.childList += comp.childList;
				existing.attributes += comp.attributes;
				existing.characterData += comp.characterData;
				this.mutationTypeCounts.set(comp.file, existing);
			}
		});

		this.observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			characterData: true
		});

		// Track user interaction events for correlation
		const trackEvent = (type: string) => (e: Event) => {
			// Ignore our own UI
			const target = e.target as HTMLElement;
			if (target?.closest?.('[class*="svelte-grab-"]') || target?.closest?.('[class*="svelte-devkit-"]')) return;
			this.userEvents.push({ type, timestamp: performance.now() });
		};
		const onClick = trackEvent('click');
		const onInput = trackEvent('input');
		const onKeydown = trackEvent('keydown');
		document.addEventListener('click', onClick, true);
		document.addEventListener('input', onInput, true);
		document.addEventListener('keydown', onKeydown, true);
		this.userEventCleanup = () => {
			document.removeEventListener('click', onClick, true);
			document.removeEventListener('input', onInput, true);
			document.removeEventListener('keydown', onKeydown, true);
		};
	}

	/**
	 * Stop profiling
	 */
	stop(): void {
		this.observer?.disconnect();
		this.observer = null;
		this.userEventCleanup?.();
		this.userEventCleanup = null;
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

		// Calculate averages and detect bursts using pre-grouped events
		for (const [file, profile] of profileMap) {
			const fileEvents = this._eventsByFile.get(file) || [];
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
		// Check cache first
		const cacheKey = componentFile || '__all__';
		if (!this._burstsCacheDirty && componentFile) {
			const cached = this._burstsCache.get(cacheKey);
			if (cached) return cached;
		}
		if (!this._burstsCacheDirty && !componentFile && this._allBurstsCache) {
			return this._allBurstsCache;
		}

		const events = componentFile
			? (this._eventsByFile.get(componentFile) || [])
			: this.events;

		const bursts: RenderBurst[] = [];
		const byComponent = new Map<string, RenderEvent[]>();

		if (componentFile) {
			// Single component — use directly
			if (events.length >= this.burstThreshold) {
				byComponent.set(componentFile, events);
			}
		} else {
			// Group by component, filtering out those below threshold
			for (const event of events) {
				const key = event.componentFile;
				if (!byComponent.has(key)) byComponent.set(key, []);
				byComponent.get(key)!.push(event);
			}
		}

		for (const [file, compEvents] of byComponent) {
			// Skip components below threshold
			if (compEvents.length < this.burstThreshold) continue;

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

		const result = bursts.sort((a, b) => b.count - a.count);

		// Cache result
		if (componentFile) {
			this._burstsCache.set(cacheKey, result);
		} else {
			this._allBurstsCache = result;
			this._burstsCacheDirty = false;
		}

		return result;
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
	/**
	 * Get mutation type breakdown string for a component
	 */
	private getMutationBreakdown(file: string): string {
		const counts = this.mutationTypeCounts.get(file);
		if (!counts) return '';
		const parts: string[] = [];
		if (counts.attributes > 0) parts.push(`${counts.attributes} attribute`);
		if (counts.childList > 0) parts.push(`${counts.childList} childList`);
		if (counts.characterData > 0) parts.push(`${counts.characterData} characterData`);
		return parts.join(', ');
	}

	/**
	 * Generate ASCII timeline showing bursts positioned in time
	 */
	formatTimeline(): string {
		const duration = this.getDuration();
		const bursts = this.detectBursts();
		if (bursts.length === 0 || duration < 1) return '';

		const width = 60; // characters wide
		const lines: string[] = ['\u{1F4C8} TIMELINE:'];

		// Time axis
		const secondsTotal = Math.ceil(duration);
		const tickInterval = secondsTotal <= 10 ? 1 : secondsTotal <= 30 ? 5 : 10;

		// Place bursts on the timeline
		for (const burst of bursts.slice(0, 5)) {
			const relativeStart = (burst.startTime - this.startTime) / 1000;
			const relativeEnd = (burst.endTime - this.startTime) / 1000;
			const startPos = Math.round((relativeStart / duration) * width);
			const endPos = Math.min(width, Math.round((relativeEnd / duration) * width));

			const line = new Array(width).fill('\u2500');
			// Mark burst region
			for (let i = startPos; i <= endPos && i < width; i++) {
				line[i] = '\u2588';
			}

			const label = `${burst.componentName} ${burst.count}x`;
			lines.push(`  ${line.join('')}  ${label}`);
		}

		// Time axis with markers
		const axis = new Array(width).fill('\u2500');
		const labels: string[] = [];
		for (let t = 0; t <= secondsTotal; t += tickInterval) {
			const pos = Math.round((t / duration) * width);
			if (pos < width) {
				axis[pos] = '\u2502';
				labels.push(`${' '.repeat(Math.max(0, pos - labels.join('').length))}${t}s`);
			}
		}
		lines.push(`  ${axis.join('')}`);
		lines.push(`  ${labels.join('')}`);
		lines.push('');

		return lines.join('\n');
	}

	formatForAgent(): string {
		const duration = this.getDuration();
		const profiles = this.getProfiles();
		const bursts = this.detectBursts();
		const totalMutations = this.events.reduce((sum, e) => sum + e.mutationCount, 0);

		const parts: string[] = [`=== Render Profile: last ${duration.toFixed(1)} seconds ===\n`];

		// Hot components
		const hot = profiles.filter(p => p.renderCount > 10 || p.burstCount > 0);
		if (hot.length > 0) {
			parts.push(`\u{1F534} HOT COMPONENTS (excessive re-renders):\n`);
			for (const profile of hot.slice(0, 10)) {
				const breakdown = this.getMutationBreakdown(profile.file);
				parts.push(`  ${profile.name} - ${profile.renderCount} mutations${breakdown ? ` (${breakdown})` : ''}`);
				parts.push(`     \u2502 \u{1F4CD} ${shortenPath(profile.file)}`);
				if (profile.burstCount > 0) {
					parts.push(`     \u2502 \u26A0\uFE0F ${profile.burstCount} burst(s) detected`);
				}
				if (profile.averageInterval > 0 && profile.averageInterval < 100) {
					parts.push(`     \u2502 \u23F1\uFE0F Average interval: ${profile.averageInterval.toFixed(0)}ms (too frequent)`);
				}
				parts.push('');
			}
		}

		// Healthy components
		const healthy = profiles.filter(p => p.renderCount <= 10 && p.burstCount === 0);
		if (healthy.length > 0) {
			parts.push(`\u{1F7E2} HEALTHY COMPONENTS:\n`);
			for (const profile of healthy.slice(0, 10)) {
				parts.push(`  <${profile.name}> - ${profile.renderCount} render${profile.renderCount !== 1 ? 's' : ''} \u2713`);
			}
			parts.push('');
		}

		// Bursts timeline
		if (bursts.length > 0) {
			parts.push(`\u{1F4CA} DETECTED BURSTS:\n`);
			for (const burst of bursts) {
				parts.push(`  \u256D\u2500 ${burst.componentName} (burst: ${burst.count} renders in ${burst.duration.toFixed(0)}ms)`);
				parts.push(`  \u2570\u2500 ${shortenPath(burst.file)}`);
				parts.push('');
			}
		}

		// ASCII timeline
		const timeline = this.formatTimeline();
		if (timeline) {
			parts.push(timeline);
		}

		// Pattern-based suggestions
		const suggestions: string[] = [];

		if (totalMutations > 50 && duration < 10) {
			suggestions.push('High mutation count in short time. Consider using $derived() to memoize computed values.');
		}

		if (bursts.length > 2) {
			suggestions.push('Multiple bursts detected. Check for $effect loops or cascading reactive updates.');
		}

		// Check if a component has mostly attribute mutations (CSS/class reactivity, not data re-renders)
		for (const profile of hot) {
			const counts = this.mutationTypeCounts.get(profile.file);
			if (counts && counts.attributes > 0) {
				const total = counts.attributes + counts.childList + counts.characterData;
				if (counts.attributes / total > 0.8) {
					suggestions.push(`${profile.name}: mostly attribute mutations — likely CSS/class reactivity, not data re-renders.`);
				}
			}
		}

		// Detect cascade: multiple components bursting within close time windows
		if (bursts.length >= 2) {
			for (let i = 0; i < bursts.length - 1; i++) {
				for (let j = i + 1; j < bursts.length; j++) {
					const gap = Math.abs(bursts[j].startTime - bursts[i].endTime);
					if (gap < 5 && bursts[i].componentName !== bursts[j].componentName) {
						suggestions.push(`Possible cascade: ${bursts[i].componentName} \u2192 ${bursts[j].componentName} (${gap.toFixed(1)}ms gap). Check shared store subscriptions.`);
					}
				}
			}
		}

		// Correlate bursts with user events
		for (const burst of bursts) {
			const trigger = this.userEvents.find(
				ue => Math.abs(ue.timestamp - burst.startTime) < 200
			);
			if (trigger) {
				suggestions.push(`${burst.componentName} burst triggered by user ${trigger.type} event (within ${Math.abs(trigger.timestamp - burst.startTime).toFixed(0)}ms).`);
			}
		}

		if (suggestions.length > 0) {
			parts.push(`\u{1F4A1} SUGGESTIONS:\n`);
			for (const s of suggestions) {
				parts.push(`  - ${s}`);
			}
			parts.push('');
		}

		if (profiles.length === 0) {
			parts.push('No DOM mutations detected during the profiling period.');
		}

		return parts.join('\n');
	}
}
