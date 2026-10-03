/**
 * MCP prompts of the svelte-grab server (`prompts` capability): the packaged
 * agent skills, usable from any MCP client with zero install.
 *
 * - `svelte-grab-loop`: the core ui_* loop (skills/svelte-grab/SKILL.md).
 * - `security-audit` / `performance-audit`: the audit workflow
 *   (skills/svelte-grab-audit/SKILL.md) plus the matching CHECKLIST.md section.
 *
 * Skill files are read from the package at call time; when they are missing
 * (unusual install) a short built-in text is returned instead.
 */

import { readPackagedSkillFile } from '../utils/packaged-skills.js';
import { parseSkillFrontmatter } from '../cli/skills-plan.js';
import type { ZodNamespace, ZodSchemaLike } from './runtime/tools.js';

export interface McpPromptResult {
	[key: string]: unknown;
	description?: string;
	messages: { role: 'user'; content: { type: 'text'; text: string } }[];
}

export interface McpPromptConfig {
	title?: string;
	description?: string;
	argsSchema?: Record<string, ZodSchemaLike>;
}

/** Structural subset of `McpServer` used to register prompts (SDK >= 1.26). */
export interface McpPromptServer {
	registerPrompt(
		name: string,
		config: McpPromptConfig,
		cb: (
			args: Record<string, unknown>,
			extra: unknown
		) => McpPromptResult | Promise<McpPromptResult>
	): unknown;
}

/** Prompt names, in registration order. */
export const PROMPT_NAMES = ['svelte-grab-loop', 'security-audit', 'performance-audit'] as const;

export const SECURITY_CHECKLIST_HEADING = 'Security checklist';
export const PERFORMANCE_CHECKLIST_HEADING = 'Performance checklist';

const FALLBACK_LOOP =
	'Use the svelte-grab MCP tools on the running Svelte app: ui_snapshot -> ui_find -> ui_inspect -> ' +
	'ui_component_impact (before editing a shared component) -> edit -> ui_wait_for_hmr -> ui_verify -> ui_profile. ' +
	'Refs (eN) are CSS locators [data-sg-ref="eN"] for Playwright / chrome-devtools MCP.';

const FALLBACK_AUDIT =
	'Per screen: ui_network({ reload: true }), ui_security_scan(), ui_profile({ durationMs: 3000 }) at idle, ' +
	'ui_verify on key elements; with CDP mode also ui_perf_metrics and ui_leak_check on modals/toggles. Run ' +
	'npx svelte-grab audit --json audit.json for static findings. Validate every candidate before calling it ' +
	'confirmed; needs_validation must name the missing fact. Never write a full secret. Budgets: <= 50 requests, ' +
	'<= 1.5 MB, <= 10 third-party per screen.';

/** SKILL.md without its frontmatter, or the fallback text. */
function skillBody(skill: string, fallback: string): string {
	const content = readPackagedSkillFile(`${skill}/SKILL.md`);
	if (!content) return fallback;
	return (parseSkillFrontmatter(content)?.body ?? content).trim();
}

/**
 * The `## <heading>...` section of a Markdown document (up to the next `## `
 * heading), or null when there is none.
 */
export function markdownSection(markdown: string, heading: string): string | null {
	const lines = markdown.split(/\r?\n/);
	const start = lines.findIndex(
		(line) => /^##\s/.test(line) && line.slice(2).trim().startsWith(heading)
	);
	if (start === -1) return null;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^##?\s/.test(lines[i])) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end).join('\n').trim();
}

function checklistSection(heading: string): string {
	const checklist = readPackagedSkillFile('svelte-grab-audit/CHECKLIST.md');
	return (
		(checklist && markdownSection(checklist, heading)) ??
		`## ${heading}\n\n(CHECKLIST.md not found in the package.)`
	);
}

function userMessage(description: string, text: string): McpPromptResult {
	return { description, messages: [{ role: 'user', content: { type: 'text', text } }] };
}

function stringArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = args?.[key];
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function target(args: Record<string, unknown> | undefined): string {
	const screen = stringArg(args, 'screen');
	const url = stringArg(args, 'url');
	if (screen && url) return `the screen "${screen}" (${url})`;
	if (screen) return `the screen "${screen}"`;
	if (url) return url;
	return 'the app (pick the screens as described in Phase 1)';
}

export function securityAuditPrompt(args?: Record<string, unknown>): McpPromptResult {
	const text = [
		`Run a security audit of ${target(args)} with the svelte-grab tools, following this workflow and checklist.`,
		'Focus on the security checklist; report with the template in skills/svelte-grab-audit/REPORT-TEMPLATE.md ' +
			'(per-screen table, findings with severity, verdict, evidence, file:line and fix).',
		'',
		skillBody('svelte-grab-audit', FALLBACK_AUDIT),
		'',
		checklistSection(SECURITY_CHECKLIST_HEADING)
	].join('\n');
	return userMessage('Security audit with svelte-grab', text);
}

export function performanceAuditPrompt(args?: Record<string, unknown>): McpPromptResult {
	const text = [
		`Run a performance audit of ${target(args)} with the svelte-grab tools, following this workflow and checklist.`,
		'Focus on the performance checklist (requests, bytes, third parties, duplicates, waterfalls, hot components, ' +
			'long frames, memory); report with the template in skills/svelte-grab-audit/REPORT-TEMPLATE.md.',
		'',
		skillBody('svelte-grab-audit', FALLBACK_AUDIT),
		'',
		checklistSection(PERFORMANCE_CHECKLIST_HEADING)
	].join('\n');
	return userMessage('Performance audit with svelte-grab', text);
}

export function svelteGrabLoopPrompt(): McpPromptResult {
	const text = [
		'Work on the running Svelte app with the svelte-grab MCP tools, following this guide.',
		'',
		skillBody('svelte-grab', FALLBACK_LOOP)
	].join('\n');
	return userMessage('The svelte-grab agent loop', text);
}

/** Register `svelte-grab-loop`, `security-audit` and `performance-audit`. */
export function registerSkillPrompts(server: McpPromptServer, z: ZodNamespace): void {
	server.registerPrompt(
		'svelte-grab-loop',
		{
			title: 'svelte-grab agent loop',
			description:
				'How to inspect, edit and verify the live Svelte UI: ui_snapshot -> ui_find -> ui_inspect -> ' +
				'ui_component_impact -> edit -> ui_wait_for_hmr -> ui_verify -> ui_profile, plus ref locators for ' +
				'Playwright / chrome-devtools MCP.'
		},
		async () => svelteGrabLoopPrompt()
	);

	server.registerPrompt(
		'security-audit',
		{
			title: 'Security audit (svelte-grab)',
			description:
				'Per-screen security audit of the Svelte app: credentials in transit and at rest, SvelteKit data ' +
				'exposure, headers, DOM, static scan; verified findings. Inlines the workflow and the security checklist.',
			argsSchema: {
				screen: z
					.string()
					.optional()
					.describe('Route or name of the screen to audit (default: pick the main screens).'),
				url: z.string().optional().describe('URL of the screen in the dev server.')
			}
		},
		async (args) => securityAuditPrompt(args)
	);

	server.registerPrompt(
		'performance-audit',
		{
			title: 'Performance audit (svelte-grab)',
			description:
				'Per-screen performance audit of the Svelte app: requests, bytes, third parties, duplicates, ' +
				'waterfalls, hot components, long frames and memory leaks against budgets. Inlines the workflow and ' +
				'the performance checklist.',
			argsSchema: {
				screen: z
					.string()
					.optional()
					.describe('Route or name of the screen to audit (default: pick the main screens).')
			}
		},
		async (args) => performanceAuditPrompt(args)
	);
}
