/**
 * Framework-agnostic FPS meter.
 *
 * A tiny requestAnimationFrame-based frame counter, ported from react-scan's
 * `getFPS()` (packages/scan/src/core/instrumentation.ts). It counts how many
 * frames the browser paints per second; a healthy app sits near the display's
 * refresh rate (usually 60), and a stuttering app drops well below it.
 *
 * Unlike react-scan's module-global singleton, this exposes a small instance so
 * each consumer owns its own rAF loop and can `stop()` it on teardown. It is
 * SSR-safe: if `requestAnimationFrame` is unavailable the meter simply never
 * starts and `current` stays at its seed value.
 *
 * Usage:
 *   const meter = createFpsMeter();
 *   // ...later, in a render/poll loop:
 *   const fps = meter.current;          // instantaneous (updated each second)
 *   const smooth = meter.rolling;       // EMA-smoothed reading
 *   const color = fpsColor(fps);        // red / amber / green
 *   // ...on teardown:
 *   meter.stop();
 */

/** A live FPS reading with a `stop()` to cancel its rAF loop. */
export interface FpsMeter {
	/** Most recent whole-second frame count (the "raw" FPS). */
	readonly current: number;
	/** Exponentially-smoothed FPS, less jumpy than `current`. */
	readonly rolling: number;
	/** Cancel the rAF loop. Idempotent. After this `current`/`rolling` freeze. */
	stop: () => void;
}

/**
 * Pick a status color for an FPS reading, matching react-scan's thresholds:
 * red below 30, amber below 50, green at or above 50.
 */
export function fpsColor(fps: number): string {
	if (fps < 30) return '#ef4444'; // red
	if (fps < 50) return '#f59e0b'; // amber
	return '#4ade80'; // green
}

/**
 * Start an FPS meter. Begins counting frames immediately (when rAF exists).
 *
 * @param seed - Initial reading shown before the first full second elapses.
 *   Defaults to 60 (the common refresh rate), matching react-scan.
 */
export function createFpsMeter(seed = 60): FpsMeter {
	let current = seed;
	let rolling = seed;
	let frameCount = 0;
	let lastTime =
		typeof performance !== 'undefined' ? performance.now() : Date.now();
	let rafId: number | null = null;
	let stopped = false;

	// EMA smoothing factor — higher reacts faster.
	const SMOOTHING = 0.3;

	const now = (): number =>
		typeof performance !== 'undefined' ? performance.now() : Date.now();

	const tick = (): void => {
		if (stopped) return;
		frameCount++;
		const t = now();
		const elapsed = t - lastTime;
		if (elapsed >= 1000) {
			// Normalize to a per-second rate in case the tab was throttled and the
			// window stretched past 1s.
			current = Math.round((frameCount * 1000) / elapsed);
			rolling = Math.round(rolling + (current - rolling) * SMOOTHING);
			frameCount = 0;
			lastTime = t;
		}
		rafId = requestAnimationFrame(tick);
	};

	if (typeof requestAnimationFrame !== 'undefined') {
		rafId = requestAnimationFrame(tick);
	}

	return {
		get current() {
			return current;
		},
		get rolling() {
			return rolling;
		},
		stop() {
			stopped = true;
			if (rafId !== null && typeof cancelAnimationFrame !== 'undefined') {
				cancelAnimationFrame(rafId);
			}
			rafId = null;
		}
	};
}
