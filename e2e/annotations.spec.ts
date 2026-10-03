import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect, gotoPlayground, grab, altKey, expectClipboardToContain } from './fixtures';

/**
 * Annotation mode + `hotkeys="minimal"` (docs/agent-runtime-spec.md, Phase 6).
 *
 * The human collects annotations (hold Alt, hover or multi-select, press N,
 * type a comment), then "Send all" copies one agent text. The agent side is
 * the `ui_annotations` page tool, called in the page through Vite's `/@fs/`
 * module URL like e2e/runtime.spec.ts.
 */

const fsUrl = (rel: string) => '/@fs' + fileURLToPath(new URL(rel, import.meta.url));
const COMMANDS_URL = fsUrl('../src/lib/runtime/commands.ts');

interface Outcome {
	ok: boolean;
	error?: string;
	result?: { text: string; data?: Record<string, unknown> };
}

interface AnnotationsData {
	annotations: {
		id: number;
		comment: string;
		createdAt: number;
		refs: { ref: string; stableKey: string; component: string | null; source: string | null }[];
	}[];
	instruction: string;
	cleared: boolean;
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

const tray = (page: Page) => page.locator('[role="region"][aria-label="SvelteGrab annotations"]');

/** Hold Alt, hover `testid`, press N: the annotation editor opens for that element. */
async function annotateHovered(page: Page, testid: string, comment: string, id: number): Promise<void> {
	await page.keyboard.down('Alt');
	await page.getByTestId(testid).hover();
	await expect(page.locator('.svelte-grab-tooltip')).toBeVisible();
	await page.keyboard.press('n');
	const editor = page.getByLabel(`Comment for new annotation #${id}`, { exact: true });
	await expect(editor).toBeVisible();
	// Hold-mode: the editor survives releasing the modifier, so typing is clean.
	await page.keyboard.up('Alt');
	await expect(editor).toBeVisible();
	await editor.fill(comment);
	await editor.press('Enter');
	await expect(editor).toHaveCount(0);
}

test.describe('annotation mode', () => {
	test('collects a single and a multi-select annotation and sends them all', async ({
		activated: page
	}) => {
		// #1: one element
		await annotateHovered(page, 'fx-card-text-a', 'Make the card title bold', 1);
		await expect(tray(page)).toContainText('Annotations (1)');
		await expect(page.locator('[data-annotation-badge="1"]')).toHaveCount(1);

		// #2: multi-select two buttons with Shift+Alt+Click, then N.
		await page.keyboard.down('Alt');
		for (const testid of ['fx-button-a', 'fx-button-b']) {
			await page.getByTestId(testid).click({ modifiers: ['Alt', 'Shift'] });
		}
		await expect(page.locator('.svelte-grab-highlight-selected')).toHaveCount(2);
		await page.keyboard.press('n');
		const editor = page.getByLabel('Comment for new annotation #2', { exact: true });
		await expect(editor).toBeVisible();
		await expect(page.locator('.sg-prompt-overlay')).toContainText('2 elements');
		await page.keyboard.up('Alt');
		await editor.fill('Make both buttons green');
		await page.locator('.sg-prompt-overlay button', { hasText: 'Add annotation #2' }).click();

		await expect(tray(page)).toContainText('Annotations (2)');
		await expect(page.locator('[data-annotation-badge="2"]')).toHaveCount(2);
		// The annotated selection was consumed.
		await expect(page.locator('.svelte-grab-highlight-selected')).toHaveCount(0);

		// Overlay roots carry the svelte-grab UI marker and the redaction marks.
		await expect(tray(page)).toHaveAttribute('data-svelte-grab-ui', '');
		await expect(tray(page)).toHaveAttribute('data-sentry-block', '');
		await expect(page.locator('[data-annotation-badge="1"]')).toHaveAttribute('data-svelte-grab-ui', '');

		// Send all: one agent text with both comments and their sources.
		await tray(page).getByLabel('Instruction for all annotations').fill('Polish the fixtures');
		await tray(page).locator('button', { hasText: 'Send all' }).click();
		const clip = await expectClipboardToContain(page, 'UI annotations: 2');
		expect(clip).toContain('Instruction: Polish the fixtures');
		expect(clip).toContain('#1 (1 element): Make the card title bold');
		expect(clip).toContain('#2 (2 elements): Make both buttons green');
		expect(clip).toMatch(/<FixtureCard> src\/components\/fixtures\/FixtureCard\.svelte:\d+/);
		expect(clip).toMatch(/<Button> src\/components\/Button\.svelte:\d+/);
		expect(clip).toMatch(/key: ui:\/\/.*Button\.svelte:\d+:\d+#Button\[role=button/);
		await expect(tray(page)).toContainText('Copied');

		// The agent reads the same annotations with ui_annotations.
		const out = await callTool(page, 'ui_annotations', {});
		expect(out.ok, out.error).toBe(true);
		const data = out.result!.data as unknown as AnnotationsData;
		expect(data.instruction).toBe('Polish the fixtures');
		expect(data.annotations.map((a) => [a.id, a.comment, a.refs.length])).toEqual([
			[1, 'Make the card title bold', 1],
			[2, 'Make both buttons green', 2]
		]);
		expect(data.annotations[0].refs[0]).toMatchObject({ component: 'FixtureCard' });
		expect(data.annotations[0].refs[0].source).toMatch(/FixtureCard\.svelte:\d+$/);
		const buttonRefs = data.annotations[1].refs;
		expect(buttonRefs.map((r) => r.component)).toEqual(['Button', 'Button']);
		// Refs are registered: the locator works and ui_inspect accepts them.
		await expect(page.locator(`[data-sg-ref="${buttonRefs[0].ref}"]`)).toHaveAttribute(
			'data-testid',
			'fx-button-a'
		);
		await expect(page.locator(`[data-sg-ref="${buttonRefs[1].ref}"]`)).toHaveAttribute(
			'data-testid',
			'fx-button-b'
		);
		const inspected = await callTool(page, 'ui_inspect', { ref: buttonRefs[1].ref, include: ['stack'] });
		expect(inspected.ok, inspected.error).toBe(true);
		expect(inspected.result!.text).toContain('Button');

		// clear: true consumes them; the tray empties.
		const cleared = await callTool(page, 'ui_annotations', { clear: true });
		expect((cleared.result!.data as unknown as AnnotationsData).cleared).toBe(true);
		await expect(tray(page)).toHaveCount(0);
		await expect(page.locator('[data-annotation-badge]')).toHaveCount(0);
		const empty = await callTool(page, 'ui_annotations', {});
		expect(empty.result!.text).toMatch(/^No pending annotations\./);
	});

	test('the tray edits, deletes and clears annotations', async ({ activated: page }) => {
		await annotateHovered(page, 'fx-card-text-a', 'first', 1);
		await annotateHovered(page, 'fx-card-text-b', 'second', 2);

		const comment = tray(page).getByLabel('Comment for annotation #2', { exact: true });
		await comment.fill('second, edited');
		await comment.blur();
		await tray(page).getByLabel('Delete annotation #1').click();
		await expect(tray(page)).toContainText('Annotations (1)');

		const out = await callTool(page, 'ui_annotations', {});
		const data = out.result!.data as unknown as AnnotationsData;
		expect(data.annotations.map((a) => [a.id, a.comment])).toEqual([[2, 'second, edited']]);

		await tray(page).locator('button', { hasText: 'Clear all' }).click();
		await expect(tray(page)).toHaveCount(0);
	});
});

test.describe('annotation mode with MCP', () => {
	// A stand-in for the MCP server on a port nothing listens on: records what
	// the page posts and answers like the real /context endpoint.
	const FAKE_MCP_PORT = 4791;

	test('Send all posts the text to /context in the existing payload shape', async ({ page }) => {
		const posted: unknown[] = [];
		const cors = {
			'access-control-allow-origin': '*',
			'access-control-allow-headers': '*',
			'access-control-allow-methods': 'GET, POST, OPTIONS'
		};
		await page.route(`http://localhost:${FAKE_MCP_PORT}/**`, async (route) => {
			const req = route.request();
			if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
			if (req.method() === 'POST' && new URL(req.url()).pathname === '/context') {
				posted.push(req.postDataJSON());
			}
			return route.fulfill({
				status: 200,
				headers: cors,
				contentType: 'application/json',
				body: '{"ok":true}'
			});
		});
		await gotoPlayground(page, `/?mcp=1&mcpPort=${FAKE_MCP_PORT}`);

		await annotateHovered(page, 'fx-card-text-a', 'Bold title', 1);
		await tray(page).getByLabel('Instruction for all annotations').fill('Ship it');
		await tray(page).locator('button', { hasText: 'Send all' }).click();

		await expect.poll(() => posted.length).toBe(1);
		expect(posted[0]).toEqual({
			content: [expect.stringContaining('#1 (1 element): Bold title')],
			prompt: 'Ship it'
		});
		await expectClipboardToContain(page, 'Instruction: Ship it');
		await expect(tray(page)).toContainText('Sent and copied');
		// Still pending for ui_annotations after sending.
		const out = await callTool(page, 'ui_annotations', {});
		expect((out.result!.data as unknown as AnnotationsData).annotations).toHaveLength(1);
	});
});

test.describe('hotkeys="minimal"', () => {
	test.beforeEach(async ({ page }) => {
		await gotoPlayground(page, '/?hotkeys=minimal');
	});

	test('Alt+P, Alt+A and Alt+Shift+Click do nothing while Alt+Click still grabs', async ({ page }) => {
		await altKey(page, 'p');
		await altKey(page, 'a');
		await page.waitForTimeout(300);
		await expect(page.locator('[role="dialog"][aria-label="SvelteRenderProfiler"]')).toHaveCount(0);
		await expect(page.locator('.sg-prof-recording')).toHaveCount(0);
		await expect(page.locator('[role="dialog"][aria-label="SvelteA11yReporter"]')).toHaveCount(0);

		// Shift+Alt+Click only multi-selects (StateGrab's trigger is off).
		await page.getByTestId('fx-button-a').click({ modifiers: ['Alt', 'Shift'] });
		await expect(page.locator('.svelte-grab-highlight-selected')).toHaveCount(1);
		await expect(page.locator('[role="dialog"][aria-label="SvelteStateGrab inspector"]')).toHaveCount(0);
		await page.locator('.svelte-grab-floating-bar button', { hasText: 'Clear' }).click();

		await grab(page, '[data-testid="demo-button"]');
		await expectClipboardToContain(page, 'Component Stack:');
		await expect(
			page.locator('[role="dialog"][aria-label="SvelteGrab component inspector"]')
		).toBeVisible();
	});

	test('the annotation key still works', async ({ page }) => {
		await annotateHovered(page, 'fx-card-text-a', 'minimal mode note', 1);
		await expect(tray(page)).toContainText('Annotations (1)');
	});
});
