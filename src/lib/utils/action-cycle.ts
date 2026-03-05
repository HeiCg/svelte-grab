/**
 * Action cycling utility.
 *
 * Cycles through an ordered list of actions, wrapping around at the end.
 * Useful for toggling between modes or stepping through a sequence of operations.
 */

export interface CycleAction {
	id: string;
	label: string;
	execute: () => void;
}

/**
 * Create an action cycler that steps through a list of actions.
 *
 * @param actions - Non-empty array of actions to cycle through
 * @returns An object with `next()`, `reset()`, and `current()` methods
 *
 * @example
 * ```ts
 * const cycler = createActionCycler([
 *   { id: 'a', label: 'Mode A', execute: () => setMode('a') },
 *   { id: 'b', label: 'Mode B', execute: () => setMode('b') },
 * ]);
 * cycler.current(); // { id: 'a', ... }
 * cycler.next();    // advances to 'b', returns it
 * cycler.next();    // wraps to 'a', returns it
 * cycler.reset();   // back to 'a'
 * ```
 */
export function createActionCycler(actions: CycleAction[]): {
	next: () => CycleAction;
	reset: () => void;
	current: () => CycleAction;
} {
	if (!actions || actions.length === 0) {
		const noop: CycleAction = { id: '', label: '', execute: () => {} };
		return {
			next: () => noop,
			reset: () => {},
			current: () => noop
		};
	}

	let index = 0;

	function current(): CycleAction {
		return actions[index];
	}

	function next(): CycleAction {
		index = (index + 1) % actions.length;
		return actions[index];
	}

	function reset(): void {
		index = 0;
	}

	return { next, reset, current };
}
