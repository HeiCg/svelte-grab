/**
 * Base interface for agent providers.
 * Implement this to add support for different AI agent backends.
 */

export interface AgentProviderCallbacks {
	onStatus: (message: string) => void;
	onDone: (result: string) => void;
	onError: (error: string) => void;
}

export interface AgentProvider {
	/** Unique provider/agent name */
	readonly name: string;

	/**
	 * Handle an incoming agent request.
	 * @param sessionId - Session ID for follow-up/resume
	 * @param context - The content and prompt from the browser
	 * @param callbacks - Callbacks for streaming status, completion, and errors
	 */
	handleRequest(
		sessionId: string,
		context: { content: string[]; prompt: string; selectedCount: number },
		callbacks: AgentProviderCallbacks
	): Promise<void>;

	/**
	 * Abort an in-progress request.
	 */
	abort(sessionId: string): void;

	/**
	 * Undo the last change made by the agent.
	 * Sends "undo the last change" as a follow-up prompt.
	 */
	undo(sessionId: string, callbacks: AgentProviderCallbacks): Promise<void>;

	/**
	 * Redo the last undone change.
	 * Sends "redo the change you just undid" as a follow-up prompt.
	 */
	redo(sessionId: string, callbacks: AgentProviderCallbacks): Promise<void>;

	/**
	 * Resume a session with a follow-up prompt.
	 * Sends a new prompt in the context of the previous session.
	 */
	resume(sessionId: string, prompt: string, callbacks: AgentProviderCallbacks): Promise<void>;
}

/** Max session-history entries a provider retains before evicting the oldest. */
export const MAX_SESSION_HISTORY = 200;

/**
 * Insert/update a value in a bounded session-history map, evicting the oldest
 * entry once the map exceeds MAX_SESSION_HISTORY. Re-inserts on update so the
 * map's insertion order tracks recency.
 */
export function setBoundedSession<V>(map: Map<string, V>, sessionId: string, value: V): void {
	map.delete(sessionId);
	map.set(sessionId, value);
	if (map.size > MAX_SESSION_HISTORY) {
		const oldest = map.keys().next().value;
		if (oldest !== undefined) map.delete(oldest);
	}
}
