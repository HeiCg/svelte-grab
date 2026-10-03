/**
 * MCP tool `ui_security_scan` (docs/agent-runtime-spec.md, Phase 9b):
 * forwards to the page, which runs the runtime security checks over the
 * network buffer, Web Storage, cookies, globals, SvelteKit serialized data,
 * client env, response headers (same-origin HEAD) and the DOM. Evidence is
 * always redacted page-side.
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

/** Must match SECURITY_CHECKS in src/lib/runtime/security-scan.ts. */
export const UI_SECURITY_CHECKS = [
	'transit',
	'storage',
	'cookies',
	'globals',
	'sveltekit',
	'env',
	'headers',
	'dom',
	'mixed'
] as const;

/** The scan does a couple of HEAD requests and an IndexedDB listing. */
export const SECURITY_SCAN_TIMEOUT_MS = Math.min(MAX_COMMAND_TIMEOUT_MS, 20_000);

export async function forwardSecurityScan(
	channel: CommandChannel,
	rawArgs: Record<string, unknown> | undefined
): Promise<McpToolResult> {
	const { tabId, args } = splitForwardArgs(rawArgs);
	try {
		return toToolResult(await channel.send('ui_security_scan', args, { tabId, timeoutMs: SECURITY_SCAN_TIMEOUT_MS }));
	} catch (err) {
		return toToolError(err instanceof Error ? err.message : String(err));
	}
}

export function registerSecurityScanTool(
	server: McpToolServer,
	z: ZodNamespace,
	deps: { channel: CommandChannel; tabIdHint: string }
): void {
	server.registerTool(
		'ui_security_scan',
		{
			title: 'Security scan of the live page',
			description:
				'Runtime security checks on the page in the browser; run after ui_network (ideally ' +
				'ui_network({ reload: true })) so the request checks see the page load. Checks: transit (secrets in ' +
				'URLs, Authorization/Cookie/API-key headers or credentials in bodies sent to third-party origins), ' +
				'storage (JWTs / keys in localStorage, sessionStorage, auth-looking IndexedDB), cookies (auth cookies ' +
				'readable by JS = missing HttpOnly), globals (secrets on window), sveltekit (sensitive fields in ' +
				'serialized page data: inline boot script, data-sveltekit-fetched payloads, __data.json / remote ' +
				'function responses captured with includeBodies), env (secret-shaped VITE_/PUBLIC_ values exposed to ' +
				'the client), headers (CSP, nosniff, Referrer-Policy, frame-ancestors, HSTS, reachable source maps; ' +
				'info on a localhost dev server), dom ({@html}-style inline handlers / javascript: URLs, ' +
				'target=_blank without rel=noopener), mixed (http/ws from https). Text is grouped by severity ' +
				'(HIGH, MEDIUM, LOW, INFO); each finding: id, [confirmed|needs_validation], title, evidence, source ' +
				'(file:line when known), fix. structuredContent: { counts, findings: [{ id, check, severity, verdict, ' +
				'title, evidence, source?, fix }], notes }. Evidence is always redacted as kind:abcd…(len N, sha ' +
				'xxxxxx): the same secret gets the same sha, so occurrences can be matched without seeing it.',
			inputSchema: {
				checks: z
					.array(z.enum(UI_SECURITY_CHECKS))
					.optional()
					.describe(`Checks to run (default all): ${UI_SECURITY_CHECKS.join(', ')}.`),
				tabId: z.string().optional().describe(deps.tabIdHint)
			}
		},
		async (args) => forwardSecurityScan(deps.channel, args)
	);
}
