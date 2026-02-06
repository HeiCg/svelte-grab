declare module '@modelcontextprotocol/sdk/server/mcp.js' {
	export class McpServer {
		constructor(options: { name: string; version: string });
		tool(name: string, description: string, schema: Record<string, unknown>, handler: () => Promise<{ content: { type: string; text: string }[] }>): void;
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
