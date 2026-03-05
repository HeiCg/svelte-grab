/**
 * Singleton for coordinating keyboard focus across panels.
 * Only one panel can "own" focus at a time, preventing conflicts
 * when multiple SvelteGrab tool panels are open simultaneously.
 */

let activeId: symbol | null = null;

export const confirmationFocusManager = {
	/**
	 * Claim focus for the given panel id.
	 * Replaces any previously active panel.
	 */
	claim(id: symbol): void {
		activeId = id;
	},

	/**
	 * Release focus, but only if the caller's id is still the active one.
	 * Prevents a panel from accidentally releasing another panel's claim.
	 */
	release(id: symbol): void {
		if (activeId === id) {
			activeId = null;
		}
	},

	/**
	 * Check whether the given id currently holds focus.
	 */
	isActive(id: symbol): boolean {
		return activeId === id;
	}
};
