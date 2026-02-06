/**
 * Safe serialization utilities for component state inspection.
 * Handles circular references, functions, DOM elements, and other non-serializable values.
 */

/**
 * Safely serialize a value to a display string, handling circular refs and special types.
 */
export function safeSerialize(value: unknown, maxDepth = 3, maxStringLength = 200): string {
	const seen = new WeakSet();

	function serialize(val: unknown, depth: number): unknown {
		if (depth > maxDepth) return '[max depth]';

		if (val === null) return null;
		if (val === undefined) return undefined;

		const type = typeof val;

		if (type === 'string') {
			const s = val as string;
			return s.length > maxStringLength ? s.slice(0, maxStringLength - 3) + '...' : s;
		}

		if (type === 'number' || type === 'boolean') return val;

		if (type === 'function') {
			const fn = val as Function;
			return `[Function: ${fn.name || 'anonymous'}]`;
		}

		if (type === 'symbol') return `[Symbol: ${(val as symbol).description ?? ''}]`;

		if (type === 'bigint') return `${val}n`;

		if (val instanceof Date) return val.toISOString();
		if (val instanceof RegExp) return val.toString();
		if (val instanceof Error) return `[Error: ${val.message}]`;
		if (val instanceof Promise) return '[Promise]';

		if (val instanceof HTMLElement) {
			return `[${val.tagName.toLowerCase()}${val.id ? '#' + val.id : ''}]`;
		}

		if (val instanceof Map) {
			if (seen.has(val)) return '[Circular Map]';
			seen.add(val);
			const entries: Record<string, unknown> = {};
			val.forEach((v, k) => {
				entries[String(k)] = serialize(v, depth + 1);
			});
			return { '[Map]': entries };
		}

		if (val instanceof Set) {
			if (seen.has(val)) return '[Circular Set]';
			seen.add(val);
			return { '[Set]': [...val].map(v => serialize(v, depth + 1)) };
		}

		if (Array.isArray(val)) {
			if (seen.has(val)) return '[Circular Array]';
			seen.add(val);
			if (val.length > 20) {
				const first = val.slice(0, 10).map(v => serialize(v, depth + 1));
				return [...first, `... (${val.length - 10} more items)`];
			}
			return val.map(v => serialize(v, depth + 1));
		}

		if (type === 'object') {
			if (seen.has(val as object)) return '[Circular]';
			seen.add(val as object);
			const obj = val as Record<string, unknown>;
			const keys = Object.keys(obj);
			const result: Record<string, unknown> = {};
			const maxKeys = 30;
			for (let i = 0; i < Math.min(keys.length, maxKeys); i++) {
				result[keys[i]] = serialize(obj[keys[i]], depth + 1);
			}
			if (keys.length > maxKeys) {
				result['...'] = `(${keys.length - maxKeys} more keys)`;
			}
			return result;
		}

		return String(val);
	}

	try {
		const serialized = serialize(value, 0);
		return JSON.stringify(serialized, null, 2) ?? 'undefined';
	} catch {
		return '[Serialization Error]';
	}
}

/**
 * Get a short type description of a value
 */
export function getTypeDescription(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (Array.isArray(value)) return `Array(${value.length})`;
	if (value instanceof Map) return `Map(${value.size})`;
	if (value instanceof Set) return `Set(${value.size})`;
	if (value instanceof Date) return 'Date';
	if (value instanceof RegExp) return 'RegExp';
	if (value instanceof Error) return 'Error';
	if (value instanceof HTMLElement) return `Element<${value.tagName.toLowerCase()}>`;
	if (typeof value === 'function') return `Function(${(value as Function).name || 'anonymous'})`;
	if (typeof value === 'object') return `Object(${Object.keys(value as object).length} keys)`;
	return typeof value;
}

/**
 * Inline value preview (single line)
 */
export function inlinePreview(value: unknown, maxLen = 60): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (typeof value === 'string') {
		const truncated = value.length > maxLen ? value.slice(0, maxLen - 3) + '...' : value;
		return `"${truncated}"`;
	}
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (typeof value === 'function') return `[Function: ${(value as Function).name || 'anonymous'}]`;
	if (Array.isArray(value)) return `[...] (${value.length} items)`;
	if (typeof value === 'object') {
		const keys = Object.keys(value);
		if (keys.length === 0) return '{}';
		const preview = keys.slice(0, 3).join(', ');
		return keys.length > 3 ? `{ ${preview}, ... }` : `{ ${preview} }`;
	}
	return String(value);
}
