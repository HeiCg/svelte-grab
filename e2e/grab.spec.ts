import { test, expect, gotoPlayground, grab, expectClipboardToContain } from './fixtures';

/**
 * SvelteGrab (the original tool): Alt+Click any element to copy its component
 * stack with source locations to the clipboard. This exercises the real
 * `__svelte_meta` walk against a genuine vite-dev build.
 */
test.describe('SvelteGrab — Alt+Click', () => {
	test.beforeEach(async ({ page }) => {
		await gotoPlayground(page);
	});

	test('copies the component stack with source locations to the clipboard', async ({ page }) => {
		await grab(page, '[data-testid="demo-button"]');

		const clip = await expectClipboardToContain(page, 'Component Stack:');

		// The nested Button > Card > App stack must be present with file:line refs.
		// Component entries are named by `componentTag` and point at the USAGE
		// site (`<Button>` in Card.svelte, `<Card>` in App.svelte).
		expect(clip).toContain('Button (src/components/Button.svelte');
		expect(clip).toContain('Button (src/components/Card.svelte');
		expect(clip).toContain('Card (src/App.svelte');
		// The line number for the grabbed element is included.
		expect(clip).toMatch(/Button\.svelte:\d+/);
	});

	test('opens the inspector popup for the grabbed element', async ({ page }) => {
		await grab(page, '[data-testid="demo-button"]');

		await expect(
			page.locator('[role="dialog"][aria-label="SvelteGrab component inspector"]')
		).toBeVisible();
	});

	test('walks into an {#each} list item and reports its component', async ({ page }) => {
		await grab(page, '[data-testid="demo-list-item-0"]');

		const clip = await expectClipboardToContain(page, 'List.svelte');
		// `<List>` usage site in App.svelte.
		expect(clip).toContain('List (src/App.svelte');
	});
});
