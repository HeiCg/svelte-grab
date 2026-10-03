import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * `ui_verify` and `ui_component_impact` (Phase 5) against the real playground,
 * which runs the repo's svelte-grab/vite plugin. Same mechanics as
 * e2e/runtime.spec.ts: the page handlers are loaded from Vite's dev server
 * and called in the page, exactly as the SSE `runtime-command` handler would.
 */

const fsUrl = (rel: string) => '/@fs' + fileURLToPath(new URL(rel, import.meta.url));
const COMMANDS_URL = fsUrl('../src/lib/runtime/commands.ts');
const CAPTURE_URL = fsUrl('../src/lib/runtime/console-capture.ts');

interface Outcome {
	ok: boolean;
	error?: string;
	result?: { text: string; data?: Record<string, unknown> };
}

async function callTool(page: Page, tool: string, args: Record<string, unknown>): Promise<Outcome> {
	return page.evaluate(
		async ([url, t, a]) => {
			const mod = await import(/* @vite-ignore */ url as string);
			return mod.dispatchRuntimeCommand(t, a);
		},
		[COMMANDS_URL, tool, args] as const
	);
}

async function refFor(page: Page, selector: string): Promise<string> {
	const out = await callTool(page, 'ui_find', { selector });
	expect(out.ok, out.error).toBe(true);
	const matches = (out.result!.data as { matches: { ref: string }[] }).matches;
	expect(matches).toHaveLength(1);
	return matches[0].ref;
}

function checkLine(text: string, check: string): string {
	return text.split('\n').find((l) => new RegExp(`^(PASS|WARN|FAIL) ${check}\\b`).test(l)) ?? '';
}

test.describe('agent runtime: ui_verify / ui_component_impact', () => {
	test('ui_verify FAILs overflow while the fixture strip widens the page, PASSes once toggled off', async ({
		activated: page
	}) => {
		const toggle = page.getByTestId('fx-overflow-toggle');
		await toggle.click();
		await expect(page.getByTestId('fx-overflow-strip')).toBeVisible();
		const ref = await refFor(page, '[data-testid="fx-overflow-toggle"]');

		const failing = await callTool(page, 'ui_verify', { ref });
		expect(failing.ok, failing.error).toBe(true);
		const text = failing.result!.text;
		console.log(`--- ui_verify (overflow on) ---\n${text}`);
		const lines = text.split('\n');
		expect(lines[0]).toMatch(
			/^FAIL e\d+ button "Overflow: on" OverflowFixture src\/components\/fixtures\/OverflowFixture\.svelte:\d+$/
		);
		const overflow = checkLine(text, 'overflow');
		expect(overflow).toMatch(
			/^FAIL overflow page scrolls horizontally: document scrollWidth \d+ > clientWidth \d+$/
		);
		const offender = lines[lines.indexOf(overflow) + 1];
		expect(offender).toMatch(
			/^ {2}e\d+ div\.fx-overflow-strip OverflowFixture src\/components\/fixtures\/OverflowFixture\.svelte:\d+ extends \d+px past the page edge/
		);
		expect(checkLine(text, 'visible')).toMatch(/^PASS visible .*not covered$/);
		const data = failing.result!.data as {
			verdict: string;
			checks: { check: string; status: string }[];
		};
		expect(data.verdict).toBe('FAIL');
		expect(data.checks.find((c) => c.check === 'overflow')!.status).toBe('FAIL');
		// The named ref is the strip itself (usable as a Playwright locator).
		const stripRef = offender.trim().split(' ')[0];
		await expect(page.locator(`[data-sg-ref="${stripRef}"]`)).toHaveAttribute(
			'data-testid',
			'fx-overflow-strip'
		);

		await toggle.click();
		await expect(page.getByTestId('fx-overflow-strip')).toHaveCount(0);
		const passing = await callTool(page, 'ui_verify', {
			ref,
			checks: ['visible', 'overflow', 'a11y', 'contrast']
		});
		expect(passing.ok, passing.error).toBe(true);
		console.log(`--- ui_verify (overflow off) ---\n${passing.result!.text}`);
		expect(checkLine(passing.result!.text, 'overflow')).toMatch(
			/^PASS overflow .*no page-level horizontal overflow$/
		);
		expect(passing.result!.text.split('\n')[0]).toMatch(/^PASS /);
	});

	test('ui_verify console check reads the shared capture (errors FAIL, since filters)', async ({
		activated: page
	}) => {
		const ref = await refFor(page, '[data-testid="fx-overflow-toggle"]');
		// The runtime retains the capture while connected to the MCP server; the
		// playground runs without one here, so retain it by hand.
		const started = await page.evaluate(async (url) => {
			const { consoleCapture } = await import(/* @vite-ignore */ url);
			consoleCapture.retain();
			return Date.now();
		}, CAPTURE_URL);
		try {
			const clean = await callTool(page, 'ui_verify', { ref, checks: ['console'], since: started });
			expect(checkLine(clean.result!.text, 'console')).toMatch(
				/^PASS console no errors or warnings since /
			);

			await page.evaluate(() => {
				console.warn('[verify-e2e] heads up');
				console.error('[verify-e2e] boom', new TypeError('x is undefined'));
			});
			const out = await callTool(page, 'ui_verify', { ref, checks: ['console'], since: started });
			expect(out.ok, out.error).toBe(true);
			const text = out.result!.text;
			console.log(`--- ui_verify (console) ---\n${text}`);
			expect(text.split('\n')[0]).toMatch(/^FAIL /);
			expect(checkLine(text, 'console')).toMatch(/^FAIL console 1 error, 1 warning since /);
			expect(text).toContain(
				'\n  error (unknown source) [verify-e2e] boom TypeError: x is undefined\n'
			);
			expect(text).toContain('\n  warn (unknown source) [verify-e2e] heads up');

			const later = await callTool(page, 'ui_verify', {
				ref,
				checks: ['console'],
				since: Date.now() + 60_000
			});
			expect(checkLine(later.result!.text, 'console')).toMatch(/^PASS console/);
		} finally {
			await page.evaluate(async (url) => {
				const { consoleCapture } = await import(/* @vite-ignore */ url);
				consoleCapture.release();
			}, CAPTURE_URL);
		}
	});

	test('ui_component_impact on a FixtureCard Button: 3 instances, importers from the Vite plugin', async ({
		activated: page
	}) => {
		const ref = await refFor(page, '[data-testid="fx-button-a"]');
		const out = await callTool(page, 'ui_component_impact', { ref });
		expect(out.ok, out.error).toBe(true);
		const text = out.result!.text;
		console.log(`--- ui_component_impact ---\n${text}`);
		expect(text.split('\n')[0]).toBe('<Button> defined in src/components/Button.svelte');
		expect(text).toMatch(
			/\(this instance is used at src\/components\/fixtures\/FixtureCard\.svelte:\d+\)/
		);
		expect(text).toContain('INSTANCES on this page: 3');
		expect(text).toMatch(/src\/components\/fixtures\/FixtureCard\.svelte \(2\): line \d+ x2 -> /);
		expect(text).toMatch(/src\/components\/Card\.svelte \(1\): line \d+ -> /);
		expect(text).toMatch(/\n {2}pg-button x3 -> /);

		const data = out.result!.data as {
			instances: { count: number; refs: string[] };
			importers: { status: string; files: string[] };
			recommendation: string;
		};
		expect(data.instances.count).toBe(3);
		expect(data.importers.status).toBe('ok');
		expect(data.importers.files).toEqual(
			expect.arrayContaining([
				'src/components/fixtures/FixtureCard.svelte',
				'src/components/Card.svelte'
			])
		);
		expect(data.recommendation).toMatch(
			/^Changing src\/components\/Button\.svelte affects 3 instances on this page and \d+ importing files; prefer a prop\/variant or a local class at the usage site src\/components\/fixtures\/FixtureCard\.svelte:\d+ for a one-off change\.$/
		);
		for (const r of data.instances.refs)
			await expect(page.locator(`[data-sg-ref="${r}"]`)).toHaveCount(1);
	});
});
