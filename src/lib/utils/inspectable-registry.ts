/**
 * Plain-TS core of the `inspectable()` registry.
 *
 * Kept free of Svelte runes so it can be unit-tested without the Svelte
 * compiler. The public, rune-aware wrapper lives in `inspectable.svelte.ts`
 * (it snapshots with `$state.snapshot` and ties cleanup to `$effect` teardown).
 *
 * Model: every registration is its own instance, keyed by `name` + a 1-based
 * instance number. Two mounted copies of the same component therefore get two
 * entries (`Counter #1`, `Counter #2`) instead of overwriting each other. Freed
 * numbers are reused lowest-first, so an instance that unregisters and
 * re-registers on every `$effect` re-run keeps its number.
 *
 * Stored values are snapshots: plain data taken at register/update time. They
 * are replaced, never mutated, so an object handed to a reader (e.g. the
 * StateGrab popup at grab time) keeps showing the state as of that moment.
 */

export type InspectableValues = Record<string, unknown>;

export interface InspectableInstance {
	/** Name passed to `inspectable()` (typically the component name). */
	name: string;
	/** 1-based number, unique among the live instances of `name`. */
	instance: number;
	/** Display label, `"Name #n"`. */
	label: string;
	/** Snapshot of the values at the last register/update. */
	values: InspectableValues;
	/** `Date.now()` of the last register/update. */
	updatedAt: number;
}

export interface InspectableHandle {
	readonly name: string;
	readonly instance: number;
	/** Replace this instance's values (snapshotted). No-op after unregister. */
	update(values: InspectableValues): void;
	/** Remove this instance. Idempotent; never touches other instances. */
	unregister(): void;
}

export interface InspectableRegistry {
	register(name: string, values: InspectableValues): InspectableHandle;
	/** All live instances of `name`, ordered by instance number. */
	getInstances(name: string): InspectableInstance[];
	/** Values of the lowest-numbered instance of `name` (legacy single-value API). */
	getState(name: string): InspectableValues | undefined;
	/** Names with at least one live instance. */
	getNames(): string[];
	/** Remove every instance of `name`. */
	remove(name: string): void;
	clear(): void;
}

export interface InspectableRegistryOptions {
	/** How values are copied on register/update. Defaults to `snapshotValues`. */
	snapshot?: (values: InspectableValues) => InspectableValues;
}

function isPlainObject(value: object): boolean {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function cloneValue(value: unknown, seen: Map<object, unknown>): unknown {
	if (typeof value !== 'object' || value === null) return value;

	const existing = seen.get(value);
	if (existing !== undefined) return existing;

	if (Array.isArray(value)) {
		const copy: unknown[] = new Array(value.length);
		seen.set(value, copy);
		for (let i = 0; i < value.length; i++) {
			if (i in value) copy[i] = cloneValue(value[i], seen);
		}
		return copy;
	}

	if (value instanceof Map) {
		const copy = new Map<unknown, unknown>();
		seen.set(value, copy);
		for (const [k, v] of value) copy.set(k, cloneValue(v, seen));
		return copy;
	}

	if (value instanceof Set) {
		const copy = new Set<unknown>();
		seen.set(value, copy);
		for (const v of value) copy.add(cloneValue(v, seen));
		return copy;
	}

	if (value instanceof Date) return new Date(value.getTime());

	if (isPlainObject(value)) {
		const copy: Record<string, unknown> = {};
		seen.set(value, copy);
		for (const key of Object.keys(value)) {
			copy[key] = cloneValue((value as Record<string, unknown>)[key], seen);
		}
		return copy;
	}

	// Class instances, DOM nodes, etc.: kept by reference (the serializer
	// handles them at display time).
	return value;
}

/**
 * Deep-copy plain objects, arrays, Maps, Sets and Dates; keep everything else
 * (functions, class instances, DOM nodes) by reference. Cycle-safe.
 */
export function snapshotValues(values: InspectableValues): InspectableValues {
	return cloneValue(values, new Map()) as InspectableValues;
}

interface Entry {
	instance: number;
	values: InspectableValues;
	updatedAt: number;
}

export function createInspectableRegistry(
	options: InspectableRegistryOptions = {}
): InspectableRegistry {
	const snapshot = options.snapshot ?? snapshotValues;
	const byName = new Map<string, Map<number, Entry>>();

	function lowestFreeInstance(entries: Map<number, Entry>): number {
		let n = 1;
		while (entries.has(n)) n++;
		return n;
	}

	function register(name: string, values: InspectableValues): InspectableHandle {
		let entries = byName.get(name);
		if (!entries) {
			entries = new Map();
			byName.set(name, entries);
		}
		const entry: Entry = {
			instance: lowestFreeInstance(entries),
			values: snapshot(values),
			updatedAt: Date.now()
		};
		entries.set(entry.instance, entry);

		// A handle only acts while its own entry object is still the live one,
		// so a stale handle (after clear/remove) cannot clobber a newer entry
		// that reused the same number.
		const isLive = () => byName.get(name)?.get(entry.instance) === entry;

		return {
			name,
			instance: entry.instance,
			update(next) {
				if (!isLive()) return;
				entry.values = snapshot(next);
				entry.updatedAt = Date.now();
			},
			unregister() {
				if (!isLive()) return;
				const current = byName.get(name)!;
				current.delete(entry.instance);
				if (current.size === 0) byName.delete(name);
			}
		};
	}

	function getInstances(name: string): InspectableInstance[] {
		const entries = byName.get(name);
		if (!entries) return [];
		return Array.from(entries.values())
			.sort((a, b) => a.instance - b.instance)
			.map((e) => ({
				name,
				instance: e.instance,
				label: `${name} #${e.instance}`,
				values: e.values,
				updatedAt: e.updatedAt
			}));
	}

	return {
		register,
		getInstances,
		getState: (name) => getInstances(name)[0]?.values,
		getNames: () => Array.from(byName.keys()),
		remove: (name) => {
			byName.delete(name);
		},
		clear: () => byName.clear()
	};
}
