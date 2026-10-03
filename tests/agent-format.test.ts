import { describe, it, expect } from 'vitest';
import { formatForAgent } from '../src/lib/utils/agent-format';
import type { StackEntry } from '../src/lib/types';

const deps = {
	includeHtml: false,
	getHTMLPreview: () => '',
	extractComponentName: (file: string) => file.split('/').pop()?.replace('.svelte', '') ?? null,
	shortenPath: (file: string) => file
};

describe('formatForAgent component stack labels', () => {
	it('labels block entries as blocks and components by their tag', () => {
		const entries: StackEntry[] = [
			{
				type: 'element',
				file: 'src/components/List.svelte',
				line: 8,
				column: 3,
				componentName: 'List'
			},
			{ type: 'each', file: 'src/components/List.svelte', line: 7, column: 1 },
			{ type: 'component', file: 'src/App.svelte', line: 20, column: 1, componentName: 'List' },
			{ type: 'render', file: 'src/App.svelte', line: 30, column: 1 }
		];

		const out = formatForAgent(entries, null, deps);

		expect(out).toContain('1. List (src/components/List.svelte:8)');
		expect(out).toContain('2. {#each} (src/components/List.svelte:7)');
		expect(out).toContain('3. List (src/App.svelte:20)');
		expect(out).toContain('4. {@render} (src/App.svelte:30)');
	});
});
