/**
 * Registry for inspectable component state, read by SvelteStateGrab.
 *
 * Usage in a Svelte component (recommended form, auto-cleans on destroy):
 *
 *   import { inspectable } from 'svelte-grab';
 *   let count = $state(0);
 *   let user = $state({ name: 'Ada', tags: [] });
 *   $effect(() => inspectable('MyCounter', { count, user }));
 *
 * The block form `$effect(() => { inspectable('MyCounter', { count }); })`
 * also cleans up on its own (see below), so existing code keeps working.
 *
 * Each mounted component instance gets its own entry: two `<MyCounter>`s show
 * up as `MyCounter #1` and `MyCounter #2` instead of overwriting each other.
 *
 * Snapshot semantics: values are copied with `$state.snapshot` at call time,
 * inside the caller's `$effect`. That deep read makes the effect depend on
 * nested state too (e.g. `user.tags.push(...)` re-runs it), so the registry
 * always holds the latest plain-data snapshot. Snapshots are replaced, never
 * mutated, so what SvelteStateGrab reads at grab time stays frozen as the
 * state at that moment, with no live `$state` proxies leaking into the popup
 * or the serializer.
 *
 * Plain-TS core: `inspectable-registry.ts` (unit-tested without Svelte).
 */

import {
	createInspectableRegistry,
	type InspectableHandle,
	type InspectableInstance,
	type InspectableValues
} from './inspectable-registry.js';

export type { InspectableInstance, InspectableValues } from './inspectable-registry.js';

/**
 * Top-level `$state.snapshot` per key. Functions are kept by reference so they
 * do not trigger Svelte's "uncloneable" dev warning on every effect run.
 */
function snapshotWithRunes(values: InspectableValues): InspectableValues {
	const out: InspectableValues = {};
	for (const key of Object.keys(values)) {
		const value = values[key];
		out[key] = typeof value === 'function' ? value : $state.snapshot(value);
	}
	return out;
}

// The wrapper snapshots eagerly (in the caller's reactive context, so deep
// dependencies are tracked); the core only stores what it is given.
const registry = createInspectableRegistry({ snapshot: (values) => values });

/**
 * Expose a component's state to SvelteStateGrab.
 *
 * Call it inside `$effect()`. Every call snapshots `values` with
 * `$state.snapshot`, so the effect re-runs on nested changes as well.
 *
 * Lifecycle:
 * - Inside an `$effect` (either form above) or at the top level of a
 *   component `<script>`: the entry is removed automatically when the effect
 *   re-runs or the component is destroyed. Registration happens in a child
 *   effect, i.e. on the next effect flush, not synchronously.
 * - Anywhere else (event handler, module scope, plain function): the entry is
 *   registered immediately and stays until you call the returned function.
 *
 * @param name - Component identifier, typically the component name. Instances
 *   sharing a name are listed as `name #1`, `name #2`, ...
 * @param values - State to expose (`{ count, user }`).
 * @returns Cleanup that removes this instance's entry. Idempotent. Returning it
 *   from `$effect(() => inspectable(...))` makes it the effect teardown.
 */
export function inspectable(name: string, values: Record<string, unknown>): () => void {
	const snap = snapshotWithRunes(values);

	let handle: InspectableHandle | null = null;
	let disposed = false;
	const dispose = () => {
		disposed = true;
		handle?.unregister();
		handle = null;
	};

	try {
		// Child effect: destroyed (running its teardown) when the calling effect
		// re-runs or the owning component is destroyed. It reads no reactive
		// state, so it runs exactly once.
		$effect(() => {
			if (disposed) return;
			const own = registry.register(name, snap);
			handle = own;
			return () => {
				own.unregister();
				if (handle === own) handle = null;
			};
		});
	} catch {
		// No owning effect/component (`effect_orphan`) or not allowed here:
		// register now; the caller owns cleanup via the returned function.
		handle = registry.register(name, snap);
	}

	return dispose;
}

/**
 * Remove every instance registered under `name`.
 *
 * Legacy API: with several mounted instances this clears all of them. Prefer
 * the cleanup returned by `inspectable()` (or the automatic `$effect`
 * teardown), which removes only the calling instance.
 */
export function uninspectable(name: string): void {
	registry.remove(name);
}

/** All live instances registered under `name`, ordered `#1`, `#2`, ... */
export function getInspectableInstances(name: string): InspectableInstance[] {
	return registry.getInstances(name);
}

/**
 * Values of the first (lowest-numbered) instance of `name`, or undefined.
 * Kept for backward compatibility; use `getInspectableInstances` to see all.
 */
export function getInspectableState(name: string): Record<string, unknown> | undefined {
	return registry.getState(name);
}

/** Names that currently have at least one registered instance. */
export function getInspectableIds(): string[] {
	return registry.getNames();
}

/** Clear all inspectable state (used in tests or cleanup). */
export function clearInspectableRegistry(): void {
	registry.clear();
}
