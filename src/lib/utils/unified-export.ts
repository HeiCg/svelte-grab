/**
 * Unified export store for all svelte-grab tools.
 *
 * Each tool registers its last formatForAgent() output here.
 * The DevKit's "Copy All Context" (Alt+Shift+C) aggregates them.
 */

const toolOutputs = new Map<string, { output: string; timestamp: number }>();

/**
 * Priority order for tool outputs.
 * Lower number = higher priority (shown first in unified export).
 */
const TOOL_PRIORITY: Record<string, number> = {
	ErrorContext: 0,
	StateGrab: 1,
	A11yReporter: 2,
	StyleGrab: 3,
	PropsTracer: 4,
	RenderProfiler: 5,
};

/**
 * Approximate token limit for unified export (chars, ~4 chars per token).
 */
const MAX_EXPORT_CHARS = 16000;

/**
 * Register the latest output from a tool.
 */
export function registerToolOutput(toolName: string, output: string): void {
	toolOutputs.set(toolName, { output, timestamp: Date.now() });
}

/**
 * Get the latest output from a specific tool.
 */
export function getToolOutput(toolName: string): string | undefined {
	return toolOutputs.get(toolName)?.output;
}

/**
 * Get all registered tool outputs, sorted by priority.
 */
export function getAllToolOutputs(): { toolName: string; output: string; timestamp: number }[] {
	return Array.from(toolOutputs.entries())
		.map(([toolName, data]) => ({ toolName, ...data }))
		.sort((a, b) => {
			const pa = TOOL_PRIORITY[a.toolName] ?? 99;
			const pb = TOOL_PRIORITY[b.toolName] ?? 99;
			return pa - pb;
		});
}

/**
 * Generate a brief executive summary from tool outputs.
 */
function generateSummary(entries: { toolName: string; output: string }[]): string {
	const summaryParts: string[] = [];

	for (const entry of entries) {
		const output = entry.output;
		switch (entry.toolName) {
			case 'ErrorContext': {
				const errorMatch = output.match(/(\d+) error/i);
				const warnMatch = output.match(/(\d+) warning/i);
				const errorCount = errorMatch ? errorMatch[1] : '0';
				const warnCount = warnMatch ? warnMatch[1] : '0';
				if (output.includes('ERROR') || output.includes('WARNING')) {
					summaryParts.push(`Errors: ${errorCount} errors, ${warnCount} warnings`);
				}
				break;
			}
			case 'A11yReporter': {
				const scoreMatch = output.match(/SCORE:\s*(\d+)\/100/);
				const critMatch = output.match(/CRITICAL\s*\((\d+)\)/);
				if (scoreMatch) {
					summaryParts.push(`A11y: score ${scoreMatch[1]}/100${critMatch ? `, ${critMatch[1]} critical` : ''}`);
				}
				break;
			}
			case 'StateGrab': {
				const compMatch = output.match(/Component State:\s*(.+?)\s*===/);
				const changesMatch = output.match(/STATE CHANGES/);
				summaryParts.push(`State: ${compMatch ? compMatch[1] : 'captured'}${changesMatch ? ' (changes detected)' : ''}`);
				break;
			}
			case 'StyleGrab': {
				const conflictMatch = output.match(/DETECTED CONFLICTS/);
				const conflictCountMatch = output.match(/defined in (\d+) places/g);
				summaryParts.push(`Styles: captured${conflictMatch ? `, ${conflictCountMatch?.length || 0} conflicts` : ''}`);
				break;
			}
			case 'RenderProfiler': {
				const hotMatch = output.match(/HOT COMPONENTS/);
				const burstMatch = output.match(/DETECTED BURSTS/);
				if (hotMatch || burstMatch) {
					summaryParts.push(`Profiler: ${hotMatch ? 'hot components found' : ''}${burstMatch ? ', bursts detected' : ''}`);
				} else {
					summaryParts.push('Profiler: healthy');
				}
				break;
			}
			default:
				summaryParts.push(`${entry.toolName}: data captured`);
		}
	}

	return summaryParts.join(' | ');
}

/**
 * Format all tool outputs into a single string for LLM consumption.
 * Outputs are ordered by priority with an executive summary.
 * Large outputs are truncated to stay within token limits.
 */
export function formatUnifiedExport(): string {
	const entries = getAllToolOutputs();
	if (entries.length === 0) {
		return 'No tool outputs captured yet. Use the individual tools first, then copy all context.';
	}

	const summary = generateSummary(entries);

	const parts: string[] = [
		`=== svelte-grab: Unified Context Export ===`,
		`Captured at: ${new Date().toISOString()}`,
		`Tools with data: ${entries.length}`,
		'',
		`SUMMARY: ${summary}`,
		''
	];

	let totalChars = parts.join('\n').length;

	for (const entry of entries) {
		const header = [
			'='.repeat(50),
			`[${entry.toolName}] (captured ${formatAge(entry.timestamp)})`,
			'='.repeat(50),
		].join('\n');

		const headerLen = header.length + 2; // +2 for newlines
		const remaining = MAX_EXPORT_CHARS - totalChars - headerLen;

		if (remaining <= 100) {
			parts.push(`\n[${entry.toolName}] (truncated - output limit reached)`);
			break;
		}

		parts.push(header);

		if (entry.output.length <= remaining) {
			parts.push(entry.output);
		} else {
			// Truncate, keeping the beginning which usually has the most important info
			parts.push(entry.output.slice(0, remaining - 40));
			parts.push(`\n... [${entry.toolName} truncated, ${entry.output.length - remaining + 40} chars omitted]`);
		}
		parts.push('');

		totalChars = parts.join('\n').length;
	}

	return parts.join('\n');
}

function formatAge(timestamp: number): string {
	const seconds = Math.floor((Date.now() - timestamp) / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	return `${Math.floor(minutes / 60)}h ago`;
}

/**
 * Clear all stored tool outputs.
 */
export function clearToolOutputs(): void {
	toolOutputs.clear();
}
