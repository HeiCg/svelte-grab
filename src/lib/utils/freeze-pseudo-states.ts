/**
 * Utilities for freezing CSS pseudo-states (:hover, :focus, :focus-visible)
 * by baking computed styles inline and blocking pointer/focus events.
 * Used during context capture to preserve visual state.
 */

const POINTER_EVENTS_STYLE_ID = 'data-svelte-grab-pointer-freeze';

/** CSS properties to capture from :hover elements */
const HOVER_PROPERTIES = [
	'background-color',
	'color',
	'border-color',
	'box-shadow',
	'transform',
	'opacity',
	'outline',
	'filter',
	'scale',
	'text-decoration-color'
] as const;

/** CSS properties to capture from :focus / :focus-visible elements */
const FOCUS_PROPERTIES = [
	'outline',
	'outline-offset',
	'outline-width',
	'outline-color',
	'outline-style',
	'box-shadow',
	'border-color',
	'background-color',
	'color'
] as const;

/** Events to block on capture phase to prevent hover state changes */
const POINTER_EVENTS = [
	'mouseenter',
	'mouseleave',
	'mouseover',
	'mouseout',
	'pointerenter',
	'pointerleave',
	'pointerover',
	'pointerout'
] as const;

/** Events to block on capture phase to prevent focus state changes */
const FOCUS_EVENTS = ['focus', 'blur', 'focusin', 'focusout'] as const;

type StyleBackup = Map<string, string>;

/** Module-level reference to the pointer-events style element for suspend/resume */
let pointerEventsStyle: HTMLStyleElement | null = null;

/**
 * Stop an event from propagating (used as capture-phase listener).
 */
function blockEvent(e: Event): void {
	e.stopImmediatePropagation();
}

/**
 * Safely query elements matching a pseudo-state selector.
 * Returns an empty array if the selector throws (some browsers
 * don't support querying pseudo-states).
 */
function safeQueryPseudo(selector: string): HTMLElement[] {
	try {
		return Array.from(document.querySelectorAll<HTMLElement>(selector));
	} catch {
		return [];
	}
}

/**
 * Capture computed style values for given properties on an element.
 * Returns null if the element is disconnected or styles can't be read.
 */
function captureStyles(
	el: HTMLElement,
	properties: readonly string[]
): Record<string, string> | null {
	try {
		if (!el.isConnected) return null;
		const computed = getComputedStyle(el);
		const styles: Record<string, string> = {};
		for (const prop of properties) {
			const value = computed.getPropertyValue(prop);
			if (value) {
				styles[prop] = value;
			}
		}
		return styles;
	} catch {
		return null;
	}
}

/**
 * Backup existing inline style values for a set of properties.
 */
function backupInlineStyles(el: HTMLElement, properties: readonly string[]): StyleBackup {
	const backup: StyleBackup = new Map();
	try {
		for (const prop of properties) {
			// getPropertyValue returns '' for unset inline properties
			const value = el.style.getPropertyValue(prop);
			backup.set(prop, value);
		}
	} catch {
		// Element may not support style access
	}
	return backup;
}

/**
 * Apply captured styles as inline styles on an element.
 */
function applyInlineStyles(el: HTMLElement, styles: Record<string, string>): void {
	try {
		for (const [prop, value] of Object.entries(styles)) {
			el.style.setProperty(prop, value, 'important');
		}
	} catch {
		// Element may not support style manipulation
	}
}

/**
 * Restore inline styles from a backup map.
 */
function restoreInlineStyles(el: HTMLElement, backup: StyleBackup): void {
	try {
		if (!el.isConnected) return;
		for (const [prop, value] of backup) {
			if (value === '') {
				el.style.removeProperty(prop);
			} else {
				el.style.setProperty(prop, value);
			}
		}
	} catch {
		// Element may have been removed from DOM
	}
}

/**
 * Freeze all CSS pseudo-states (:hover, :focus, :focus-visible) by baking
 * their computed styles inline and blocking events that would change them.
 *
 * Returns an unfreeze cleanup function.
 */
export function freezePseudoStates(): () => void {
	let cleaned = false;
	const originalStyles = new Map<HTMLElement, StyleBackup>();
	const eventCleanups: Array<() => void> = [];

	// --- Capture :hover elements ---
	const hoverElements = safeQueryPseudo(':hover');
	for (const el of hoverElements) {
		const styles = captureStyles(el, HOVER_PROPERTIES);
		if (!styles) continue;

		// Backup current inline styles before overwriting
		if (!originalStyles.has(el)) {
			originalStyles.set(el, backupInlineStyles(el, HOVER_PROPERTIES));
		} else {
			// Merge backup if element appears in both hover and focus
			const existing = originalStyles.get(el)!;
			const additional = backupInlineStyles(el, HOVER_PROPERTIES);
			for (const [k, v] of additional) {
				if (!existing.has(k)) {
					existing.set(k, v);
				}
			}
		}

		applyInlineStyles(el, styles);
	}

	// --- Capture :focus and :focus-visible elements ---
	const focusElements = [
		...safeQueryPseudo(':focus'),
		...safeQueryPseudo(':focus-visible')
	];
	// Deduplicate
	const seenFocus = new Set<HTMLElement>();
	for (const el of focusElements) {
		if (seenFocus.has(el)) continue;
		seenFocus.add(el);

		const styles = captureStyles(el, FOCUS_PROPERTIES);
		if (!styles) continue;

		if (!originalStyles.has(el)) {
			originalStyles.set(el, backupInlineStyles(el, FOCUS_PROPERTIES));
		} else {
			const existing = originalStyles.get(el)!;
			const additional = backupInlineStyles(el, FOCUS_PROPERTIES);
			for (const [k, v] of additional) {
				if (!existing.has(k)) {
					existing.set(k, v);
				}
			}
		}

		applyInlineStyles(el, styles);
	}

	// --- Block pointer events on capture phase ---
	for (const eventName of POINTER_EVENTS) {
		try {
			document.addEventListener(eventName, blockEvent, true);
			eventCleanups.push(() => {
				try {
					document.removeEventListener(eventName, blockEvent, true);
				} catch {
					// ignore
				}
			});
		} catch {
			// ignore
		}
	}

	// --- Block focus events on capture phase ---
	for (const eventName of FOCUS_EVENTS) {
		try {
			document.addEventListener(eventName, blockEvent, true);
			eventCleanups.push(() => {
				try {
					document.removeEventListener(eventName, blockEvent, true);
				} catch {
					// ignore
				}
			});
		} catch {
			// ignore
		}
	}

	// --- Inject pointer-events: none on <html> ---
	const peStyle = document.createElement('style');
	peStyle.setAttribute(POINTER_EVENTS_STYLE_ID, '');
	peStyle.textContent = 'html { pointer-events: none !important; }';
	document.head.appendChild(peStyle);
	pointerEventsStyle = peStyle;

	// --- Return cleanup ---
	return () => {
		if (cleaned) return;
		cleaned = true;

		// Restore original inline styles
		for (const [el, backup] of originalStyles) {
			restoreInlineStyles(el, backup);
		}
		originalStyles.clear();

		// Remove event listeners
		for (const cleanup of eventCleanups) {
			cleanup();
		}
		eventCleanups.length = 0;

		// Remove pointer-events style
		try {
			if (peStyle.parentNode) {
				peStyle.parentNode.removeChild(peStyle);
			}
		} catch {
			// ignore
		}
		if (pointerEventsStyle === peStyle) {
			pointerEventsStyle = null;
		}
	};
}

/**
 * Temporarily remove the pointer-events freeze style.
 * Useful when you need `elementsFromPoint` to work during drag selection.
 */
export function suspendPointerEventsFreeze(): void {
	try {
		if (pointerEventsStyle && pointerEventsStyle.parentNode) {
			pointerEventsStyle.parentNode.removeChild(pointerEventsStyle);
		}
	} catch {
		// ignore
	}
}

/**
 * Re-add the pointer-events freeze style after a suspend.
 */
export function resumePointerEventsFreeze(): void {
	try {
		if (pointerEventsStyle && !pointerEventsStyle.parentNode) {
			document.head.appendChild(pointerEventsStyle);
		}
	} catch {
		// ignore
	}
}
