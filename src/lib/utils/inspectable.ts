/**
 * Global registry for inspectable component state.
 *
 * Usage in a Svelte component:
 *   import { inspectable } from 'svelte-grab';
 *   let count = $state(0);
 *   let name = $state('hello');
 *   $effect(() => { inspectable('MyCounter', { count, name }); });
 *
 * SvelteStateGrab will pick up values from this registry when inspecting components.
 */

const registry = new Map<string, Record<string, unknown>>();

/**
 * Register inspectable state for a component.
 * Call inside `$effect()` to keep values up-to-date reactively.
 *
 * @param id - Component identifier (typically the component name)
 * @param values - Object containing the state values to expose
 */
export function inspectable(id: string, values: Record<string, unknown>): void {
	registry.set(id, { ...values });
}

/**
 * Remove a component's inspectable state (call in onDestroy).
 */
export function uninspectable(id: string): void {
	registry.delete(id);
}

/**
 * Get inspectable state for a component by its ID.
 * Returns undefined if no state is registered.
 */
export function getInspectableState(id: string): Record<string, unknown> | undefined {
	return registry.get(id);
}

/**
 * Get all registered inspectable component IDs.
 */
export function getInspectableIds(): string[] {
	return Array.from(registry.keys());
}

/**
 * Clear all inspectable state (used in tests or cleanup).
 */
export function clearInspectableRegistry(): void {
	registry.clear();
}
