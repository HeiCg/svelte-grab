/**
 * MCP tool `ui_network` (docs/agent-runtime-spec.md, Phase 9a).
 *
 * Without `reload` it forwards to the page, which reports the requests its
 * network capture saw (after waiting `waitMs`, default 0).
 *
 * `reload: true` cannot be answered by the page that receives it (the reload
 * kills it), so the server orchestrates it:
 *
 * 1. `ui_network_reload` -> the page persists the body-capture flag, replies
 *    with its `timeOrigin` and reloads itself shortly after.
 * 2. Wait for the tab to say hello again: the reloaded page keeps its tab id
 *    (sessionStorage), reconnects the SSE stream and POSTs `/runtime/hello`
 *    (the registry's `seenSeq` moves). Capture started at module evaluation.
 * 3. Wait `waitMs` (default 2000) so the load settles.
 * 4. `ui_network({ since: 'navigation', afterTimeOrigin })`: a page whose
 *    `timeOrigin` is not newer than the old one answers "page has not
 *    reloaded yet" and the server retries until the deadline, so a heartbeat
 *    from the old page can never be mistaken for the reloaded one.
 */

import { MAX_COMMAND_TIMEOUT_MS, NO_TAB_MESSAGE, type CommandChannel } from './command-channel.js';
import type { TabRegistry } from './tab-registry.js';
import {
	splitForwardArgs,
	toToolError,
	toToolResult,
	type McpToolResult,
	type McpToolServer,
	type ZodNamespace
} from './tools.js';

/** Must match DEFAULT/MAX_NETWORK_WAIT_MS in src/lib/runtime/network.ts. */
export const DEFAULT_NETWORK_WAIT_MS = 2_000;
export const MAX_NETWORK_WAIT_MS = 30_000;
/** How long the reloaded tab has to reconnect (hello) before the tool fails. */
export const RELOAD_RECONNECT_TIMEOUT_MS = 20_000;
/** Extra time the server gives the page beyond `waitMs`. */
export const NETWORK_SERVER_GRACE_MS = 10_000;
/** Poll interval while waiting for the re-hello / retrying the report. */
export const RELOAD_POLL_MS = 100;
/** Must match NETWORK_TYPES in src/lib/runtime/network.ts. */
export const UI_NETWORK_TYPES = [
	'document',
	'fetch',
	'xhr',
	'beacon',
	'websocket',
	'eventsource',
	'script',
	'stylesheet',
	'image',
	'font',
	'media',
	'other'
] as const;

const NOT_RELOADED = 'page has not reloaded yet';

export interface NetworkToolDeps {
	channel: CommandChannel;
	registry: TabRegistry;
	/** Test seams. */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	reconnectTimeoutMs?: number;
}

/** `waitMs` clamp (same as the page). */
export function networkWaitMs(waitMs: unknown, fallback: number): number {
	if (typeof waitMs !== 'number' || !Number.isFinite(waitMs)) return fallback;
	return Math.min(MAX_NETWORK_WAIT_MS, Math.max(0, Math.floor(waitMs)));
}

/** Server-side timeout of a forwarded `ui_network`: page wait + grace, capped at 60s. */
export function networkServerTimeoutMs(waitMs: unknown): number {
	return Math.min(MAX_COMMAND_TIMEOUT_MS, networkWaitMs(waitMs, 0) + NETWORK_SERVER_GRACE_MS);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function runUiNetwork(deps: NetworkToolDeps, rawArgs: Record<string, unknown> | undefined): Promise<McpToolResult> {
	const { tabId, args } = splitForwardArgs(rawArgs);
	const reload = args.reload === true;
	delete args.reload;
	if (!reload) {
		try {
			return toToolResult(await deps.channel.send('ui_network', args, { tabId, timeoutMs: networkServerTimeoutMs(args.waitMs) }));
		} catch (err) {
			return toToolError(message(err));
		}
	}

	const sleep = deps.sleep ?? defaultSleep;
	const now = deps.now ?? (() => Date.now());
	const target = tabId !== undefined ? deps.registry.get(tabId) : deps.registry.active();
	if (!target) {
		return toToolError(
			tabId !== undefined && deps.registry.size > 0
				? `Browser tab "${tabId}" is not connected. Call ui_tabs to list connected tabs.`
				: NO_TAB_MESSAGE
		);
	}
	const id = target.tabId;
	const seenBefore = target.seenSeq;
	const waitMs = networkWaitMs(args.waitMs, DEFAULT_NETWORK_WAIT_MS);
	const started = now();

	let timeOrigin: number | undefined;
	try {
		const ack = await deps.channel.send(
			'ui_network_reload',
			args.includeBodies === true ? { includeBodies: true } : {},
			{ tabId: id }
		);
		const t = ack.data?.timeOrigin;
		timeOrigin = typeof t === 'number' ? t : undefined;
	} catch (err) {
		return toToolError(`ui_network reload failed: ${message(err)}`);
	}

	const deadline = now() + (deps.reconnectTimeoutMs ?? RELOAD_RECONNECT_TIMEOUT_MS);
	for (;;) {
		const entry = deps.registry.get(id);
		if (entry && entry.seenSeq !== seenBefore) break;
		if (now() >= deadline) {
			return toToolError(
				`Tab ${id} did not reconnect within ${Math.round((deps.reconnectTimeoutMs ?? RELOAD_RECONNECT_TIMEOUT_MS) / 1000)}s after the reload ` +
					'(is <SvelteGrab enableMcp/> mounted on that page?).'
			);
		}
		await sleep(RELOAD_POLL_MS);
	}
	const reconnectedMs = now() - started;
	if (waitMs > 0) await sleep(waitMs);

	const pageArgs: Record<string, unknown> = { ...args, since: 'navigation', waitMs: 0 };
	if (timeOrigin !== undefined) pageArgs.afterTimeOrigin = timeOrigin;
	for (;;) {
		try {
			const result = await deps.channel.send('ui_network', pageArgs, { tabId: id });
			const header = `# reloaded tab ${id}: reconnected after ${reconnectedMs}ms, then waited ${waitMs}ms`;
			const out = toToolResult({ ...result, text: `${header}\n${result.text}` });
			if (out.structuredContent) out.structuredContent = { ...out.structuredContent, reloaded: true, reconnectedMs, waitedMs: waitMs };
			return out;
		} catch (err) {
			const msg = message(err);
			const retryable = msg.includes(NOT_RELOADED) || /did not respond|No browser tab connected|is not connected/.test(msg);
			if (!retryable || now() >= deadline + waitMs) return toToolError(msg);
			await sleep(RELOAD_POLL_MS);
		}
	}
}

export function registerNetworkTool(
	server: McpToolServer,
	z: ZodNamespace,
	deps: { channel: CommandChannel; registry: TabRegistry; tabIdHint: string }
): void {
	server.registerTool(
		'ui_network',
		{
			title: 'Network requests of the live page',
			description:
				'What does this screen load? Lists the requests the page made (fetch, XHR, sendBeacon, WebSocket, ' +
				'EventSource, plus scripts/CSS/images/fonts from resource timing), each with the initiator (source ' +
				'file:line and component of the code that made it, when it came from app code) and tags for SvelteKit ' +
				'__data.json / remote-function calls. Text: totals (count, bytes, by type, first- vs third-party), ' +
				'ORIGINS, DUPLICATES (same method+URL more than once), SLOWEST 5, WATERFALL (requests fired right after ' +
				'another finished), FAILED, then one line per request. reload: true reloads the tab and reports the ' +
				'initial load (waits for the tab to reconnect, then waitMs, default 2000). URLs are always redacted: ' +
				'secret-shaped query values and values under sensitive names show as kind:abcd…(len N, sha xxxxxx). ' +
				'Bodies are not returned unless includeBodies (same-origin JSON only, redacted, 2 KB); for the page load ' +
				'use reload + includeBodies. Follow with ui_security_scan for credential leaks.',
			inputSchema: {
				reload: z.boolean().optional().describe('Reload the tab and report the requests of the fresh page load.'),
				waitMs: z
					.number()
					.int()
					.optional()
					.describe(
						`Wait before reporting, in ms (reload: default ${DEFAULT_NETWORK_WAIT_MS} after the tab reconnects; ` +
							`otherwise default 0; max ${MAX_NETWORK_WAIT_MS}).`
					),
				since: z.number().optional().describe('Only requests started at or after this epoch ms (reload implies the new page load).'),
				filter: z
					.object({
						origin: z
							.string()
							.optional()
							.describe('"first-party", "third-party", or an origin/host substring.'),
						type: z.array(z.enum(UI_NETWORK_TYPES)).optional().describe('Request types to keep.'),
						status: z
							.string()
							.optional()
							.describe('"failed" (network error or >= 400), "ok", "4xx", "5xx" or a code like "404".')
					})
					.optional()
					.describe('Keep only matching requests.'),
				includeBodies: z
					.boolean()
					.optional()
					.describe('Include redacted, truncated (2 KB) same-origin JSON response bodies (captured from now on / after reload).'),
				tabId: z.string().optional().describe(deps.tabIdHint)
			}
		},
		async (args) => runUiNetwork({ channel: deps.channel, registry: deps.registry }, args)
	);
}
