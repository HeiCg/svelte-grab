import { describe, it, expect, beforeEach } from 'vitest';
import {
	createInspectableRegistry,
	snapshotValues,
	type InspectableRegistry
} from '../src/lib/utils/inspectable-registry.js';

/**
 * Tests the plain-TS registry core. The `.svelte.ts` wrapper (which swaps in
 * `$state.snapshot` and wires `$effect` teardown) needs the Svelte compiler and
 * is not exercised here.
 */

describe('inspectable registry', () => {
	let registry: InspectableRegistry;

	beforeEach(() => {
		registry = createInspectableRegistry();
	});

	describe('multiple instances', () => {
		it('keeps one entry per registration instead of overwriting by name', () => {
			registry.register('Counter', { count: 1 });
			registry.register('Counter', { count: 2 });

			const instances = registry.getInstances('Counter');
			expect(instances).toHaveLength(2);
			expect(instances.map((i) => i.values.count)).toEqual([1, 2]);
		});

		it('numbers instances from 1 and labels them "Name #n"', () => {
			const a = registry.register('Counter', { count: 1 });
			const b = registry.register('Counter', { count: 2 });

			expect(a.instance).toBe(1);
			expect(b.instance).toBe(2);
			expect(registry.getInstances('Counter').map((i) => i.label)).toEqual([
				'Counter #1',
				'Counter #2'
			]);
		});

		it('numbers instances independently per name', () => {
			registry.register('Counter', {});
			const other = registry.register('Form', {});
			expect(other.instance).toBe(1);
		});

		it('update() replaces only that instance values', () => {
			const a = registry.register('Counter', { count: 1 });
			registry.register('Counter', { count: 10 });

			a.update({ count: 5 });

			expect(registry.getInstances('Counter').map((i) => i.values.count)).toEqual([5, 10]);
		});

		it('getState() returns the lowest-numbered instance (legacy single-value API)', () => {
			registry.register('Counter', { count: 1 });
			registry.register('Counter', { count: 2 });
			expect(registry.getState('Counter')).toEqual({ count: 1 });
			expect(registry.getState('Missing')).toBeUndefined();
		});

		it('getNames() lists names with at least one live instance', () => {
			const a = registry.register('Counter', {});
			registry.register('Form', {});
			expect(registry.getNames().sort()).toEqual(['Counter', 'Form']);

			a.unregister();
			expect(registry.getNames()).toEqual(['Form']);
		});

		it('returns an empty list for unknown names', () => {
			expect(registry.getInstances('Nope')).toEqual([]);
		});
	});

	describe('unregister', () => {
		it('removes only its own instance', () => {
			const a = registry.register('Counter', { count: 1 });
			registry.register('Counter', { count: 2 });

			a.unregister();

			const instances = registry.getInstances('Counter');
			expect(instances).toHaveLength(1);
			expect(instances[0].values.count).toBe(2);
			expect(instances[0].instance).toBe(2);
		});

		it('is idempotent', () => {
			const a = registry.register('Counter', {});
			registry.register('Counter', {});
			a.unregister();
			a.unregister();
			expect(registry.getInstances('Counter')).toHaveLength(1);
		});

		it('reuses the lowest freed instance number (stable across effect re-runs)', () => {
			const a = registry.register('Counter', { v: 'a' });
			registry.register('Counter', { v: 'b' });

			// Simulates an $effect re-run: teardown, then re-register.
			a.unregister();
			const again = registry.register('Counter', { v: 'a2' });

			expect(again.instance).toBe(1);
			expect(registry.getInstances('Counter').map((i) => i.label)).toEqual([
				'Counter #1',
				'Counter #2'
			]);
		});

		it('a stale handle cannot remove an entry that reused its number', () => {
			const a = registry.register('Counter', { v: 'a' });
			registry.clear();
			registry.register('Counter', { v: 'fresh' });

			a.unregister();
			a.update({ v: 'stale' });

			expect(registry.getInstances('Counter').map((i) => i.values.v)).toEqual(['fresh']);
		});

		it('remove(name) drops every instance of that name', () => {
			registry.register('Counter', {});
			registry.register('Counter', {});
			registry.register('Form', {});

			registry.remove('Counter');

			expect(registry.getInstances('Counter')).toEqual([]);
			expect(registry.getNames()).toEqual(['Form']);
		});

		it('clear() drops everything', () => {
			registry.register('Counter', {});
			registry.register('Form', {});
			registry.clear();
			expect(registry.getNames()).toEqual([]);
		});
	});

	describe('snapshot isolation', () => {
		it('later mutation of nested objects does not change the stored values', () => {
			const user = { name: 'Ada', tags: ['a'] };
			registry.register('Profile', { user });

			user.name = 'Grace';
			user.tags.push('b');

			const stored = registry.getState('Profile')!.user as { name: string; tags: string[] };
			expect(stored).toEqual({ name: 'Ada', tags: ['a'] });
			expect(stored).not.toBe(user);
		});

		it('copies Maps and Sets (and their nested values)', () => {
			const inner = { n: 1 };
			const map = new Map<string, { n: number }>([['k', inner]]);
			const set = new Set(['x']);
			registry.register('Store', { map, set });

			map.set('k2', { n: 2 });
			inner.n = 99;
			set.add('y');

			const stored = registry.getState('Store')!;
			const storedMap = stored.map as Map<string, { n: number }>;
			expect(storedMap).not.toBe(map);
			expect([...storedMap.keys()]).toEqual(['k']);
			expect(storedMap.get('k')).toEqual({ n: 1 });
			expect([...(stored.set as Set<string>)]).toEqual(['x']);
		});

		it('replacing the top-level values object after register has no effect', () => {
			const values: Record<string, unknown> = { count: 1 };
			registry.register('Counter', values);
			values.count = 2;
			values.extra = true;
			expect(registry.getState('Counter')).toEqual({ count: 1 });
		});

		it('values read before an update stay as they were at read time', () => {
			const h = registry.register('Counter', { list: [1] });
			const atGrab = registry.getState('Counter');

			h.update({ list: [1, 2] });

			expect(atGrab).toEqual({ list: [1] });
			expect(registry.getState('Counter')).toEqual({ list: [1, 2] });
		});

		it('uses an injected snapshot function when provided', () => {
			const seen: unknown[] = [];
			const custom = createInspectableRegistry({
				snapshot: (v) => {
					seen.push(v);
					return { wrapped: true };
				}
			});
			custom.register('X', { a: 1 });
			expect(seen).toEqual([{ a: 1 }]);
			expect(custom.getState('X')).toEqual({ wrapped: true });
		});
	});

	describe('snapshotValues()', () => {
		it('handles circular references without throwing', () => {
			const node: Record<string, unknown> = { id: 1 };
			node.self = node;
			const copy = snapshotValues({ node });
			const copiedNode = copy.node as Record<string, unknown>;
			expect(copiedNode).not.toBe(node);
			expect(copiedNode.self).toBe(copiedNode);
		});

		it('clones Dates and keeps functions / class instances by reference', () => {
			class Thing {
				x = 1;
			}
			const date = new Date(0);
			const fn = () => 1;
			const thing = new Thing();
			const copy = snapshotValues({ date, fn, thing });

			expect(copy.date).toEqual(date);
			expect(copy.date).not.toBe(date);
			expect(copy.fn).toBe(fn);
			expect(copy.thing).toBe(thing);
		});
	});
});
