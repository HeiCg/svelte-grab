import {
	test,
	expect,
	gotoPlayground,
	altKey,
	expectClipboardToContain,
	readClipboard,
	styleGrab
} from './fixtures';

/**
 * SvelteDevKit mounts the full tool suite and only activates when Svelte's
 * dev-mode `__svelte_meta` is detected. These checks confirm dev-mode detection
 * succeeded against the real vite-dev build and the tools are live.
 */
test.describe('SvelteDevKit — dev-mode activation', () => {
	test('detects dev mode and activates the tools', async ({ page }) => {
		const logs: string[] = [];
		page.on('console', (m) => logs.push(m.text()));

		await gotoPlayground(page);

		// Each tool logs an "Active!" hint once detectDevMode() succeeds.
		expect(logs.some((l) => l.includes('[SvelteGrab] Active'))).toBe(true);
		expect(logs.some((l) => l.includes('[SvelteDevKit]'))).toBe(true);
	});

	test('confirms __svelte_meta is present on the rendered DOM', async ({ page }) => {
		await gotoPlayground(page);

		// The whole premise: vite dev emits __svelte_meta, which is what the tools
		// scan for. If this is missing, every tool would silently no-op.
		const hasMeta = await page.evaluate(() => {
			const els = document.querySelectorAll('*');
			for (const el of els) {
				if ((el as unknown as { __svelte_meta?: unknown }).__svelte_meta) return true;
			}
			return false;
		});
		expect(hasMeta).toBe(true);
	});

	test('toggles the help overlay with Alt+?', async ({ page }) => {
		await gotoPlayground(page);

		await altKey(page, '?');

		await expect(
			page.locator('[role="dialog"][aria-label="SvelteDevKit Keyboard Shortcuts"]')
		).toBeVisible();

		// The help popup is mounted hidden and opened later: its overlay root must
		// still get the svelte-grab UI marker (keeps it out of ui_snapshot /
		// ui_find) and the third-party redaction marks.
		const overlay = page.locator(
			'.sg-overlay:has([role="dialog"][aria-label="SvelteDevKit Keyboard Shortcuts"])'
		);
		await expect(overlay).toHaveAttribute('data-svelte-grab-ui', '');
		await expect(overlay).toHaveAttribute('data-sentry-block', '');
	});

	test('Alt+Shift+C copies the unified context export including prior tool output', async ({
		page
	}) => {
		await gotoPlayground(page);

		// Run the a11y audit first — it registers into the unified-export store.
		await altKey(page, 'a');
		await expectClipboardToContain(page, 'Accessibility Report');

		// Alt+Shift+C aggregates every registered tool's output.
		await page.keyboard.down('Alt');
		await page.keyboard.down('Shift');
		await page.keyboard.press('c');
		await page.keyboard.up('Shift');
		await page.keyboard.up('Alt');

		await expectClipboardToContain(page, 'Unified Context Export');
	});

	test('Shift+Alt+Click multi-selects without StateGrab; Alt+Meta+Click opens StateGrab', async ({
		page
	}) => {
		await gotoPlayground(page);
		const stateDialog = page.locator('[role="dialog"][aria-label="SvelteStateGrab inspector"]');

		// Two Shift+Alt+Clicks: both land in the multi-selection, no StateGrab popup.
		await page.getByTestId('fx-button-a').click({ modifiers: ['Alt', 'Shift'] });
		await page.getByTestId('fx-button-b').click({ modifiers: ['Alt', 'Shift'] });
		await expect(page.locator('.svelte-grab-highlight-selected')).toHaveCount(2);
		await expect(stateDialog).toHaveCount(0);
		await page.locator('.svelte-grab-floating-bar button', { hasText: 'Clear' }).click();
		await expect(page.locator('.svelte-grab-highlight-selected')).toHaveCount(0);

		// DevKit's StateGrab trigger is Alt+Meta+Click.
		await page.getByTestId('fx-button-a').click({ modifiers: ['Alt', 'Meta'] });
		await expect(stateDialog).toBeVisible();

		// The help overlay lists the new trigger.
		await page.keyboard.press('Escape');
		await altKey(page, '?');
		const help = page.locator('[role="dialog"][aria-label="SvelteDevKit Keyboard Shortcuts"]');
		await expect(help.locator('tr', { hasText: 'State Inspector' })).toContainText(
			'Alt+Meta+Click'
		);
	});

	test('Alt+Ctrl+Click and Alt+Meta+Click open only their tool, not SvelteGrab', async ({
		page
	}) => {
		await gotoPlayground(page);
		const grabDialog = page.locator('[role="dialog"][aria-label="SvelteGrab component inspector"]');
		const stateDialog = page.locator('[role="dialog"][aria-label="SvelteStateGrab inspector"]');
		const styleDialog = page.locator('[role="dialog"][aria-label="SvelteStyleGrab inspector"]');
		const selected = page.locator('.svelte-grab-highlight-selected');
		const sentinel = 'reserved-modifier-sentinel';
		await page.evaluate((s) => navigator.clipboard.writeText(s), sentinel);

		// Alt+Ctrl+Click: StyleGrab only (no grab popup, no stack copied).
		await styleGrab(page, '[data-testid="fx-button-a"]');
		await expect(styleDialog).toBeVisible();
		await expect(grabDialog).toHaveCount(0);
		expect(await readClipboard(page)).not.toContain('Component Stack:');
		await page.keyboard.press('Escape');
		await expect(styleDialog).toHaveCount(0);

		// Alt+Meta+Click: StateGrab only.
		await page.evaluate((s) => navigator.clipboard.writeText(s), sentinel);
		await page.getByTestId('fx-button-a').click({ modifiers: ['Alt', 'Meta'] });
		await expect(stateDialog).toBeVisible();
		await expect(grabDialog).toHaveCount(0);
		await expect(selected).toHaveCount(0);
		expect(await readClipboard(page)).not.toContain('Component Stack:');
		await page.keyboard.press('Escape');
		await expect(stateDialog).toHaveCount(0);

		// Plain Alt+Click still grabs.
		await page.getByTestId('fx-button-a').click({ modifiers: ['Alt'] });
		await expect(grabDialog).toBeVisible();
		await expectClipboardToContain(page, 'Component Stack:');
		await page.keyboard.press('Escape');
		await expect(grabDialog).toHaveCount(0);

		// Shift+Alt+Click still multi-selects.
		await page.getByTestId('fx-button-a').click({ modifiers: ['Alt', 'Shift'] });
		await page.getByTestId('fx-button-b').click({ modifiers: ['Alt', 'Shift'] });
		await expect(selected).toHaveCount(2);
		await expect(stateDialog).toHaveCount(0);
	});
});

/**
 * Remaining full-mode conflicts: Alt+DoubleClick (PropsTracer) vs Alt+Click
 * (SvelteGrab), and the A11y element audit vs SvelteGrab's selection-mode
 * context menu (Alt+RightClick). In DevKit the A11y element audit moves to
 * Alt+Shift+RightClick.
 */
test.describe('SvelteDevKit — double-click and right-click triggers', () => {
	const grabDialogSel = '[role="dialog"][aria-label="SvelteGrab component inspector"]';
	const tracerSel = '.sg-popup[aria-label="SveltePropsTracer"]';
	const a11ySel = '.sg-popup[aria-label="SvelteA11yReporter"]';

	/** Hold Alt, hover the target until SvelteGrab highlights it, then right-click. */
	async function altRightClick(
		page: import('@playwright/test').Page,
		testId: string,
		extra: 'Shift' | null
	): Promise<void> {
		const box = (await page.getByTestId(testId).boundingBox())!;
		const x = box.x + box.width / 2;
		const y = box.y + box.height / 2;
		await page.mouse.move(x, y);
		await page.keyboard.down('Alt');
		if (extra) await page.keyboard.down(extra);
		await page.mouse.move(x + 1, y + 1);
		await expect(page.locator('.svelte-grab-highlight').first()).toBeVisible();
		await page.mouse.click(x + 1, y + 1, { button: 'right' });
		if (extra) await page.keyboard.up(extra);
		await page.keyboard.up('Alt');
	}

	test('Alt+DoubleClick opens PropsTracer on the target and leaves no SvelteGrab popup', async ({
		page
	}) => {
		await gotoPlayground(page);

		await page.getByTestId('fx-button-a').dblclick({ modifiers: ['Alt'] });

		const tracer = page.locator(tracerSel);
		await expect(tracer).toBeVisible();
		// The trace is the clicked button's, not SvelteGrab's own overlay.
		await expect(tracer).toContainText('button');
		await expect(tracer).not.toContainText('SvelteGrab.svelte');
		await expect(page.locator(grabDialogSel)).toHaveCount(0);
		await expectClipboardToContain(page, 'Props Trace');

		// Plain Alt+Click still grabs and opens the SvelteGrab popup.
		await page.keyboard.press('Escape');
		await expect(tracer).toHaveCount(0);
		await page.getByTestId('fx-button-b').click({ modifiers: ['Alt'] });
		await expect(page.locator(grabDialogSel)).toBeVisible();
		await expectClipboardToContain(page, 'Component Stack:');
	});

	test('Alt+Shift+RightClick opens the A11y element audit only, no SvelteGrab context menu', async ({
		page
	}) => {
		await gotoPlayground(page);

		await altRightClick(page, 'fx-button-a', 'Shift');

		await expect(page.locator(a11ySel)).toBeVisible();
		await expect(page.locator('.sg-context-menu')).toHaveCount(0);
		await expect(page.locator('.svelte-grab-highlight-selected')).toHaveCount(0);
		await expectClipboardToContain(page, 'Accessibility Report');
	});

	test('Alt+RightClick in selection mode opens only the SvelteGrab context menu', async ({
		page
	}) => {
		await gotoPlayground(page);

		await altRightClick(page, 'fx-button-a', null);

		await expect(page.locator('.sg-context-menu')).toBeVisible();
		await expect(page.locator(a11ySel)).toHaveCount(0);
	});

	test('Alt+A still opens the full-page A11y audit; help lists the new element trigger', async ({
		page
	}) => {
		await gotoPlayground(page);

		await altKey(page, 'a');
		await expect(page.locator(a11ySel)).toBeVisible();
		await expectClipboardToContain(page, 'Accessibility Report');

		await page.keyboard.press('Escape');
		await altKey(page, '?');
		const help = page.locator('[role="dialog"][aria-label="SvelteDevKit Keyboard Shortcuts"]');
		await expect(help.locator('tr', { hasText: 'A11y Report (element)' })).toContainText(
			'Alt+Shift+RightClick'
		);
		await expect(help.locator('tr', { hasText: 'A11y Report (full page)' })).toContainText('Alt+A');
	});
});
