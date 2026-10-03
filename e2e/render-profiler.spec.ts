import { test, expect, gotoPlayground, altKey } from './fixtures';

/**
 * SvelteRenderProfiler (Alt+P).
 *
 * Activating the profiler shows the recording popup + the floating widget. With
 * the live overlay enabled, DOM mutations (the counter burst) flash a tracked
 * outline whose host carries the `[data-svelte-grab-outline]` attribute. We
 * trigger the mutations via a JS `.click()` because the recording overlay sits
 * on top of the page and would otherwise intercept a real pointer click.
 */
test.describe('SvelteRenderProfiler — Alt+P', () => {
	test.beforeEach(async ({ page }) => {
		await gotoPlayground(page);
	});

	test('activates and shows the recording popup + widget', async ({ page }) => {
		await altKey(page, 'p');

		await expect(
			page.locator('[role="dialog"][aria-label="SvelteRenderProfiler"]')
		).toBeVisible();
		await expect(page.locator('.sg-prof-widget')).toBeVisible();
		// It starts recording immediately.
		await expect(page.locator('.sg-prof-recording')).toBeVisible();
	});

	test('paints a live mutation outline when the counter mutates the DOM', async ({ page }) => {
		await altKey(page, 'p');

		// Turn on the live mutation-highlight overlay.
		const live = page.locator('.sg-prof-live-row input[type="checkbox"]').first();
		await live.check();

		// Drive a burst of DOM mutations from the Counter component.
		await page.getByTestId('counter-burst').evaluate((el) => (el as HTMLElement).click());

		// The outline painter mounts its host element on the first flash.
		await expect(page.locator('[data-svelte-grab-outline]')).toHaveCount(1, { timeout: 7_000 });
	});

	test('reports hot components after a recorded burst', async ({ page }) => {
		await altKey(page, 'p');

		// Mutate, then stop the recording to surface the per-component profile.
		await page.getByTestId('counter-burst').evaluate((el) => (el as HTMLElement).click());
		await page.waitForTimeout(700);
		await page.locator('.sg-prof-btn-stop').click();

		// The profiler attributes the DOM updates to the Counter component.
		await expect(page.locator('.sg-prof-content')).toContainText('Counter');
	});
});
