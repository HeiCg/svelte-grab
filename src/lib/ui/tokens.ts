/**
 * Shared design tokens for svelte-grab dev-tool UI.
 *
 * The 8 tool components currently hard-code these magic numbers (the 1500ms
 * "Copied!" timeout, the 99999 overlay z-index, the 8px popup radius, the
 * 12px / 11px / 10px font sizes, etc.). Import from here instead so every tool
 * stays visually consistent and a single edit updates them all.
 *
 * Usage:
 *   import { TOKENS, COPY_SUCCESS_MS, COPY_FAILURE_MS } from './tokens.js';
 *   setTimeout(() => (copied = false), COPY_SUCCESS_MS);
 *   // in CSS-in-JS / style strings: `z-index: ${TOKENS.zIndex.overlay}`
 */

/** Duration the "Copied!" success badge stays visible (ms). */
export const COPY_SUCCESS_MS = 1500;

/** Duration the "Copy failed" badge stays visible (ms). */
export const COPY_FAILURE_MS = 3000;

/**
 * Delay before a tool runs dev-mode detection and attaches listeners on mount.
 * Gives Svelte a tick to hydrate `__svelte_meta` onto the DOM. See
 * `use-devtool-mount.svelte.ts` for the race this guards against.
 */
export const MOUNT_DETECT_DELAY_MS = 100;

/**
 * z-index scale. The overlay sits very high so the dev tool floats above app
 * chrome; the popup sits just above its own overlay.
 */
export const Z_INDEX = {
	/** Full-screen dimming overlay behind a popup. */
	overlay: 99999,
	/** The popup / dialog itself (above its overlay). */
	popup: 100000,
	/** Floating indicators, toolbars, context menus that have no overlay. */
	floating: 99998
} as const;

/** Corner radius scale (px). */
export const RADIUS = {
	/** Small chips, badges, buttons. */
	sm: 4,
	/** Popups / dialogs. */
	md: 8
} as const;

/** Spacing scale (px). Maps to the padding/gap values the tools already use. */
export const SPACING = {
	xs: 2,
	sm: 4,
	md: 6,
	lg: 8,
	xl: 12
} as const;

/** Font size scale (px). */
export const FONT_SIZE = {
	/** Tiny metadata: file paths, type hints. */
	xs: 9,
	/** Secondary labels, attribute values. */
	sm: 10,
	/** Section headers, status badges. */
	md: 11,
	/** Body / popup default. */
	base: 12,
	/** Close button glyph. */
	lg: 14
} as const;

/** Transition durations (ms) used for hover/fade affordances. */
export const TRANSITION = {
	fast: 120,
	base: 180
} as const;

/** Monospace font stack used across all dev-tool popups. */
export const FONT_FAMILY_MONO = "ui-monospace, 'SF Mono', Menlo, Monaco, monospace";

/**
 * Aggregated token object for convenient single-import access, e.g.
 * `style="z-index: {TOKENS.zIndex.overlay}"`.
 */
export const TOKENS = {
	copySuccessMs: COPY_SUCCESS_MS,
	copyFailureMs: COPY_FAILURE_MS,
	mountDetectDelayMs: MOUNT_DETECT_DELAY_MS,
	zIndex: Z_INDEX,
	radius: RADIUS,
	spacing: SPACING,
	fontSize: FONT_SIZE,
	transition: TRANSITION,
	fontFamilyMono: FONT_FAMILY_MONO
} as const;
