import { test, expect, gotoPlayground, altKey, expectClipboardToContain } from './fixtures';

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
});
