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

export interface HealthMessage {
	type: 'health';
}

export type ClientMessage = AgentRequestMessage | AgentAbortMessage | AgentUndoMessage | HealthMessage;

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
