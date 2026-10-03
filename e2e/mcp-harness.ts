import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect } from './fixtures';

/**
 * Real MCP harness for e2e specs: the built MCP server (dist/mcp/cli.js, HTTP
 * mode) and a real @modelcontextprotocol/sdk Client over Streamable HTTP.
 * Shared by e2e/agent-loop.spec.ts and e2e/hmr.spec.ts.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = fileURLToPath(new URL('../dist/mcp/cli.js', import.meta.url));
const TAB_ID_KEY = 'svelte-grab-tab-id';

export interface McpServerProcess {
	proc: ChildProcess;
	port: number;
}

export interface ToolResult {
	text: string;
	data: Record<string, unknown> | undefined;
	isError: boolean;
}

/** A free loopback TCP port (also used for Chromium's --remote-debugging-port in e2e/leak.spec.ts). */
export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address() as { port: number };
			srv.close(() => resolve(port));
		});
	});
}

/**
 * Start `node dist/mcp/cli.js --port=<free>`; resolves with the port it really bound.
 * `env` is merged over process.env; SVELTE_GRAB_TOKEN is dropped unless `env` sets it.
 * `extraArgs` are appended to the CLI args (e.g. `--cdp=http://127.0.0.1:9222`).
 */
export async function startMcpServer(
	env: Record<string, string> = {},
	extraArgs: string[] = []
): Promise<McpServerProcess> {
	// CI builds on `npm ci` (prepare); locally build the server half if missing.
	if (!existsSync(CLI)) execSync('npm run build:server', { cwd: ROOT, stdio: 'ignore' });
	const requested = await freePort();
	const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
	if (!env.SVELTE_GRAB_TOKEN) delete childEnv.SVELTE_GRAB_TOKEN;
	if (!env.SVELTE_GRAB_CDP) delete childEnv.SVELTE_GRAB_CDP;
	const proc = spawn(process.execPath, [CLI, `--port=${requested}`, ...extraArgs], {
		cwd: ROOT,
		env: childEnv,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	const port = await new Promise<number>((resolve, reject) => {
		let out = '';
		const timer = setTimeout(() => reject(new Error(`MCP server did not start:\n${out}`)), 15_000);
		const onData = (chunk: Buffer) => {
			out += chunk.toString();
			const m = out.match(/HTTP server listening on http:\/\/localhost:(\d+)/);
			if (m) {
				clearTimeout(timer);
				resolve(Number(m[1]));
			}
		};
		proc.stdout!.on('data', onData);
		proc.stderr!.on('data', onData);
		proc.once('exit', (code) => {
			clearTimeout(timer);
			reject(new Error(`MCP server exited (${code}):\n${out}`));
		});
	});
	return { proc, port };
}

export async function stopMcpServer(server: McpServerProcess | undefined): Promise<void> {
	if (!server || server.proc.exitCode !== null) return;
	const exited = new Promise((resolve) => server.proc.once('exit', resolve));
	server.proc.kill('SIGTERM');
	await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000))]);
	if (server.proc.exitCode === null) server.proc.kill('SIGKILL');
}

/** MCP client over Streamable HTTP; `token` is sent as `x-svelte-grab-token`. */
export async function connectClient(port: number, token?: string): Promise<Client> {
	const client = new Client({ name: 'svelte-grab-e2e', version: '0.0.0' });
	const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
		requestInit: token ? { headers: { 'x-svelte-grab-token': token } } : undefined
	});
	await client.connect(transport);
	return client;
}

export async function call(
	client: Client,
	name: string,
	args: Record<string, unknown> = {}
): Promise<ToolResult> {
	const res = (await client.callTool({ name, arguments: args }, undefined, {
		timeout: 70_000
	})) as {
		content?: { type: string; text?: string }[];
		structuredContent?: Record<string, unknown>;
		isError?: boolean;
	};
	return {
		text: (res.content ?? []).map((c) => c.text ?? '').join('\n'),
		data: res.structuredContent,
		isError: res.isError === true
	};
}

/** The page's runtime tab id, once the runtime has started (after the port probe). */
export async function pageTabId(page: Page): Promise<string> {
	let id: string | null = null;
	await expect
		.poll(async () => (id = await page.evaluate((k) => sessionStorage.getItem(k), TAB_ID_KEY)), {
			timeout: 10_000
		})
		.not.toBeNull();
	return id!;
}

export async function waitForActiveTab(client: Client, tabId: string): Promise<void> {
	await expect
		.poll(
			async () => {
				const res = await call(client, 'ui_tabs');
				return ((res.data?.tabs ?? []) as { tabId: string; active: boolean }[]).map(
					({ tabId, active }) => ({
						tabId,
						active
					})
				);
			},
			{ timeout: 10_000 }
		)
		.toContainEqual({ tabId, active: true });
}
