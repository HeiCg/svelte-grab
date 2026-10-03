/**
 * MCP tool `ui_profile` (docs/agent-runtime-spec.md, Phase 8a): forwards to
 * the page, which records DOM mutations per component for `durationMs`
 * (optionally while performing an in-page action) and reports hot components.
 *
 * The page records for `durationMs` (default 3s, 100ms..30s); the server waits
 * `durationMs + 10s` (aggregation, refs and the round trip), capped at the
 * channel's 60s limit.
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

/** Must match DEFAULT/MIN/MAX_PROFILE_MS in src/lib/runtime/profile.ts. */
export const DEFAULT_PROFILE_MS = 3_000;
export const MIN_PROFILE_MS = 100;
export const MAX_PROFILE_MS = 30_000;
/** Extra time the server gives the page beyond the recording window. */
export const PROFILE_SERVER_GRACE_MS = 10_000;
/** Must match PROFILE_ACTION_TYPES in src/lib/runtime/profile.ts. */
export const UI_PROFILE_ACTIONS = ['click', 'input', 'scroll'] as const;

/** Recording window for the given arg (same clamp as the page). */
export function profileDurationMs(durationMs: unknown): number {
	if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return DEFAULT_PROFILE_MS;
	return Math.min(MAX_PROFILE_MS, Math.max(MIN_PROFILE_MS, Math.floor(durationMs)));
}

/** Server-side timeout for a `ui_profile` call: window + 10s, capped at 60s. */
export function profileServerTimeoutMs(durationMs: unknown): number {
	return Math.min(MAX_COMMAND_TIMEOUT_MS, profileDurationMs(durationMs) + PROFILE_SERVER_GRACE_MS);
}

export async function forwardProfile(
	channel: CommandChannel,
	rawArgs: Record<string, unknown> | undefined
): Promise<McpToolResult> {
	const { tabId, args } = splitForwardArgs(rawArgs);
	try {
		const result = await channel.send('ui_profile', args, {
			tabId,
			timeoutMs: profileServerTimeoutMs(args.durationMs)
		});
		return toToolResult(result);
	} catch (err) {
		return toToolError(err instanceof Error ? err.message : String(err));
	}
}

export function registerProfileTool(
	server: McpToolServer,
	z: ZodNamespace,
	deps: { channel: CommandChannel; tabIdHint: string }
): void {
	server.registerTool(
		'ui_profile',
		{
			title: 'Profile component DOM updates',
			description:
				"Use after ui_verify to check that a change didn't make a component hot (updating the DOM far too often). " +
				'Records for durationMs which Svelte components mutate the DOM, optionally while performing an in-page ' +
				'action on a ref (click / input / scroll, best effort, isTrusted=false; repeat runs are spread evenly over ' +
				'the window). Svelte 5 has no component re-renders: the counts are DOM mutations (childList, attributes, ' +
				'characterData) attributed to the component whose markup changed. Text starts with the verdict: ' +
				'"HOT <Component> N mutations in Xs (burst xK)" for each component with a burst (20+ mutation batches ' +
				'within 1s), else "QUIET". Then per component (top 15 by mutations): mutations, mutations/sec, bursts, ' +
				'kinds and the 3 most mutated elements as refs with file:line; FPS avg/min and long frames (> 50ms). ' +
				'Scope with component (that component and everything it renders) or ref (that subtree). The human Alt+P ' +
				'profiler keeps its own session (read it with get_profiler_report).',
			inputSchema: {
				durationMs: z
					.number()
					.int()
					.positive()
					.optional()
					.describe(`Recording window in ms (default ${DEFAULT_PROFILE_MS}, ${MIN_PROFILE_MS}..${MAX_PROFILE_MS}).`),
				action: z
					.object({
						ref: z.string().describe('Ref (eN) or ui:// stable key of the element to act on.'),
						type: z.enum(UI_PROFILE_ACTIONS).describe('"click", "input" (sets value, fires input + change) or "scroll".'),
						value: z
							.string()
							.optional()
							.describe('input: the text to set (required). scroll: "dy" or "dx,dy" px; omit to scroll into view.'),
						repeat: z
							.number()
							.int()
							.positive()
							.optional()
							.describe('How many times (default 1, max 50), spread evenly over the window.')
					})
					.optional()
					.describe('Optional in-page action performed while recording.'),
				component: z
					.string()
					.optional()
					.describe('Only count mutations inside instances of this component (e.g. "TodoList").'),
				ref: z.string().optional().describe('Only count mutations inside this element (eN or ui:// key).'),
				tabId: z.string().optional().describe(deps.tabIdHint)
			}
		},
		async (args) => forwardProfile(deps.channel, args)
	);
}
