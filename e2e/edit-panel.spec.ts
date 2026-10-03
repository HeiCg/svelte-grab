import { test, expect, gotoPlayground, styleGrab, expectClipboardToContain } from './fixtures';

/**
 * SvelteStyleGrab live-edit panel (Alt+Ctrl+Click → Edit mode).
 *
 * Verifies the observable effects of a live edit:
 *  1. the panel opens for the captured element,
 *  2. tweaking a value writes an inline-style PREVIEW onto the live DOM element,
 *  3. "Copy edit prompt" puts a SOURCE-LOCATED prompt on the clipboard.
 */
test.describe('SvelteStyleGrab — live edit panel', () => {
	test.beforeEach(async ({ page }) => {
		await gotoPlayground(page);
	});

	test('opens the style inspector for the captured element', async ({ page }) => {
		await styleGrab(page, '[data-testid="editable-box"]');

		await expect(
			page.locator('[role="dialog"][aria-label="SvelteStyleGrab inspector"]')
		).toBeVisible();
	});

	test('editing padding previews an inline style on the live element', async ({ page }) => {
		await styleGrab(page, '[data-testid="editable-box"]');

		// Enter edit mode.
		await page.locator('.sg-style-edit-toggle').click();
		await expect(page.locator('button[aria-label="increase padding"]')).toBeVisible();

		const box = page.getByTestId('editable-box');

		// No inline padding before the edit (the 12px comes from a scoped class).
		expect(await box.evaluate((el) => (el as HTMLElement).style.paddingTop)).toBe('');

		// Bump padding twice (12 -> 14px via the +1 stepper).
		const increase = page.locator('button[aria-label="increase padding"]');
		await increase.click();
		await increase.click();

		// The preview wrote an inline padding onto the live element.
		await expect
			.poll(() => box.evaluate((el) => (el as HTMLElement).style.paddingTop))
			.toBe('14px');

		// And it shows up in the panel's pending-changes diff.
		await expect(page.locator('.sg-style-edit-diff', { hasText: 'padding' })).toBeVisible();
	});

	test('"Copy edit prompt" puts a source-located prompt on the clipboard', async ({ page }) => {
		await styleGrab(page, '[data-testid="editable-box"]');
		await page.locator('.sg-style-edit-toggle').click();

		const increase = page.locator('button[aria-label="increase padding"]');
		await increase.click();
		await increase.click();

		await page.getByRole('button', { name: 'Copy edit prompt' }).click();

		const clip = await expectClipboardToContain(page, 'EditableBox.svelte');
		// The prompt references the component, source line, and the padding change.
		expect(clip).toContain('<EditableBox>');
		expect(clip).toMatch(/padding\s+12px\s*→\s*14px/);
		expect(clip).toContain('padding-top: 14px;');
	});
});
