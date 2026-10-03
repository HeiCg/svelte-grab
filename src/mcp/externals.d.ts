declare module '@modelcontextprotocol/sdk/server/mcp.js' {
	export class McpServer {
		constructor(options: { name: string; version: string });
		registerTool(
			name: string,
			config: {
				title?: string;
				description?: string;
				inputSchema?: Record<string, unknown>;
				outputSchema?: Record<string, unknown>;
			},
			handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>
		): unknown;
		registerPrompt(
			name: string,
			config: { title?: string; description?: string; argsSchema?: Record<string, unknown> },
			cb: (args: Record<string, unknown>, extra: unknown) => unknown
		): unknown;
		connect(transport: unknown): Promise<void>;
	}
}

declare module '@modelcontextprotocol/sdk/server/streamableHttp.js' {
	// Subset of StreamableHTTPServerTransportOptions (SDK >= 1.26).
	// `sessionIdGenerator: undefined` selects stateless mode.
	export interface StreamableHTTPServerTransportOptions {
		sessionIdGenerator: (() => string) | undefined;
		enableJsonResponse?: boolean;
	}
	export class StreamableHTTPServerTransport {
		constructor(options?: StreamableHTTPServerTransportOptions);
		/** `parsedBody` skips the SDK's own body read (the caller already read and capped it). */
		handleRequest(req: unknown, res: unknown, parsedBody?: unknown): Promise<void>;
	}
}

declare module '@modelcontextprotocol/sdk/server/stdio.js' {
	export class StdioServerTransport {
		constructor();
	}
}

// zod is a required peer of @modelcontextprotocol/sdk (^3.25 || ^4), loaded
// lazily next to it. Only the surface used for tool schemas is declared here.
declare module 'zod' {
	interface ZodSchema {
		optional(): ZodSchema;
		describe(description: string): ZodSchema;
		int(): ZodSchema;
		positive(): ZodSchema;
	}
	export const z: {
		string(): ZodSchema;
		number(): ZodSchema;
		boolean(): ZodSchema;
		enum(values: readonly [string, ...string[]]): ZodSchema;
		array(item: ZodSchema): ZodSchema;
		object(shape: Record<string, ZodSchema>): ZodSchema;
	};
}
