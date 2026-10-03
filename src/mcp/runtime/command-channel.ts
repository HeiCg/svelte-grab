/**
 * Server -> page command channel (wire contract v1).
 *
 * `send()` broadcasts SSE `event: runtime-command` with
 * `{ id, targetTabId, tool, args }` to every SSE client (the page handles it
 * only if `targetTabId` matches its tabId) and resolves when the page POSTs
 * `/runtime/result` with the same `id`. Rejects on timeout or when no tab is
 * connected.
 */

import { randomUUID } from 'node:crypto';
import type { TabRegistry } from './tab-registry.js';
import type { RuntimeResultData, RuntimeResultPayload } from './validate.js';

export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
export const MAX_COMMAND_TIMEOUT_MS = 60_000;
/** Cap on in-flight commands (bounds memory); new commands beyond it are rejected. */
export const MAX_PENDING_COMMANDS = 100;

export const NO_TAB_MESSAGE = 'No browser tab connected. Open the app in dev with <SvelteGrab/> mounted.';

/** SSE data of `event: runtime-command`. */
export interface RuntimeCommandMessage {
	id: string;
	targetTabId: string;
	tool: string;
	args: Record<string, unknown>;
}

/** Delivers a command to connected pages; returns how many SSE clients received it. */
export type RuntimeBroadcast = (message: RuntimeCommandMessage) => number;

export interface SendOptions {
	tabId?: string;
	timeoutMs?: number;
}

/** Outcome of settling a command from a `/runtime/result` payload. */
export type SettleOutcome = 'resolved' | 'unknown-id' | 'tab-mismatch';

interface PendingCommand {
	targetTabId: string;
	resolve: (result: RuntimeResultData) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface CommandChannelOptions {
	registry: TabRegistry;
	broadcast: RuntimeBroadcast;
	maxPending?: number;
	generateId?: () => string;
}

/** Clamp a requested timeout to (0, MAX]; invalid values fall back to the default. */
export function resolveTimeoutMs(timeoutMs: number | undefined): number {
	if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return DEFAULT_COMMAND_TIMEOUT_MS;
	}
	return Math.min(Math.floor(timeoutMs), MAX_COMMAND_TIMEOUT_MS) || 1;
}

/** "Browser tab did not respond in Ns" (N without trailing zeros). */
export function timeoutMessage(timeoutMs: number): string {
	const seconds = Number((timeoutMs / 1000).toFixed(3));
	return `Browser tab did not respond in ${seconds}s`;
}

export class CommandChannel {
	private readonly pending = new Map<string, PendingCommand>();
	private readonly registry: TabRegistry;
	private readonly broadcast: RuntimeBroadcast;
	private readonly maxPending: number;
	private readonly generateId: () => string;

	constructor(options: CommandChannelOptions) {
		this.registry = options.registry;
		this.broadcast = options.broadcast;
		this.maxPending = options.maxPending ?? MAX_PENDING_COMMANDS;
		this.generateId = options.generateId ?? (() => randomUUID());
	}

	get pendingCount(): number {
		return this.pending.size;
	}

	/** Send a tool command to a tab (explicit `tabId` or the active tab). */
	send(tool: string, args: Record<string, unknown>, options: SendOptions = {}): Promise<RuntimeResultData> {
		let target;
		if (options.tabId !== undefined) {
			target = this.registry.get(options.tabId);
			if (!target) {
				return Promise.reject(
					new Error(
						this.registry.size === 0
							? NO_TAB_MESSAGE
							: `Browser tab "${options.tabId}" is not connected. Call ui_tabs to list connected tabs.`
					)
				);
			}
		} else {
			target = this.registry.active();
			if (!target) return Promise.reject(new Error(NO_TAB_MESSAGE));
		}

		if (this.pending.size >= this.maxPending) {
			return Promise.reject(
				new Error(`Too many pending browser commands (max ${this.maxPending}). Try again shortly.`)
			);
		}

		const id = this.generateId();
		const timeoutMs = resolveTimeoutMs(options.timeoutMs);
		const targetTabId = target.tabId;

		return new Promise<RuntimeResultData>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(timeoutMessage(timeoutMs)));
			}, timeoutMs);
			this.pending.set(id, { targetTabId, resolve, reject, timer });

			let delivered = 0;
			try {
				delivered = this.broadcast({ id, targetTabId, tool, args });
			} catch {
				delivered = 0;
			}
			if (delivered === 0) {
				// The tab said hello but no SSE stream is open to deliver the command.
				this.fail(id, new Error(NO_TAB_MESSAGE));
			}
		});
	}

	/** Settle a pending command from a validated `/runtime/result` payload. */
	settle(payload: RuntimeResultPayload): SettleOutcome {
		const entry = this.pending.get(payload.id);
		if (!entry) return 'unknown-id';
		if (entry.targetTabId !== payload.tabId) return 'tab-mismatch';

		this.pending.delete(payload.id);
		clearTimeout(entry.timer);
		if (payload.ok) {
			entry.resolve(payload.result);
		} else {
			entry.reject(new Error(payload.error));
		}
		return 'resolved';
	}

	/** Reject a pending command (e.g. the page sent a malformed result for it). */
	fail(id: string, error: Error): boolean {
		const entry = this.pending.get(id);
		if (!entry) return false;
		this.pending.delete(id);
		clearTimeout(entry.timer);
		entry.reject(error);
		return true;
	}

	has(id: string): boolean {
		return this.pending.has(id);
	}
}
