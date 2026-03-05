/**
 * Utilities for freezing CSS animations, transitions, SVG animations,
 * and Web Animations API animations. Used during context capture to
 * ensure a stable visual snapshot.
 */

const FREEZE_STYLE_ID = 'data-svelte-grab-freeze';
const FREEZE_ATTR = 'data-svelte-grab-frozen';

/**
 * Freeze all animations globally. Returns an unfreeze cleanup function.
 */
export function freezeGlobalAnimations(): () => void {
	let cleaned = false;

	// 1. Inject global style to pause animations and kill transitions
	const style = document.createElement('style');
	style.setAttribute(FREEZE_STYLE_ID, '');
	style.textContent = `*, *::before, *::after { animation-play-state: paused !important; transition: none !important; }`;
	document.head.appendChild(style);

	// 2. Pause all SVG animations
	const svgElements: SVGSVGElement[] = [];
	try {
		const svgs = document.querySelectorAll('svg');
		svgs.forEach((svg) => {
			try {
				if (svg instanceof SVGSVGElement && typeof svg.pauseAnimations === 'function') {
					svg.pauseAnimations();
					svgElements.push(svg);
				}
			} catch {
				// Individual SVG may throw; skip it
			}
		});
	} catch {
		// querySelectorAll might fail in edge cases
	}

	// 3. Pause Web Animations API running animations
	const pausedAnimations: Animation[] = [];
	try {
		if (typeof document.getAnimations === 'function') {
			const animations = document.getAnimations();
			for (const anim of animations) {
				try {
					if (anim.playState === 'running') {
						anim.pause();
						pausedAnimations.push(anim);
					}
				} catch {
					// Individual animation may throw; skip it
				}
			}
		}
	} catch {
		// getAnimations not supported or threw
	}

	return () => {
		if (cleaned) return;
		cleaned = true;

		// Finish paused CSS animations so they don't jank on resume
		for (const anim of pausedAnimations) {
			try {
				anim.play();
			} catch {
				// Animation may have been removed from DOM
			}
		}

		// Unpause SVG animations
		for (const svg of svgElements) {
			try {
				if (svg.isConnected && typeof svg.unpauseAnimations === 'function') {
					svg.unpauseAnimations();
				}
			} catch {
				// SVG may have been removed
			}
		}

		// Remove injected style
		try {
			if (style.parentNode) {
				style.parentNode.removeChild(style);
			}
		} catch {
			// Style may have been removed already
		}
	};
}

/**
 * Freeze animations on specific elements. Returns an unfreeze cleanup function.
 *
 * Sets a data attribute on each element and injects a scoped style targeting
 * those attributed elements and their descendants.
 */
export function freezeElementAnimations(elements: Element[]): () => void {
	let cleaned = false;
	const frozenElements: Element[] = [];

	// Mark elements
	for (const el of elements) {
		try {
			if (el.isConnected) {
				el.setAttribute(FREEZE_ATTR, '');
				frozenElements.push(el);
			}
		} catch {
			// Element may not support setAttribute
		}
	}

	// Inject scoped style
	const style = document.createElement('style');
	style.setAttribute(FREEZE_STYLE_ID, 'scoped');
	style.textContent = [
		`[${FREEZE_ATTR}], [${FREEZE_ATTR}] * {`,
		'  animation-play-state: paused !important;',
		'  transition: none !important;',
		'}',
		`[${FREEZE_ATTR}]::before, [${FREEZE_ATTR}]::after,`,
		`[${FREEZE_ATTR}] *::before, [${FREEZE_ATTR}] *::after {`,
		'  animation-play-state: paused !important;',
		'  transition: none !important;',
		'}'
	].join('\n');
	document.head.appendChild(style);

	// Pause Web Animations on targeted elements
	const pausedAnimations: Animation[] = [];
	for (const el of frozenElements) {
		try {
			if (typeof el.getAnimations === 'function') {
				for (const anim of el.getAnimations()) {
					try {
						if (anim.playState === 'running') {
							anim.pause();
							pausedAnimations.push(anim);
						}
					} catch {
						// skip
					}
				}
			}
		} catch {
			// skip
		}
	}

	return () => {
		if (cleaned) return;
		cleaned = true;

		// Resume paused animations
		for (const anim of pausedAnimations) {
			try {
				anim.play();
			} catch {
				// Animation may have been removed
			}
		}

		// Remove data attributes
		for (const el of frozenElements) {
			try {
				if (el.isConnected) {
					el.removeAttribute(FREEZE_ATTR);
				}
			} catch {
				// Element may have been removed
			}
		}

		// Remove style
		try {
			if (style.parentNode) {
				style.parentNode.removeChild(style);
			}
		} catch {
			// Style may have been removed
		}
	};
}
