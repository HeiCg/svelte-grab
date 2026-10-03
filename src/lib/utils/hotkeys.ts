/**
 * Hotkey sets (docs/agent-runtime-spec.md, Principle 5 and Phase 6).
 *
 * - `'full'` (default): every shortcut of every tool, unchanged.
 * - `'minimal'`: only point (Alt+Click), multi (Shift+Alt+Click), region
 *   (Alt+Drag), Escape and the annotation key. The other tools stay mounted
 *   (their logic still serves the MCP runtime) but their triggers are off.
 */

import type { HotkeysMode } from '../types.js';

export type { HotkeysMode };

/** SvelteGrab's own shortcuts. */
export type GrabHotkey =
	/** Modifier+Click: grab one element. */
	| 'point'
	/** Shift+Modifier+Click: add/remove an element in the multi-selection. */
	| 'multi'
	/** Modifier+Drag: select a region. */
	| 'region'
	/** Escape: close popups / leave selection. */
	| 'escape'
	/** N while selecting: annotate the selection. */
	| 'annotate'
	/** Enter while selecting: prompt overlay. */
	| 'prompt'
	/** O with the popup open: open in editor. */
	| 'open'
	/** S with the popup open: screenshot. */
	| 'screenshot'
	/** Tab while selecting: agent relay prompt. */
	| 'relayPrompt'
	/** Modifier+?: help overlay. */
	| 'help'
	/** Arrow keys while selecting: walk the component tree. */
	| 'arrows'
	/** Cmd/Ctrl+C while selecting: copy the hovered element. */
	| 'copy'
	/** Right-click while selecting: context menu. */
	| 'contextMenu';

const MINIMAL_GRAB_HOTKEYS: ReadonlySet<GrabHotkey> = new Set<GrabHotkey>([
	'point',
	'multi',
	'region',
	'escape',
	'annotate'
]);

/** Whether a SvelteGrab shortcut is active in `mode` (`undefined` = `'full'`). */
export function isGrabHotkeyEnabled(mode: HotkeysMode | undefined, hotkey: GrabHotkey): boolean {
	return mode !== 'minimal' || MINIMAL_GRAB_HOTKEYS.has(hotkey);
}

/**
 * Whether the other tools' triggers (state, style, tracer, a11y, errors,
 * profiler) and DevKit's own Copy All / help shortcuts are active.
 */
export function toolHotkeysEnabled(mode: HotkeysMode | undefined): boolean {
	return mode !== 'minimal';
}

/** Label of the annotation key in help texts. */
export const ANNOTATION_KEY_LABEL = 'N';

/**
 * The annotation key: `N`. Matched on the typed letter; when the key produced
 * no plain letter (macOS Option+N is a dead key) on the physical key instead.
 */
export function isAnnotationKey(event: Pick<KeyboardEvent, 'key' | 'code'>): boolean {
	if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase() === 'n';
	return event.code === 'KeyN';
}

/** An extra modifier another tool combines with the primary one (e.g. Alt+Ctrl+Click). */
export type ExtraModifier = 'ctrl' | 'meta' | 'shift';

const EXTRA_MODIFIER_KEYS: Record<ExtraModifier, 'ctrlKey' | 'metaKey' | 'shiftKey'> = {
	ctrl: 'ctrlKey',
	meta: 'metaKey',
	shift: 'shiftKey'
};

/**
 * Whether a click carries one of SvelteGrab's `reservedModifiers`, i.e. it is
 * another tool's trigger (Alt+Ctrl+Click style, Alt+Meta+Click state) and
 * SvelteGrab must leave it alone. A reserved entry equal to the primary
 * `modifier` is ignored, otherwise every grab would be blocked.
 */
export function hasReservedModifier(
	event: Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>,
	reserved: readonly ExtraModifier[] | undefined,
	modifier: string
): boolean {
	if (!reserved || reserved.length === 0) return false;
	return reserved.some((m) => m !== modifier && event[EXTRA_MODIFIER_KEYS[m]]);
}

/** Inputs SvelteDevKit resolves before computing SvelteGrab's reserved modifiers. */
export interface ReservedModifierOptions {
	hotkeys: HotkeysMode | undefined;
	/** Primary modifier shared by every tool. */
	modifier: string;
	/** SvelteGrab multi-select (Shift+Alt+Click). */
	enableMultiSelect: boolean;
	stateEnabled: boolean;
	/** StateGrab's resolved secondary modifier. */
	stateModifier: ExtraModifier;
	styleEnabled: boolean;
	/** StyleGrab's secondary modifier. */
	styleModifier: ExtraModifier;
}

/**
 * Extra modifiers SvelteGrab must ignore inside SvelteDevKit: the secondary
 * modifiers of the tools whose click triggers are live. Nothing in
 * `'minimal'` mode (those triggers are off); never `'shift'` while
 * multi-select is on (Shift+Alt+Click stays multi-select); never the primary
 * modifier itself.
 */
export function resolveReservedModifiers(opts: ReservedModifierOptions): ExtraModifier[] {
	if (!toolHotkeysEnabled(opts.hotkeys)) return [];
	const reserved = new Set<ExtraModifier>();
	if (opts.stateEnabled) reserved.add(opts.stateModifier);
	if (opts.styleEnabled) reserved.add(opts.styleModifier);
	if (opts.enableMultiSelect) reserved.delete('shift');
	return [...reserved].filter((m) => m !== opts.modifier);
}
