/**
 * Types of the page side of the runtime channel (wire contract v1,
 * docs/agent-runtime-spec.md). The server side lives in `src/mcp/`.
 */

/** What a tool handler returns; becomes MCP `content[0].text` + `structuredContent`. */
export interface RuntimeToolResult {
	text: string;
	data?: Record<string, unknown>;
}

/** Outcome of one command, before the `id`/`tabId` envelope is added. */
export type RuntimeCommandOutcome =
	{ ok: true; result: RuntimeToolResult } | { ok: false; error: string };

/** A page-side tool. Throw to report an error (`ok: false`, message as `error`). */
export type RuntimeToolHandler = (
	args: Record<string, unknown>
) => RuntimeToolResult | Promise<RuntimeToolResult>;

/** SSE `runtime-command` event data. */
export interface RuntimeCommand {
	id: string;
	targetTabId: string;
	tool: string;
	args: Record<string, unknown>;
}

/** `POST /runtime/hello` body. */
export interface RuntimeHello {
	tabId: string;
	url: string;
	title: string;
	focused: boolean;
}

/** `POST /runtime/result` body. */
export type RuntimeResultMessage =
	| { id: string; tabId: string; ok: true; result: RuntimeToolResult }
	| { id: string; tabId: string; ok: false; error: string };
