/**
 * MCP tools of the agent runtime: `ui_tabs` (server-only) and the page-forwarded
 * `ui_snapshot` / `ui_find` / `ui_inspect`.
 *
 * `zod` is passed in by the caller (it is loaded lazily together with the
 * optional `@modelcontextprotocol/sdk` peer, which requires it), so this module
 * has no runtime dependency on either.
 */

import type { TabRegistry, TabSummary } from './tab-registry.js';
import { NO_TAB_MESSAGE, type CommandChannel } from './command-channel.js';
import type { RuntimeResultData } from './validate.js';
import { registerWaitForHmrTool } from './hmr-tool.js';

/** Structural subset of a zod schema (v3.25+ and v4) used for tool schemas. */
export interface ZodSchemaLike {
	optional(): ZodSchemaLike;
	describe(description: string): ZodSchemaLike;
	int(): ZodSchemaLike;
	positive(): ZodSchemaLike;
}

/** Structural subset of the `z` namespace used for tool schemas. */
export interface ZodNamespace {
	string(): ZodSchemaLike;
	number(): ZodSchemaLike;
	boolean(): ZodSchemaLike;
	enum(values: readonly [string, ...string[]]): ZodSchemaLike;
	array(item: ZodSchemaLike): ZodSchemaLike;
	object(shape: Record<string, ZodSchemaLike>): ZodSchemaLike;
}

export interface McpToolResult {
	[key: string]: unknown;
	content: { type: 'text'; text: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

export interface McpToolConfig {
	title?: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
}

export type McpToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<McpToolResult>;

/** Structural subset of `McpServer` used to register tools. */
export interface McpToolServer {
	registerTool(name: string, config: McpToolConfig, handler: McpToolHandler): unknown;
}

export interface RuntimeToolDeps {
	registry: TabRegistry;
	channel: CommandChannel;
	now?: () => number;
}

const REF_RECIPE =
	'Refs (eN) are stamped on the element as the data-sg-ref attribute, so the CSS locator ' +
	'[data-sg-ref="e12"] works in Playwright MCP / chrome-devtools MCP for real clicks, typing and screenshots. ' +
	'Session refs die on re-render: prefer the ui:// stable key to find the element again.';

const TAB_ID_HINT = 'Target tab id from ui_tabs. Defaults to the active (last focused) tab.';

/** Map a page result to an MCP tool result (wire contract v1). */
export function toToolResult(result: RuntimeResultData): McpToolResult {
	const out: McpToolResult = { content: [{ type: 'text', text: result.text }] };
	if (result.data !== undefined) out.structuredContent = result.data;
	return out;
}

export function toToolError(message: string): McpToolResult {
	return { content: [{ type: 'text', text: message }], isError: true };
}

/** Split MCP args into the forwarded page args (no `tabId`, no undefined) and `tabId`. */
export function splitForwardArgs(args: Record<string, unknown> | undefined): {
	tabId?: string;
	args: Record<string, unknown>;
} {
	const forwarded: Record<string, unknown> = {};
	let tabId: string | undefined;
	for (const [key, value] of Object.entries(args ?? {})) {
		if (value === undefined) continue;
		if (key === 'tabId') {
			if (typeof value === 'string') tabId = value;
			continue;
		}
		forwarded[key] = value;
	}
	return { tabId, args: forwarded };
}

/** Forward a tool call to the page and map the outcome to an MCP result. */
export async function forwardToPage(
	channel: CommandChannel,
	tool: string,
	rawArgs: Record<string, unknown> | undefined
): Promise<McpToolResult> {
	const { tabId, args } = splitForwardArgs(rawArgs);
	try {
		return toToolResult(await channel.send(tool, args, { tabId }));
	} catch (err) {
		return toToolError(err instanceof Error ? err.message : String(err));
	}
}

function formatAge(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

export function formatTabs(tabs: TabSummary[], now: number): string {
	if (tabs.length === 0) return NO_TAB_MESSAGE;
	const lines = tabs.map((tab) => {
		const flags = [tab.active ? 'active' : '', tab.focused ? 'focused' : ''].filter(Boolean).join(', ');
		const title = tab.title ? ` "${tab.title}"` : '';
		return `- ${tab.tabId}${flags ? ` [${flags}]` : ''}${title} ${tab.url} (seen ${formatAge(now - tab.lastSeen)})`;
	});
	return `Connected browser tabs (${tabs.length}):\n${lines.join('\n')}`;
}

/** `ui_tabs` handler: lists connected tabs (server-only, no page round trip). */
export function uiTabs(registry: TabRegistry, now: number): McpToolResult {
	const tabs = registry.summaries();
	return {
		content: [{ type: 'text', text: formatTabs(tabs, now) }],
		structuredContent: { tabs }
	};
}

/** Sections `ui_inspect` can return (besides the always-on COMPONENT and SOURCE). */
export const UI_INSPECT_SECTIONS = ['stack', 'props', 'state', 'styles', 'layout', 'a11y', 'usage'] as const;

/** Register `ui_tabs`, `ui_snapshot`, `ui_find` and `ui_inspect`. */
export function registerRuntimeTools(server: McpToolServer, z: ZodNamespace, deps: RuntimeToolDeps): void {
	const now = deps.now ?? (() => Date.now());

	server.registerTool(
		'ui_tabs',
		{
			title: 'List connected browser tabs',
			description:
				'Lists browser tabs running the app in dev with <SvelteGrab/> mounted and connected to this server: ' +
				'tabId, url, title, focused, lastSeen (epoch ms) and which one is active. ui_* tools target the active ' +
				'tab (last focused, else most recently seen) unless you pass tabId.',
			outputSchema: {
				tabs: z.array(
					z.object({
						tabId: z.string(),
						url: z.string(),
						title: z.string(),
						focused: z.boolean(),
						lastSeen: z.number(),
						active: z.boolean()
					})
				)
			}
		},
		async () => uiTabs(deps.registry, now())
	);

	server.registerTool(
		'ui_snapshot',
		{
			title: 'Snapshot the live Svelte UI',
			description:
				'Returns a compact indented tree of the live Svelte app in the browser: only elements with Svelte ' +
				'metadata or an accessible role/name. Each line: eN <role/tag> "<name>" <Component> <file:line>. ' +
				'detail "normal" adds box + classes. Start here, then use ui_find to narrow down. ' +
				REF_RECIPE,
			inputSchema: {
				scope: z
					.string()
					.optional()
					.describe('"viewport", "page", or a ref (eN or ui:// key) to snapshot only that subtree.'),
				detail: z.enum(['minimal', 'normal']).optional().describe('"minimal" (default) or "normal" (adds box + classes).'),
				maxNodes: z.number().int().positive().optional().describe('Maximum nodes in the tree (default 200).'),
				tabId: z.string().optional().describe(TAB_ID_HINT)
			}
		},
		async (args) => forwardToPage(deps.channel, 'ui_snapshot', args)
	);

	server.registerTool(
		'ui_find',
		{
			title: 'Find elements in the live Svelte UI',
			description:
				'Finds elements in the live Svelte app by any of text, role, name, component, file or selector. ' +
				'Returns a list of { ref, stableKey, component, source, role, name, box, visible }. ' +
				REF_RECIPE,
			inputSchema: {
				text: z.string().optional().describe('Visible text content to match.'),
				role: z.string().optional().describe('ARIA role (explicit or implicit), e.g. "button".'),
				name: z.string().optional().describe('Accessible name.'),
				component: z.string().optional().describe('Svelte component name, e.g. "Card".'),
				file: z.string().optional().describe('Source file (path or suffix), e.g. "src/lib/Card.svelte".'),
				selector: z.string().optional().describe('CSS selector.'),
				limit: z.number().int().positive().optional().describe('Maximum number of matches.'),
				tabId: z.string().optional().describe(TAB_ID_HINT)
			}
		},
		async (args) => forwardToPage(deps.channel, 'ui_find', args)
	);

	server.registerTool(
		'ui_inspect',
		{
			title: 'Inspect one element of the live Svelte UI',
			description:
				'The heavy, on-demand context for ONE element: call ui_snapshot / ui_find first to get a ref, then ' +
				'ui_inspect it. Returns sectioned text: COMPONENT and SOURCE (file:line:col to edit), STACK (component ' +
				'chain with usage sites), PROPS/ATTRIBUTES, STATE (inspectable() $state), LAYOUT (box, display, position, ' +
				'visibility, overflow/clipping), STYLES (matched CSS rules, authored declarations with source, ' +
				'Svelte-scoped/Tailwind detection, conflicts), A11Y (role, name, contrast, element-level issues) and ' +
				'USAGE (other instances of the same component, with refs). structuredContent carries the same data. ' +
				'Output is capped at ~8000 chars; use include to ask for fewer sections. A stale ref is re-resolved by ' +
				'its stable key and reported as rebound at the top. ' +
				REF_RECIPE,
			inputSchema: {
				ref: z.string().describe('Element ref (eN) or ui:// stable key from ui_snapshot / ui_find.'),
				include: z
					.array(z.enum(UI_INSPECT_SECTIONS))
					.optional()
					.describe(
						'Sections to return (default all): stack, props, state, styles, layout, a11y, usage. ' +
							'COMPONENT and SOURCE are always included.'
					),
				tabId: z.string().optional().describe(TAB_ID_HINT)
			}
		},
		async (args) => forwardToPage(deps.channel, 'ui_inspect', args)
	);

	server.registerTool(
		'ui_annotations',
		{
			title: "Read the human's pending UI annotations",
			description:
				'Returns the annotations the human collected in the page with SvelteGrab annotation mode (hold the ' +
				'modifier, select one element or several, press N, type a comment): { annotations: [{ id, comment, ' +
				'refs: [{ ref, stableKey, component, source }], createdAt }], instruction }. Each annotation is one ' +
				'requested change; instruction applies to all of them. Pass the refs to ui_inspect for full context. ' +
				'clear: true marks them consumed (the page tray empties); without it they stay pending. ' +
				REF_RECIPE,
			inputSchema: {
				clear: z
					.boolean()
					.optional()
					.describe('Mark the returned annotations as consumed (default false: they stay pending).'),
				tabId: z.string().optional().describe(TAB_ID_HINT)
			}
		},
		async (args) => forwardToPage(deps.channel, 'ui_annotations', args)
	);

	registerWaitForHmrTool(server, z, { channel: deps.channel, tabIdHint: TAB_ID_HINT });
}
