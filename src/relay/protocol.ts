/**
 * WebSocket relay protocol message types.
 * Shared between client and server.
 */

// Client -> Server messages
export interface AgentRequestMessage {
	type: 'agent-request';
	agentId: string;
	sessionId: string;
	context: {
		content: string[];
		prompt: string;
		selectedCount: number;
	};
}

export interface AgentAbortMessage {
	type: 'agent-abort';
	sessionId: string;
}

export interface AgentUndoMessage {
	type: 'agent-undo';
	sessionId: string;
}

export interface AgentRedoMessage {
	type: 'agent-redo';
	sessionId: string;
}

export interface AgentResumeMessage {
	type: 'agent-resume';
	sessionId: string;
	prompt: string;
}

export interface AgentRetryMessage {
	type: 'agent-retry';
	sessionId: string;
}

export interface HealthMessage {
	type: 'health';
}

export type ClientMessage = AgentRequestMessage | AgentAbortMessage | AgentUndoMessage | AgentRedoMessage | AgentResumeMessage | AgentRetryMessage | HealthMessage;

// Server -> Client messages
export interface AgentStatusMessage {
	type: 'agent-status';
	sessionId: string;
	message: string;
}

export interface AgentDoneMessage {
	type: 'agent-done';
	sessionId: string;
	result: string;
}

export interface AgentErrorMessage {
	type: 'agent-error';
	sessionId: string;
	error: string;
}

export interface HandlersMessage {
	type: 'handlers';
	agents: string[];
}

export interface HealthResponseMessage {
	type: 'health';
	status: 'ok';
	agents: string[];
}

export type ServerMessage = AgentStatusMessage | AgentDoneMessage | AgentErrorMessage | HandlersMessage | HealthResponseMessage;

// ============================================================
// Validation
// ============================================================
// The relay drives a local coding agent that runs shell commands, so every
// inbound message must be validated before use. These limits mirror the
// MCP server's isValidContextPayload and cap untrusted input.

/** Max number of strings in context.content. */
export const MAX_CONTENT_ITEMS = 200;
/** Max length (chars) of any single context.content string. */
export const MAX_CONTENT_ITEM_LENGTH = 200_000;
/** Max length (chars) of a prompt. */
export const MAX_PROMPT_LENGTH = 100_000;
/** Max length (chars) of a sessionId. */
export const MAX_SESSION_ID_LENGTH = 256;

const KNOWN_MESSAGE_TYPES = new Set([
	'health',
	'agent-request',
	'agent-abort',
	'agent-undo',
	'agent-redo',
	'agent-resume',
	'agent-retry'
]);

function isNonEmptyBoundedString(v: unknown, max: number): boolean {
	return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function isValidContext(ctx: unknown): ctx is { content: string[]; prompt: string; selectedCount: number } {
	if (typeof ctx !== 'object' || ctx === null) return false;
	const o = ctx as Record<string, unknown>;
	if (!Array.isArray(o.content) || o.content.length > MAX_CONTENT_ITEMS) return false;
	for (const item of o.content) {
		if (typeof item !== 'string' || item.length > MAX_CONTENT_ITEM_LENGTH) return false;
	}
	if (typeof o.prompt !== 'string' || o.prompt.length > MAX_PROMPT_LENGTH) return false;
	if (o.selectedCount !== undefined && typeof o.selectedCount !== 'number') return false;
	return true;
}

/**
 * Validate a parsed client message before the server acts on it.
 *
 * Checks the message type is known, sessionId is a bounded non-empty string,
 * and (for agent-request) the agentId is in the provided allowlist and the
 * context is well-formed and within size limits. `knownAgentIds` is the set of
 * registered provider names.
 *
 * Returns `{ ok: true, message }` on success or `{ ok: false, error }` so the
 * caller can reply with an agent-error. Invalid messages are dropped.
 */
export function validateClientMessage(
	data: unknown,
	knownAgentIds: Set<string>
): { ok: true; message: ClientMessage } | { ok: false; error: string; sessionId?: string } {
	if (typeof data !== 'object' || data === null) {
		return { ok: false, error: 'Message must be an object' };
	}
	const o = data as Record<string, unknown>;

	if (typeof o.type !== 'string' || !KNOWN_MESSAGE_TYPES.has(o.type)) {
		return { ok: false, error: `Unknown message type: ${String(o.type)}` };
	}

	// health has no further required fields.
	if (o.type === 'health') {
		return { ok: true, message: data as ClientMessage };
	}

	if (!isNonEmptyBoundedString(o.sessionId, MAX_SESSION_ID_LENGTH)) {
		return { ok: false, error: 'sessionId must be a non-empty string' };
	}
	const sessionId = o.sessionId as string;

	if (o.type === 'agent-request') {
		if (!isNonEmptyBoundedString(o.agentId, 128) || !knownAgentIds.has(o.agentId as string)) {
			return { ok: false, error: `Unknown or invalid agentId: ${String(o.agentId)}`, sessionId };
		}
		if (!isValidContext(o.context)) {
			return { ok: false, error: 'Invalid context payload', sessionId };
		}
	}

	if (o.type === 'agent-resume') {
		if (typeof o.prompt !== 'string' || o.prompt.length > MAX_PROMPT_LENGTH) {
			return { ok: false, error: 'Invalid prompt', sessionId };
		}
	}

	return { ok: true, message: data as ClientMessage };
}
