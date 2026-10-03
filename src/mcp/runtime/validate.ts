/**
 * Strict shape validation for the runtime channel endpoints
 * (`POST /runtime/hello`, `POST /runtime/result`). Wrong types are rejected;
 * unknown extra fields are ignored.
 */

import type { TabHello } from './tab-registry.js';

/** Max length of `tabId` / command `id` strings. */
export const MAX_ID_LENGTH = 128;
/** Stored url/title are truncated to these lengths (not rejected). */
export const MAX_URL_LENGTH = 2048;
export const MAX_TITLE_LENGTH = 512;

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

export interface RuntimeResultData {
	text: string;
	data?: Record<string, unknown>;
}

export type RuntimeResultPayload =
	| { id: string; tabId: string; ok: true; result: RuntimeResultData }
	| { id: string; tabId: string; ok: false; error: string };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

/** Validate `POST /runtime/hello` body `{ tabId, url, title, focused }`. */
export function parseHelloPayload(data: unknown): Validation<TabHello> {
	if (!isPlainObject(data)) return { ok: false, error: 'Expected a JSON object' };
	if (!isId(data.tabId)) return { ok: false, error: `tabId must be a non-empty string (max ${MAX_ID_LENGTH} chars)` };
	if (typeof data.url !== 'string') return { ok: false, error: 'url must be a string' };
	if (typeof data.title !== 'string') return { ok: false, error: 'title must be a string' };
	if (typeof data.focused !== 'boolean') return { ok: false, error: 'focused must be a boolean' };
	return {
		ok: true,
		value: {
			tabId: data.tabId,
			url: data.url.slice(0, MAX_URL_LENGTH),
			title: data.title.slice(0, MAX_TITLE_LENGTH),
			focused: data.focused
		}
	};
}

/**
 * Validate `POST /runtime/result` body
 * `{ id, tabId, ok: true, result: { text, data? } }` or `{ id, tabId, ok: false, error }`.
 */
export function parseResultPayload(data: unknown): Validation<RuntimeResultPayload> {
	if (!isPlainObject(data)) return { ok: false, error: 'Expected a JSON object' };
	if (!isId(data.id)) return { ok: false, error: `id must be a non-empty string (max ${MAX_ID_LENGTH} chars)` };
	if (!isId(data.tabId)) return { ok: false, error: `tabId must be a non-empty string (max ${MAX_ID_LENGTH} chars)` };
	if (typeof data.ok !== 'boolean') return { ok: false, error: 'ok must be a boolean' };

	if (data.ok) {
		const result = data.result;
		if (!isPlainObject(result)) return { ok: false, error: 'result must be an object when ok is true' };
		if (typeof result.text !== 'string') return { ok: false, error: 'result.text must be a string' };
		if (result.data !== undefined && !isPlainObject(result.data)) {
			return { ok: false, error: 'result.data must be an object when present' };
		}
		const value: RuntimeResultData = { text: result.text };
		if (result.data !== undefined) value.data = result.data as Record<string, unknown>;
		return { ok: true, value: { id: data.id, tabId: data.tabId, ok: true, result: value } };
	}

	if (typeof data.error !== 'string') return { ok: false, error: 'error must be a string when ok is false' };
	return { ok: true, value: { id: data.id, tabId: data.tabId, ok: false, error: data.error } };
}
