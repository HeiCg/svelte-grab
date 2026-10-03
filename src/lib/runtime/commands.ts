/**
 * Page-side tool dispatch for `runtime-command` events.
 */
import { uiAnnotations } from './annotations.js';
import { uiFind } from './find.js';
import { uiComponentImpact } from './impact.js';
import { uiInspect } from './inspect.js';
import { uiWaitForHmr } from './hmr.js';
import { uiSnapshot } from './snapshot.js';
import { uiVerify } from './verify.js';
import type { RuntimeCommandOutcome, RuntimeToolHandler } from './types.js';

/** Tools this page implements (wire contract v1, Phases 2-5). */
export const runtimeTools: Readonly<Record<string, RuntimeToolHandler>> = Object.freeze({
	ui_snapshot: (args) => uiSnapshot(args),
	ui_find: (args) => uiFind(args),
	ui_inspect: (args) => uiInspect(args),
	ui_annotations: (args) => uiAnnotations(args),
	ui_wait_for_hmr: (args) => uiWaitForHmr(args),
	ui_verify: (args) => uiVerify(args),
	ui_component_impact: (args) => uiComponentImpact(args)
});

/**
 * Run one tool. Unknown tool -> `{ok:false, error:'Unknown tool'}`; a handler
 * that throws -> `{ok:false, error:<message>}`.
 */
export async function dispatchRuntimeCommand(
	tool: string,
	args: unknown,
	tools: Readonly<Record<string, RuntimeToolHandler>> = runtimeTools
): Promise<RuntimeCommandOutcome> {
	if (typeof tool !== 'string' || !Object.prototype.hasOwnProperty.call(tools, tool)) {
		return { ok: false, error: 'Unknown tool' };
	}
	const safeArgs =
		args && typeof args === 'object' && !Array.isArray(args)
			? (args as Record<string, unknown>)
			: {};
	try {
		const result = await tools[tool](safeArgs);
		return { ok: true, result };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
