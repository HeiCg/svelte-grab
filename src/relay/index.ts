/**
 * svelte-grab/relay: WebSocket relay between the browser overlay and a coding
 * agent provider (Claude Code, Cursor, Copilot, Codex).
 *
 * MAINTENANCE MODE. Still supported (bug and security fixes), but it gets no
 * new providers or features. New integrations should use the MCP server
 * (`svelte-grab/mcp`, `svelte-grab-mcp --stdio`), where the agent queries the
 * live page itself through the `ui_*` tools. See docs/agent-runtime-spec.md.
 */
export { createRelayServer } from './server.js';
export type { RelayServerOptions } from './server.js';
export type { AgentProvider, AgentProviderCallbacks } from './providers/base.js';
export { ClaudeCodeProvider } from './providers/claude-code.js';
export { CursorProvider } from './providers/cursor.js';
export { CopilotProvider } from './providers/copilot.js';
export { CodexProvider } from './providers/codex.js';
export { connectToRelay } from './connection.js';
export type { ConnectRelayOptions, RelayConnection } from './connection.js';

export type {
	ClientMessage,
	ServerMessage,
	AgentRequestMessage,
	AgentAbortMessage,
	AgentUndoMessage,
	AgentStatusMessage,
	AgentDoneMessage,
	AgentErrorMessage,
	HandlersMessage,
	HealthMessage,
	HealthResponseMessage
} from './protocol.js';
