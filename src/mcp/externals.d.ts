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
		connect(transport: unknown): Promise<void>;
	}
}

declare module '@modelcontextprotocol/sdk/server/streamableHttp.js' {
	export class StreamableHTTPServerTransport {
		constructor(path: string);
		handleRequest(req: unknown, res: unknown): Promise<void>;
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
