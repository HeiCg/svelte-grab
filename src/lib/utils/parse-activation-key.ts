/**
 * Parse keyboard shortcut strings into matcher functions.
 *
 * Supports modifier aliases (cmd, command, option, opt, win, control)
 * and produces matchers for both KeyboardEvent and MouseEvent.
 */

export type ActivationKey = string | ((event: KeyboardEvent) => boolean);

export interface ParsedModifiers {
	metaKey: boolean;
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
	key: string | null;
}

/**
 * Maps common modifier aliases to their canonical ParsedModifiers property name.
 */
export const MODIFIER_MAP: Record<string, keyof Omit<ParsedModifiers, 'key'>> = {
	meta: 'metaKey',
	cmd: 'metaKey',
	command: 'metaKey',
	win: 'metaKey',
	windows: 'metaKey',
	ctrl: 'ctrlKey',
	control: 'ctrlKey',
	shift: 'shiftKey',
	alt: 'altKey',
	option: 'altKey',
	opt: 'altKey'
};

/**
 * Parse a shortcut string like "alt+shift+k" into a ParsedModifiers object.
 */
function parseString(shortcut: string): ParsedModifiers {
	const parts = shortcut.split('+').map((p) => p.trim().toLowerCase());
	const result: ParsedModifiers = {
		metaKey: false,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		key: null
	};

	for (const part of parts) {
		if (!part) continue;
		const modifierKey = MODIFIER_MAP[part];
		if (modifierKey) {
			result[modifierKey] = true;
		} else {
			result.key = part;
		}
	}

	return result;
}

/**
 * Parse an activation key into a KeyboardEvent matcher function.
 *
 * If `activationKey` is already a function, it is returned as-is.
 * String values are split on `+` to identify modifiers and a final key.
 *
 * When only modifiers are specified (no key), the matcher returns true
 * if the event's modifier state includes all required modifiers.
 *
 * When a key is specified, the matcher checks both the key and all
 * specified modifiers. If no modifiers are specified, the matcher
 * requires that no modifiers are held.
 */
export function parseActivationKey(
	activationKey: ActivationKey
): (event: KeyboardEvent) => boolean {
	if (typeof activationKey === 'function') {
		return activationKey;
	}

	const parsed = parseString(activationKey);
	const targetKey = parsed.key;

	return (event: KeyboardEvent): boolean => {
		// Modifier-only shortcut (e.g. "alt+shift")
		if (targetKey === null) {
			const metaMatches = parsed.metaKey
				? event.metaKey || event.key === 'Meta'
				: true;
			const ctrlMatches = parsed.ctrlKey
				? event.ctrlKey || event.key === 'Control'
				: true;
			const shiftMatches = parsed.shiftKey
				? event.shiftKey || event.key === 'Shift'
				: true;
			const altMatches = parsed.altKey
				? event.altKey || event.key === 'Alt'
				: true;

			return metaMatches && ctrlMatches && shiftMatches && altMatches;
		}

		// Key + optional modifiers
		const keyMatches = event.key?.toLowerCase() === targetKey;

		const hasModifier =
			parsed.metaKey || parsed.ctrlKey || parsed.shiftKey || parsed.altKey;

		const modifiersMatch = hasModifier
			? (parsed.metaKey ? event.metaKey : true) &&
				(parsed.ctrlKey ? event.ctrlKey : true) &&
				(parsed.shiftKey ? event.shiftKey : true) &&
				(parsed.altKey ? event.altKey : true)
			: !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

		return keyMatches && modifiersMatch;
	};
}

/**
 * Parse an activation key into a MouseEvent matcher function.
 *
 * Only modifier keys are checked (mouse events don't have a `.key` property).
 * If `activationKey` is a function, the modifiers default to `altKey` only.
 */
export function parseActivationKeyForMouse(
	activationKey: ActivationKey
): (event: MouseEvent) => boolean {
	if (typeof activationKey === 'function') {
		// Cannot introspect a function; default to alt
		return (event: MouseEvent) => event.altKey;
	}

	const parsed = parseString(activationKey);

	return (event: MouseEvent): boolean => {
		const hasAnyModifier =
			parsed.metaKey || parsed.ctrlKey || parsed.shiftKey || parsed.altKey;

		if (!hasAnyModifier) {
			// No modifiers specified — match any event
			return true;
		}

		return (
			(parsed.metaKey ? event.metaKey : true) &&
			(parsed.ctrlKey ? event.ctrlKey : true) &&
			(parsed.shiftKey ? event.shiftKey : true) &&
			(parsed.altKey ? event.altKey : true)
		);
	};
}

/**
 * Human-readable label for a platform symbol map.
 */
const SYMBOL_MAP: Record<string, string> = {
	meta: 'Cmd',
	cmd: 'Cmd',
	command: 'Cmd',
	win: 'Win',
	windows: 'Win',
	ctrl: 'Ctrl',
	control: 'Ctrl',
	shift: 'Shift',
	alt: 'Alt',
	option: 'Option',
	opt: 'Option'
};

/**
 * Format an activation key into a human-readable label.
 *
 * Examples:
 * - "alt+shift+k" -> "Alt + Shift + K"
 * - "cmd+s" -> "Cmd + S"
 *
 * If `activationKey` is a function, returns "Custom".
 */
export function formatActivationKeyLabel(activationKey: ActivationKey): string {
	if (typeof activationKey === 'function') {
		return 'Custom';
	}

	const parts = activationKey.split('+').map((p) => p.trim().toLowerCase());
	const labels: string[] = [];

	for (const part of parts) {
		if (!part) continue;
		const symbol = SYMBOL_MAP[part];
		if (symbol) {
			labels.push(symbol);
		} else {
			// Regular key — capitalize first letter
			labels.push(part.charAt(0).toUpperCase() + part.slice(1));
		}
	}

	return labels.join(' + ') || '';
}
