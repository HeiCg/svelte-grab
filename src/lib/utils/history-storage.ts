/**
 * Persistent history storage using sessionStorage.
 *
 * Stores grab history entries so they survive page navigations
 * within the same tab session. Handles quota errors and private
 * browsing restrictions gracefully.
 */

import type { StackEntry } from '../types.js';

// ============================================================
// Types
// ============================================================

export interface PersistentHistoryEntry {
	id: string;
	timestamp: number;
	componentName: string | null;
	tagName: string;
	htmlPreview: string;
	elementSelector: string;
	stack: StackEntry[];
}

// ============================================================
// Constants
// ============================================================

export const SESSION_STORAGE_KEY = 'svelte-grab-history';
export const MAX_HISTORY_ITEMS = 50;
export const MAX_STORAGE_BYTES = 512 * 1024; // 512 KB

// ============================================================
// ID Generation
// ============================================================

/**
 * Generate a unique history entry ID.
 */
export function generateHistoryId(): string {
	return 'sg-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
}

// ============================================================
// Core Operations
// ============================================================

/**
 * Load history entries from sessionStorage.
 *
 * Returns an empty array if storage is unavailable, empty,
 * or contains invalid data.
 */
export function loadHistory(): PersistentHistoryEntry[] {
	try {
		const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
		if (!raw) return [];

		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];

		return parsed;
	} catch {
		return [];
	}
}

/**
 * Save history entries to sessionStorage.
 *
 * Trims entries to stay within count and byte limits.
 * Silently drops oldest entries if the storage quota is exceeded.
 */
export function saveHistory(items: PersistentHistoryEntry[]): void {
	try {
		// Enforce count limit
		let trimmed = items.slice(0, MAX_HISTORY_ITEMS);

		// Enforce byte limit — remove oldest entries until under budget
		let json = JSON.stringify(trimmed);
		while (trimmed.length > 0 && getByteSize(json) > MAX_STORAGE_BYTES) {
			trimmed = trimmed.slice(0, -1);
			json = JSON.stringify(trimmed);
		}

		sessionStorage.setItem(SESSION_STORAGE_KEY, json);
	} catch {
		// sessionStorage unavailable or quota exceeded — silently fail
	}
}

/**
 * Add a new entry to the front of history, save, and return the updated list.
 */
export function addHistoryEntry(
	entry: Omit<PersistentHistoryEntry, 'id'>
): PersistentHistoryEntry[] {
	const current = loadHistory();
	const newEntry: PersistentHistoryEntry = {
		...entry,
		id: generateHistoryId()
	};

	const updated = [newEntry, ...current];
	saveHistory(updated);
	return loadHistory();
}

/**
 * Remove a history entry by ID, save, and return the updated list.
 */
export function removeHistoryEntry(id: string): PersistentHistoryEntry[] {
	const current = loadHistory();
	const updated = current.filter((entry) => entry.id !== id);
	saveHistory(updated);
	return updated;
}

/**
 * Clear all history from sessionStorage.
 */
export function clearAllHistory(): void {
	try {
		sessionStorage.removeItem(SESSION_STORAGE_KEY);
	} catch {
		// sessionStorage unavailable — silently fail
	}
}

// ============================================================
// Helpers
// ============================================================

/**
 * Get the byte size of a string using the Blob API.
 */
function getByteSize(str: string): number {
	try {
		return new Blob([str]).size;
	} catch {
		// Fallback: approximate via string length (UTF-16 worst case)
		return str.length * 2;
	}
}
