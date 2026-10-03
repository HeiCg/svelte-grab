import { test, expect, gotoPlayground, altKey, expectClipboardToContain } from './fixtures';

/**
 * SvelteA11yReporter (Alt+A → full-page audit).
 *
 * The playground renders a deliberately low-contrast paragraph (light gray
 * #cccccc on white, ~1.6:1, well under the WCAG AA 4.5:1 floor). The audit must
 * flag it as an insufficient-contrast issue, both in the popup and in the
 * copied agent report.
 */
test.describe('SvelteA11yReporter — Alt+A', () => {
	test.beforeEach(async ({ page }) => {
		await gotoPlayground(page);
	});

	test('reports the low-contrast element in the popup', async ({ page }) => {
		await altKey(page, 'a');

		await expect(page.locator('.sg-popup[aria-label="SvelteA11yReporter"]')).toBeVisible();

		// A contrast issue is listed among the reported messages.
		await expect(
			page.locator('.sg-a11y-issue-msg', { hasText: 'contrast' }).first()
		).toBeVisible();

		// The offending element gets an a11y highlight outline injected.
		await expect(page.locator('[data-sg-a11y-highlight]').first()).toBeVisible();
	});

	test('copies an agent report that includes the contrast finding', async ({ page }) => {
		await altKey(page, 'a');

		const clip = await expectClipboardToContain(page, 'Accessibility Report');
		expect(clip).toContain('SCORE:');
		// The low-contrast text drives an "Insufficient contrast" finding.
		expect(clip).toMatch(/Insufficient contrast/i);
	});
});
