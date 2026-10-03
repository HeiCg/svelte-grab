import { test as base, expect, type Page } from '@playwright/test';

/**
 * Shared e2e helpers that drive svelte-grab's REAL activation paths.
 *
 * Activation mechanics (from src/lib):
 *  - Grab:        Alt + Click            (SvelteGrab.handleClick, checks event.altKey)
 *  - StateGrab:   Alt + Meta + Click   (in SvelteDevKit; Alt + Shift + Click standalone)
 *  - StyleGrab:   Alt + Ctrl + Click     (secondaryModifier === 'ctrl')
 *  - A11y (page): Alt + A                (keydown, checkModifier(event,'alt') && key==='a')
 *  - Profiler:    Alt + P                (keydown)
 *  - DevKit help: Alt + ?
 *
 * Each tool delays attaching its listeners by MOUNT_DETECT_DELAY_MS (100ms) and
 * only attaches them once detectDevMode() finds __svelte_meta. `gotoPlayground`
 * waits for the DevKit's "Active!" console log so tests never race that window.
 */

export const test = base.extend<{ activated: Page }>({
	activated: async ({ page }, use) => {
		await gotoPlayground(page);
		await use(page);
	}
});

export { expect };

/**
 * Navigate to the demo app and wait until the dev tools have wired up.
 * `path` may carry query params (e.g. `/?mcp=1&mcpPort=4799`).
 */
export async function gotoPlayground(page: Page, path = '/'): Promise<void> {
	const devKitReady = page
		.waitForEvent('console', {
			predicate: (msg) => msg.text().includes('[SvelteGrab] Active'),
			timeout: 15_000
		})
		.catch(() => undefined);

	await page.goto(path);
	await expect(page.getByTestId('app-root')).toBeVisible();

	await devKitReady;
	// Safety margin over the 100ms mount-detect delay used across all tools.
	await page.waitForTimeout(250);
}

/** Alt+Click a target to grab its component stack (the original tool). */
export async function grab(page: Page, selector: string): Promise<void> {
	await page.locator(selector).click({ modifiers: ['Alt'] });
}

/**
 * Alt+Ctrl+Click a target to open the StyleGrab inspector.
 *
 * StyleGrab listens on the `click` event with secondaryModifier='ctrl'. On macOS
 * a real Ctrl+Click is translated by the OS into a right-click (contextmenu),
 * which would never reach StyleGrab's `click` handler. To drive the genuine
 * code path reliably on every platform we dispatch a synthetic left-click that
 * carries altKey+ctrlKey — it bubbles to StyleGrab's document-level listener
 * exactly like a real modified click.
 */
export async function styleGrab(page: Page, selector: string): Promise<void> {
	await page.locator(selector).evaluate((el) => {
		const r = el.getBoundingClientRect();
		el.dispatchEvent(
			new MouseEvent('click', {
				bubbles: true,
				cancelable: true,
				view: window,
				button: 0,
				altKey: true,
				ctrlKey: true,
				clientX: r.left + 5,
				clientY: r.top + 5
			})
		);
	});
}

/** Hold Alt and press a single key (e.g. 'a', 'p') to fire a keyboard tool. */
export async function altKey(page: Page, key: string): Promise<void> {
	await page.keyboard.down('Alt');
	await page.keyboard.press(key);
	await page.keyboard.up('Alt');
}

/** Read the current system clipboard text from the page context. */
export async function readClipboard(page: Page): Promise<string> {
	return page.evaluate(() => navigator.clipboard.readText());
}

/**
 * Wait until the clipboard is non-empty and (optionally) contains `substring`.
 * Polls because the tools copy asynchronously after the triggering event.
 */
export async function expectClipboardToContain(
	page: Page,
	substring: string,
	timeout = 7_000
): Promise<string> {
	let last = '';
	await expect(async () => {
		last = await readClipboard(page);
		expect(last).toContain(substring);
	}).toPass({ timeout });
	return last;
}
