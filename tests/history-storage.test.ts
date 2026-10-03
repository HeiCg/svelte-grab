// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
	loadHistory,
	saveHistory,
	addHistoryEntry,
	removeHistoryEntry,
	clearAllHistory,
	generateHistoryId,
	SESSION_STORAGE_KEY,
	MAX_HISTORY_ITEMS,
	MAX_STORAGE_BYTES,
	type PersistentHistoryEntry
} from '../src/lib/utils/history-storage.js';

/**
 * NOTE: history-storage persists to `sessionStorage` (jsdom provides it),
 * despite the conceptual "history" naming.
 */

function makeEntry(overrides: Partial<PersistentHistoryEntry> = {}): PersistentHistoryEntry {
	return {
		id: generateHistoryId(),
		timestamp: Date.now(),
		componentName: 'Foo',
		tagName: 'div',
		htmlPreview: '<div>hi</div>',
		elementSelector: 'div.foo',
		stack: [],
		...overrides
	};
}

describe('history-storage', () => {
	beforeEach(() => {
		sessionStorage.clear();
	});

	describe('generateHistoryId', () => {
		it('produces unique, prefixed ids', () => {
			const a = generateHistoryId();
			const b = generateHistoryId();
			expect(a).toMatch(/^sg-/);
			expect(a).not.toBe(b);
		});
	});

	describe('loadHistory', () => {
		it('returns an empty array when nothing is stored', () => {
			expect(loadHistory()).toEqual([]);
		});

		it('returns an empty array for malformed JSON', () => {
			sessionStorage.setItem(SESSION_STORAGE_KEY, '{not json');
			expect(loadHistory()).toEqual([]);
		});

		it('returns an empty array when stored value is not an array', () => {
			sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ a: 1 }));
			expect(loadHistory()).toEqual([]);
		});

		it('round-trips a saved array', () => {
			const entries = [makeEntry({ id: 'sg-1' }), makeEntry({ id: 'sg-2' })];
			saveHistory(entries);
			const loaded = loadHistory();
			expect(loaded.map((e) => e.id)).toEqual(['sg-1', 'sg-2']);
		});
	});

	describe('saveHistory count limit', () => {
		it(`trims to at most ${MAX_HISTORY_ITEMS} entries`, () => {
			const many = Array.from({ length: MAX_HISTORY_ITEMS + 20 }, (_, i) =>
				makeEntry({ id: 'sg-' + i })
			);
			saveHistory(many);
			const loaded = loadHistory();
			expect(loaded.length).toBe(MAX_HISTORY_ITEMS);
			// Keeps the front (newest) entries.
			expect(loaded[0].id).toBe('sg-0');
		});
	});

	describe('saveHistory byte limit', () => {
		it('drops oldest entries until under the byte budget', () => {
			// Build entries each carrying a large htmlPreview so the byte limit,
			// not the count limit, is what bites.
			const bigPreview = 'x'.repeat(30 * 1024); // ~30 KB each
			const entries = Array.from({ length: 40 }, (_, i) =>
				makeEntry({ id: 'sg-' + i, htmlPreview: bigPreview })
			);
			saveHistory(entries);

			const loaded = loadHistory();
			expect(loaded.length).toBeGreaterThan(0);
			expect(loaded.length).toBeLessThan(entries.length);

			const storedBytes = new Blob([sessionStorage.getItem(SESSION_STORAGE_KEY) ?? '']).size;
			expect(storedBytes).toBeLessThanOrEqual(MAX_STORAGE_BYTES);

			// It keeps entries from the front of the list.
			expect(loaded[0].id).toBe('sg-0');
		});
	});

	describe('addHistoryEntry', () => {
		it('prepends the new entry and assigns an id', () => {
			addHistoryEntry({
				timestamp: Date.now(),
				componentName: 'A',
				tagName: 'div',
				htmlPreview: '',
				elementSelector: '',
				stack: []
			});
			const result = addHistoryEntry({
				timestamp: Date.now(),
				componentName: 'B',
				tagName: 'span',
				htmlPreview: '',
				elementSelector: '',
				stack: []
			});
			expect(result[0].componentName).toBe('B');
			expect(result[1].componentName).toBe('A');
			expect(result[0].id).toMatch(/^sg-/);
		});
	});

	describe('removeHistoryEntry', () => {
		it('removes the entry with the given id', () => {
			saveHistory([makeEntry({ id: 'keep' }), makeEntry({ id: 'drop' })]);
			const result = removeHistoryEntry('drop');
			expect(result.map((e) => e.id)).toEqual(['keep']);
		});
	});

	describe('clearAllHistory', () => {
		it('empties the store', () => {
			saveHistory([makeEntry()]);
			clearAllHistory();
			expect(loadHistory()).toEqual([]);
		});
	});
});
