import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DEFAULT_MCP_PORT } from './constants.js';
import { findAvailablePort } from '../utils/port.js';

export interface McpServerOptions {
	port?: number;
	stdio?: boolean;
}

interface ContextPayload {
	content: string[];
	prompt?: string;
	toolName?: string;
}

// Stored context — last context sent by the browser
let storedContext: ContextPayload | null = null;

// Per-tool context storage
const toolContexts = new Map<string, { content: string; timestamp: number }>();

// Session history — list of contexts received
interface SessionHistoryEntry {
	id: string;
	content: string[];
	prompt?: string;
	result?: string;
	timestamp: number;
}

let sessionHistory: SessionHistoryEntry[] = [];
let sessionCounter = 0;

/**
 * Validate that the payload has the expected shape.
 */
function isValidContextPayload(data: unknown): data is ContextPayload {
	if (typeof data !== 'object' || data === null) return false;
	const obj = data as Record<string, unknown>;
	if (!Array.isArray(obj.content)) return false;
	for (const item of obj.content) {
		if (typeof item !== 'string') return false;
	}
	if (obj.prompt !== undefined && typeof obj.prompt !== 'string') return false;
	if (obj.toolName !== undefined && typeof obj.toolName !== 'string') return false;
	return true;
}

/**
 * Set CORS headers for browser requests.
 */
function setCorsHeaders(res: ServerResponse): void {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/**
 * Read request body as string.
 */
function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks).toString()));
		req.on('error', reject);
	});
}

/**
 * Send JSON response.
 */
function sendJson(res: ServerResponse, status: number, data: unknown): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(data));
}

/**
 * Handle MCP protocol requests via StreamableHTTP transport.
 * Uses @modelcontextprotocol/sdk if available, otherwise returns 501.
 */
async function handleMcpProtocol(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
		const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');

		const server = new McpServer({
			name: 'svelte-grab',
			version: '1.0.0'
		});

		registerMcpTools(server);

		const transport = new StreamableHTTPServerTransport('/mcp');
		await server.connect(transport);
		await transport.handleRequest(req, res);
	} catch {
		sendJson(res, 501, { error: '@modelcontextprotocol/sdk not installed' });
	}
}

/**
 * Extract a tool-specific section from stored context.
 * Checks per-tool storage first, then falls back to parsing the unified export.
 */
function extractToolSection(toolName: string): string | null {
	const toolCtx = toolContexts.get(toolName);
	if (toolCtx) return toolCtx.content;

	if (!storedContext) return null;
	const fullText = storedContext.content.join('\n');
	const regex = new RegExp(`\\[${toolName}\\][\\s\\S]*?(?=\\n={30,}\\n\\[|$)`);
	const match = fullText.match(regex);
	return match ? match[0] : null;
}

/**
 * Register MCP tools on a server instance.
 */
function registerMcpTools(server: any): void {
	server.tool(
		'get_element_context',
		'Returns the last element context captured by svelte-grab in the browser. Returns the grabbed component stack, HTML preview, and optional prompt. Context is cleared after reading.',
		{},
		async () => {
			if (!storedContext) {
				return {
					content: [{ type: 'text', text: 'No context available. Alt+Click an element in the browser with svelte-grab active.' }]
				};
			}

			const ctx = storedContext;
			storedContext = null;

			const parts: string[] = [...ctx.content];
			if (ctx.prompt) {
				parts.push(`\nUser instruction: ${ctx.prompt}`);
			}

			return {
				content: [{ type: 'text', text: parts.join('\n') }]
			};
		}
	);

	server.tool(
		'undo_last_action',
		'Returns an undo instruction with the original context from the last interaction. Use this to instruct the agent to undo its last change.',
		{},
		async () => {
			if (sessionHistory.length === 0) {
				return {
					content: [{ type: 'text', text: 'No previous actions to undo. No session history available.' }]
				};
			}

			const lastEntry = sessionHistory[sessionHistory.length - 1];
			const contextInfo = lastEntry.content.length > 0
				? `\n\nOriginal context was:\n${lastEntry.content.join('\n')}`
				: '';
			const promptInfo = lastEntry.prompt
				? `\nOriginal instruction was: ${lastEntry.prompt}`
				: '';

			return {
				content: [{ type: 'text', text: `Undo the last change.${promptInfo}${contextInfo}` }]
			};
		}
	);

	server.tool(
		'get_session_history',
		'Returns the list of recent interactions (contexts sent by the browser). Each entry includes the content, prompt, and timestamp.',
		{},
		async () => {
			if (sessionHistory.length === 0) {
				return {
					content: [{ type: 'text', text: 'No session history. No contexts have been sent yet.' }]
				};
			}

			const entries = sessionHistory.slice(-20).map((entry) => {
				const time = new Date(entry.timestamp).toLocaleTimeString();
				const prompt = entry.prompt ? `Prompt: ${entry.prompt}` : 'No prompt';
				const contentPreview = entry.content.length > 0
					? `Content: ${entry.content[0].slice(0, 100)}${entry.content[0].length > 100 ? '...' : ''}`
					: 'No content';
				return `[${time}] ${entry.id}\n  ${prompt}\n  ${contentPreview}`;
			});

			return {
				content: [{ type: 'text', text: `Session history (${sessionHistory.length} entries):\n\n${entries.join('\n\n')}` }]
			};
		}
	);

	server.tool(
		'get_a11y_report',
		'Returns the last accessibility audit report captured by SvelteA11yReporter. Includes WCAG violations, scores, and fix suggestions.',
		{},
		async () => {
			const section = extractToolSection('A11yReporter');
			if (!section) {
				return {
					content: [{ type: 'text', text: 'No a11y report available. Use Alt+RightClick or Alt+A in the browser to run an accessibility audit.' }]
				};
			}
			return { content: [{ type: 'text', text: section }] };
		}
	);

	server.tool(
		'get_style_context',
		'Returns the last CSS style analysis captured by SvelteStyleGrab. Includes computed styles, conflicts, and source attribution.',
		{},
		async () => {
			const section = extractToolSection('StyleGrab');
			if (!section) {
				return {
					content: [{ type: 'text', text: 'No style context available. Use Alt+Ctrl+Click on an element in the browser to capture styles.' }]
				};
			}
			return { content: [{ type: 'text', text: section }] };
		}
	);

	server.tool(
		'get_error_context',
		'Returns captured console errors and warnings from SvelteErrorContext. Includes stack traces, component attribution, and error patterns.',
		{},
		async () => {
			const section = extractToolSection('ErrorContext');
			if (!section) {
				return {
					content: [{ type: 'text', text: 'No error context available. Errors are captured automatically when SvelteErrorContext is active.' }]
				};
			}
			return { content: [{ type: 'text', text: section }] };
		}
	);

	server.tool(
		'get_profiler_report',
		'Returns the last render profiler report from SvelteRenderProfiler. Includes hot components, render counts, and burst detection.',
		{},
		async () => {
			const section = extractToolSection('RenderProfiler');
			if (!section) {
				return {
					content: [{ type: 'text', text: 'No profiler data available. Use Alt+P in the browser to start profiling.' }]
				};
			}
			return { content: [{ type: 'text', text: section }] };
		}
	);

	server.tool(
		'list_available_tools',
		'Lists which svelte-grab tools have data available and when it was last captured.',
		{},
		async () => {
			const tools: string[] = [];

			if (storedContext) {
				tools.push('element_context: available (last grab)');
			}

			for (const [name, ctx] of toolContexts) {
				const age = Math.floor((Date.now() - ctx.timestamp) / 1000);
				const ageStr = age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`;
				tools.push(`${name}: available (captured ${ageStr})`);
			}

			if (tools.length === 0) {
				return {
					content: [{ type: 'text', text: 'No tool data available. Use svelte-grab tools in the browser to capture context.' }]
				};
			}

			return {
				content: [{ type: 'text', text: `Available tool data:\n\n${tools.join('\n')}` }]
			};
		}
	);
}

/**
 * Start the MCP server in HTTP mode.
 */
async function startHttpServer(preferredPort: number): Promise<{ close: () => void }> {
	// Find available port (auto-increment if preferred is in use)
	let port: number;
	try {
		port = await findAvailablePort(preferredPort);
	} catch {
		throw new Error(`Could not find available port starting from ${preferredPort}`);
	}

	if (port !== preferredPort) {
		console.log(`[svelte-grab mcp] Port ${preferredPort} was in use, using ${port} instead`);
	}

	return new Promise((resolve, reject) => {
		const server = createServer(async (req, res) => {
			setCorsHeaders(res);

			// Handle preflight
			if (req.method === 'OPTIONS') {
				res.writeHead(204);
				res.end();
				return;
			}

			const url = req.url || '/';

			// GET /health
			if (req.method === 'GET' && url === '/health') {
				sendJson(res, 200, { status: 'ok', hasContext: storedContext !== null });
				return;
			}

			// POST /context — browser sends grabbed context here
			if (req.method === 'POST' && url === '/context') {
				try {
					const body = await readBody(req);
					const data = JSON.parse(body);

					if (!isValidContextPayload(data)) {
						sendJson(res, 400, { error: 'Invalid payload. Expected { content: string[], prompt?: string }' });
						return;
					}

					storedContext = data;

					// Store per-tool context if toolName provided
					if (data.toolName) {
						toolContexts.set(data.toolName, {
							content: data.content.join('\n'),
							timestamp: Date.now()
						});
					}

					// Save to session history
					sessionCounter++;
					sessionHistory.push({
						id: `session-${sessionCounter}`,
						content: data.content,
						prompt: data.prompt,
						timestamp: Date.now()
					});

					// Keep last 50 entries
					if (sessionHistory.length > 50) {
						sessionHistory = sessionHistory.slice(-50);
					}

					sendJson(res, 200, { ok: true });
				} catch {
					sendJson(res, 400, { error: 'Invalid JSON' });
				}
				return;
			}

			// POST /mcp — MCP protocol endpoint
			if (req.method === 'POST' && url === '/mcp') {
				await handleMcpProtocol(req, res);
				return;
			}

			// 404 for everything else
			sendJson(res, 404, { error: 'Not found' });
		});

		server.on('error', (err: NodeJS.ErrnoException) => {
			reject(err);
		});

		server.listen(port, () => {
			console.log(`[svelte-grab mcp] HTTP server listening on http://localhost:${port}`);
			console.log(`[svelte-grab mcp] Health check: http://localhost:${port}/health`);
			console.log(`[svelte-grab mcp] Context endpoint: POST http://localhost:${port}/context`);
			resolve({ close: () => server.close() });
		});
	});
}

/**
 * Start the MCP server in stdio mode for direct Claude Code integration.
 */
async function startStdioServer(): Promise<void> {
	const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
	const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

	const server = new McpServer({
		name: 'svelte-grab',
		version: '1.0.0'
	});

	registerMcpTools(server);

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

/**
 * Start the MCP server.
 * In stdio mode, connects via stdin/stdout for direct Claude Code integration.
 * In HTTP mode, starts an HTTP server with /health, /context, and /mcp endpoints.
 */
export async function startMcpServer(options: McpServerOptions = {}): Promise<{ close: () => void } | void> {
	const { port = DEFAULT_MCP_PORT, stdio = false } = options;

	if (stdio) {
		await startStdioServer();
		return;
	}

	return startHttpServer(port);
}
