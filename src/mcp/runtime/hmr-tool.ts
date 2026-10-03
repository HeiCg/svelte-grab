/**
 * MCP tool `ui_wait_for_hmr` (docs/agent-runtime-spec.md, Phase 4): forwards
 * to the page, which waits for the Vite HMR update after a file edit and
 * rebinds the live refs.
 *
 * The page gives up after `timeoutMs` (default 15s, max 55s); the server waits
 * `timeoutMs + 5s` so the page's own, more useful timeout message wins. The
 * total stays within the channel's 60s cap.
 */

import { MAX_COMMAND_TIMEOUT_MS, type CommandChannel } from './command-channel.js';
import {
	splitForwardArgs,
	toToolError,
	toToolResult,
	type McpToolResult,
	type McpToolServer,
	type ZodNamespace
} from './tools.js';

export const DEFAULT_HMR_WAIT_MS = 15_000;
export const MAX_HMR_WAIT_MS = 55_000;
/** Extra time the server gives the page beyond the page-side timeout. */
export const HMR_SERVER_GRACE_MS = 5_000;

/** Page-side timeout for the given arg (same clamp as the page). */
export function hmrWaitMs(timeoutMs: unknown): number {
	if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) return DEFAULT_HMR_WAIT_MS;
	return Math.min(MAX_HMR_WAIT_MS, Math.max(1, Math.floor(timeoutMs)));
}

/** Server-side timeout for a `ui_wait_for_hmr` call: page timeout + grace, capped at 60s. */
export function hmrServerTimeoutMs(timeoutMs: unknown): number {
	return Math.min(MAX_COMMAND_TIMEOUT_MS, hmrWaitMs(timeoutMs) + HMR_SERVER_GRACE_MS);
}

export async function forwardWaitForHmr(
	channel: CommandChannel,
	rawArgs: Record<string, unknown> | undefined
): Promise<McpToolResult> {
	const { tabId, args } = splitForwardArgs(rawArgs);
	try {
		const result = await channel.send('ui_wait_for_hmr', args, {
			tabId,
			timeoutMs: hmrServerTimeoutMs(args.timeoutMs)
		});
		return toToolResult(result);
	} catch (err) {
		return toToolError(err instanceof Error ? err.message : String(err));
	}
}

export function registerWaitForHmrTool(
	server: McpToolServer,
	z: ZodNamespace,
	deps: { channel: CommandChannel; tabIdHint: string }
): void {
	server.registerTool(
		'ui_wait_for_hmr',
		{
			title: 'Wait for the HMR update after an edit',
			description:
				'Call right after editing a source file. Waits until Vite hot-updates (or fully reloads) the page ' +
				'for that file, lets the DOM settle one frame, then re-resolves every ref handed out so far. Returns ' +
				'{ status: "updated"|"full-reload"|"error", updated (files), errors (Vite compile/transform errors), ' +
				'rebound [{from,to}], lost [ref], kept, consoleErrors, source }. A compile error resolves the wait ' +
				'with status "error" instead of timing out. source "vite-hmr"/"plugin" means exact file tracking; ' +
				'"heuristic" means no Vite HMR API was reachable and any DOM change counted (add svelte-grab/vite ' +
				'to the Vite plugins). If the edit may already have been applied before this call, pass since ' +
				'(epoch ms, e.g. the time you saved the file).',
			inputSchema: {
				files: z
					.array(z.string())
					.optional()
					.describe(
						'Edited files (path or suffix, e.g. "Card.svelte"). Any update counts when omitted.'
					),
				timeoutMs: z
					.number()
					.int()
					.positive()
					.optional()
					.describe(
						`How long to wait in ms (default ${DEFAULT_HMR_WAIT_MS}, max ${MAX_HMR_WAIT_MS}).`
					),
				since: z
					.number()
					.optional()
					.describe('Epoch ms: also accept an update that already happened at or after this time.'),
				tabId: z.string().optional().describe(deps.tabIdHint)
			}
		},
		async (args) => forwardWaitForHmr(deps.channel, args)
	);
}
