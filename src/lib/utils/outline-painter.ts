/**
 * Full-viewport canvas overlay that flashes boxes around recently-mutated
 * elements — a simplified, main-thread port of react-scan's
 * `new-outlines/canvas.ts`.
 *
 * Differences from react-scan (intentional, to stay dependency-free and simple):
 *   - Single main-thread requestAnimationFrame loop; no OffscreenCanvas worker.
 *   - Keyed by a caller-provided string (here: the component file) so repeated
 *     mutations of the same component refresh the SAME box instead of stacking.
 *   - Boxes fade out over a fixed frame budget by lerping alpha to 0.
 *
 * Honest framing: these boxes show DOM mutations attributed to the nearest
 * Svelte component, NOT React-style renders. Labels read "×N DOM updates".
 *
 * The painter creates its own host `<div>` + `<canvas>`, sizes it to the
 * viewport using `devicePixelRatio` for crisp 1px strokes, tracks resize/scroll,
 * applies `hideFromThirdParties` so it never leaks into session-replay tools,
 * and owns/cleans up its rAF loop, listeners and DOM on `destroy()`.
 *
 * SSR-safe: `createOutlinePainter` returns a no-op painter when `document` /
 * `requestAnimationFrame` are unavailable.
 *
 * Usage:
 *   const painter = createOutlinePainter();
 *   painter.flash(el.getBoundingClientRect(), 'Counter', 3);
 *   // ...on teardown:
 *   painter.destroy();
 */

import { hideFromThirdParties } from './hide-from-third-parties.js';
import { Z_INDEX } from '../ui/tokens.js';

/** A single flash request. */
export interface OutlineFlash {
	/** Viewport-space rect of the mutated element (e.g. getBoundingClientRect). */
	rect: DOMRectReadOnly | DOMRect;
	/** Short label, typically the component name. */
	label: string;
	/** How many DOM mutations this batch represented. */
	count: number;
}

/** Options for {@link createOutlinePainter}. */
export interface OutlinePainterOptions {
	/** Box/label color as an "r,g,b" string. Defaults to react-scan purple. */
	color?: string;
	/** Frames a flash lives before it is fully faded out. Default 45. */
	totalFrames?: number;
	/** z-index of the overlay. Defaults to just below the popup overlay. */
	zIndex?: number;
}

/** A live outline painter. */
export interface OutlinePainter {
	/** Flash a box around `rect` with a `label ×count` badge. */
	flash: (rect: DOMRectReadOnly | DOMRect, label: string, count: number) => void;
	/** Batch form of {@link flash}. */
	paint: (entries: OutlineFlash[]) => void;
	/** Tear everything down: rAF, listeners, and the canvas host node. */
	destroy: () => void;
}

/** Internal active-outline record (mutable, animated each frame). */
interface ActiveOutline {
	x: number;
	y: number;
	width: number;
	height: number;
	label: string;
	count: number;
	frame: number;
}

const DEFAULT_COLOR = '115,97,230';
const DEFAULT_TOTAL_FRAMES = 45;
const MONO_FONT = "Menlo,Consolas,Monaco,'Liberation Mono','Lucida Console',monospace";

const noop: OutlinePainter = {
	flash: () => {},
	paint: () => {},
	destroy: () => {}
};

/**
 * Create a viewport-sized canvas overlay painter.
 *
 * @returns A painter, or a no-op painter in non-DOM (SSR) environments.
 */
export function createOutlinePainter(options: OutlinePainterOptions = {}): OutlinePainter {
	// SSR / non-DOM guard.
	if (
		typeof document === 'undefined' ||
		typeof window === 'undefined' ||
		typeof requestAnimationFrame === 'undefined'
	) {
		return noop;
	}

	const color = options.color ?? DEFAULT_COLOR;
	const totalFrames = options.totalFrames ?? DEFAULT_TOTAL_FRAMES;
	const zIndex = options.zIndex ?? Z_INDEX.floating;

	// Host + canvas. The host carries the redaction markers and fixed position;
	// the canvas does the painting.
	const host = document.createElement('div');
	host.setAttribute('data-svelte-grab-outline', '');
	host.style.cssText = [
		'position:fixed',
		'top:0',
		'left:0',
		'width:100%',
		'height:100%',
		'margin:0',
		'padding:0',
		'pointer-events:none',
		`z-index:${zIndex}`
	].join(';');
	hideFromThirdParties(host);

	const canvas = document.createElement('canvas');
	canvas.style.cssText =
		'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none';
	host.appendChild(canvas);
	document.body.appendChild(host);

	const ctx = canvas.getContext('2d', { alpha: true });

	// Keyed by label so repeated mutations of the same component refresh one box.
	const activeOutlines = new Map<string, ActiveOutline>();

	let dpr = Math.min(window.devicePixelRatio || 1, 2);
	let rafId: number | null = null;
	let destroyed = false;

	function resize(): void {
		if (!ctx) return;
		dpr = Math.min(window.devicePixelRatio || 1, 2);
		const w = window.innerWidth;
		const h = window.innerHeight;
		canvas.width = Math.floor(w * dpr);
		canvas.height = Math.floor(h * dpr);
		canvas.style.width = `${w}px`;
		canvas.style.height = `${h}px`;
		// Reset transform then scale so CSS-pixel coordinates map crisply.
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.scale(dpr, dpr);
	}

	resize();

	function draw(): void {
		if (destroyed || !ctx) return;

		ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

		if (activeOutlines.size === 0) {
			// Nothing to paint — pause the loop until the next flash restarts it.
			rafId = null;
			return;
		}

		ctx.font = `11px ${MONO_FONT}`;
		ctx.textBaseline = 'alphabetic';

		for (const [key, o] of activeOutlines) {
			const alpha = 1 - o.frame / totalFrames;
			o.frame++;

			if (alpha <= 0 || o.frame > totalFrames) {
				activeOutlines.delete(key);
				continue;
			}

			// Crisp 1px stroke on a pixel boundary.
			const rx = Math.round(o.x) + 0.5;
			const ry = Math.round(o.y) + 0.5;
			const rw = Math.round(o.width);
			const rh = Math.round(o.height);

			ctx.strokeStyle = `rgba(${color},${alpha})`;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.rect(rx, ry, rw, rh);
			ctx.stroke();

			ctx.fillStyle = `rgba(${color},${alpha * 0.1})`;
			ctx.fillRect(rx, ry, rw, rh);

			// Label badge: "Name ×N DOM updates".
			const text = `${o.label} ×${o.count} DOM updates`;
			const metrics = ctx.measureText(text);
			const padX = 3;
			const badgeH = 14;
			const badgeW = metrics.width + padX * 2;
			let badgeY = o.y - badgeH - 2;
			if (badgeY < 0) badgeY = o.y + 2;
			let badgeX = o.x;
			if (badgeX + badgeW > window.innerWidth) {
				badgeX = Math.max(0, window.innerWidth - badgeW);
			}
			if (badgeX < 0) badgeX = 0;

			ctx.fillStyle = `rgba(${color},${alpha})`;
			ctx.fillRect(Math.round(badgeX), Math.round(badgeY), badgeW, badgeH);
			ctx.fillStyle = `rgba(255,255,255,${alpha})`;
			ctx.fillText(text, Math.round(badgeX) + padX, Math.round(badgeY) + badgeH - 4);
		}

		rafId = requestAnimationFrame(draw);
	}

	function ensureLoop(): void {
		if (rafId === null && !destroyed) {
			rafId = requestAnimationFrame(draw);
		}
	}

	function flash(rect: DOMRectReadOnly | DOMRect, label: string, count: number): void {
		if (destroyed) return;
		// Ignore degenerate rects (detached / display:none elements).
		if (rect.width <= 0 && rect.height <= 0) return;

		const existing = activeOutlines.get(label);
		if (existing) {
			// Refresh position + bump the running count, reset the fade.
			existing.x = rect.left;
			existing.y = rect.top;
			existing.width = rect.width;
			existing.height = rect.height;
			existing.count += count;
			existing.frame = 0;
		} else {
			activeOutlines.set(label, {
				x: rect.left,
				y: rect.top,
				width: rect.width,
				height: rect.height,
				label,
				count,
				frame: 0
			});
		}
		ensureLoop();
	}

	function paint(entries: OutlineFlash[]): void {
		for (const e of entries) flash(e.rect, e.label, e.count);
	}

	// On scroll the cached viewport rects go stale; clearing avoids ghost boxes
	// lingering at the wrong position. New mutations re-flash at fresh coords.
	function onScroll(): void {
		activeOutlines.clear();
	}

	window.addEventListener('resize', resize, { passive: true });
	window.addEventListener('scroll', onScroll, { passive: true, capture: true });

	function destroy(): void {
		if (destroyed) return;
		destroyed = true;
		if (rafId !== null && typeof cancelAnimationFrame !== 'undefined') {
			cancelAnimationFrame(rafId);
		}
		rafId = null;
		window.removeEventListener('resize', resize);
		window.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
		activeOutlines.clear();
		host.remove();
	}

	return { flash, paint, destroy };
}
