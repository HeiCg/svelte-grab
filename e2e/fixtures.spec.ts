import { test, expect, gotoPlayground } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Agent-runtime fixtures (examples/playground/src/components/fixtures/).
 *
 * Each fixture covers a Svelte 5 construct the `ui_*` tools must read through
 * `__svelte_meta`: nested components, control-flow blocks, snippets, an async
 * `<svelte:boundary>`, transitions and forms. These tests only pin that the
 * fixtures render and carry dev metadata; tool behaviour is tested elsewhere.
 */

interface MetaSummary {
	file: string | null;
	line: number | null;
	/** `componentTag` of every `type: 'component'` entry in the parent chain, nearest first. */
	componentTags: string[];
	/** `type` of every parent entry, nearest first. */
	parentTypes: string[];
}

/** Read a summary of `__svelte_meta` from the element matching `testid`. */
async function readMeta(page: Page, testid: string): Promise<MetaSummary | null> {
	return page.getByTestId(testid).evaluate((el) => {
		type Entry = { type?: string; componentTag?: string; parent?: Entry | null };
		const meta = (
			el as HTMLElement & {
				__svelte_meta?: { loc?: { file?: string; line?: number }; parent?: Entry | null };
			}
		).__svelte_meta;
		if (!meta) return null;
		const componentTags: string[] = [];
		const parentTypes: string[] = [];
		let entry = meta.parent ?? null;
		for (let i = 0; entry && i < 100; i++) {
			parentTypes.push(String(entry.type));
			if (entry.type === 'component' && entry.componentTag) componentTags.push(entry.componentTag);
			entry = entry.parent ?? null;
		}
		return {
			file: meta.loc?.file ?? null,
			line: meta.loc?.line ?? null,
			componentTags,
			parentTypes
		};
	});
}

async function expectMetaFile(page: Page, testid: string, file: string): Promise<MetaSummary> {
	const meta = await readMeta(page, testid);
	expect(meta, `${testid} should carry __svelte_meta`).not.toBeNull();
	expect(meta!.file).toContain(file);
	expect(typeof meta!.line).toBe('number');
	return meta!;
}

test.describe('Agent-runtime fixtures', () => {
	test.beforeEach(async ({ page }) => {
		await gotoPlayground(page);
	});

	test('fixtures section is labelled and keeps the original fixtures', async ({ page }) => {
		await expect(page.getByTestId('fixtures-title')).toHaveText('Agent-runtime fixtures');
		// Reusing Button must not duplicate the original test id.
		await expect(page.getByTestId('demo-button')).toHaveCount(1);
	});

	test('nested chain: Section > FixtureCard > Button, Button reused', async ({ page }) => {
		await expect(page.getByTestId('fx-nested')).toBeVisible();
		await expect(page.getByTestId('fx-button-a')).toHaveText('a: 0');
		await expect(page.getByTestId('fx-button-b')).toHaveText('b: 0');

		await page.getByTestId('fx-button-b').click();
		await expect(page.getByTestId('fx-button-b')).toHaveText('b: 1');
		await expect(page.getByTestId('fx-button-a')).toHaveText('a: 0');

		const meta = await expectMetaFile(page, 'fx-button-a', 'src/components/Button.svelte');
		// Nearest-first component chain, 3 levels deep under App.
		expect(meta.componentTags.slice(0, 3)).toEqual(['Button', 'FixtureCard', 'Section']);
	});

	test('control flow: {#if}/{:else if}/{:else} and keyed {#each}', async ({ page }) => {
		await expect(page.getByTestId('fx-branch-else-if')).toBeVisible();
		const branchMeta = await expectMetaFile(
			page,
			'fx-branch-else-if',
			'src/components/fixtures/ControlFlow.svelte'
		);
		expect(branchMeta.parentTypes[0]).toBe('if');

		await page.getByTestId('fx-mode-empty').click();
		await expect(page.getByTestId('fx-branch-if')).toBeVisible();
		await expect(page.getByTestId('fx-branch-else-if')).toHaveCount(0);

		await page.getByTestId('fx-mode-many').click();
		await expect(page.getByTestId('fx-branch-else')).toBeVisible();

		const list = page.getByTestId('fx-each-list').locator('li');
		await expect(list).toHaveText(['Alpha', 'Beta', 'Gamma']);
		const itemMeta = await expectMetaFile(
			page,
			'fx-each-item-2',
			'src/components/fixtures/ControlFlow.svelte'
		);
		expect(itemMeta.parentTypes[0]).toBe('each');

		await page.getByTestId('fx-each-reverse').click();
		await expect(list).toHaveText(['Gamma', 'Beta', 'Alpha']);
		await page.getByTestId('fx-each-add').click();
		await page.getByTestId('fx-each-remove').click();
		await expect(list).toHaveText(['Beta', 'Alpha', 'Item 4']);
	});

	test('snippet declared in parent renders inside the child', async ({ page }) => {
		await expect(page.getByTestId('fx-snippet-list').locator('li')).toHaveCount(3);
		await expect(page.getByTestId('fx-snippet-row-1')).toContainText('inspect');

		// The row element is authored in SnippetHost (where the snippet lives)
		// even though SnippetList renders it.
		const meta = await expectMetaFile(
			page,
			'fx-snippet-row-0',
			'src/components/fixtures/SnippetHost.svelte'
		);
		expect(meta.componentTags).toContain('SnippetList');
	});

	test('async component resolves inside <svelte:boundary>', async ({ page }) => {
		await expect(page.getByTestId('fx-async-title')).toHaveText('Loaded 3 regions');
		await expect(page.getByTestId('fx-async-pending')).toHaveCount(0);
		await expect(page.getByTestId('fx-async-item-south')).toBeVisible();

		const meta = await expectMetaFile(
			page,
			'fx-async-item-south',
			'src/components/fixtures/AsyncFixture.svelte'
		);
		expect(meta.componentTags).toContain('AsyncFixture');
	});

	test('transition:fade element toggles out and back in', async ({ page }) => {
		await expect(page.getByTestId('fx-fade-box')).toBeVisible();
		await expectMetaFile(page, 'fx-fade-box', 'src/components/fixtures/FadeToggle.svelte');

		await page.getByTestId('fx-fade-toggle').click();
		await expect(page.getByTestId('fx-fade-box')).toHaveCount(0);
		await page.getByTestId('fx-fade-toggle').click();
		await expect(page.getByTestId('fx-fade-box')).toBeVisible();
	});

	test('form with several control types submits', async ({ page }) => {
		await expectMetaFile(page, 'fx-form-email', 'src/components/fixtures/FixtureForm.svelte');

		await page.getByTestId('fx-form-email').fill('dev@example.com');
		await page.getByTestId('fx-form-plan').selectOption('pro');
		await page.getByTestId('fx-form-agree').check();
		await page.getByTestId('fx-form-notes').fill('hello');
		await page.getByTestId('fx-form-submit').click();

		await expect(page.getByTestId('fx-form-result')).toHaveText(
			'Sent: dev@example.com / pro / agreed'
		);
	});
});

test.describe('Async boundary pending state', () => {
	test('shows the pending snippet until the await resolves', async ({ page }) => {
		// Freeze timers so the ~300ms await stays pending deterministically.
		await page.clock.install();
		await page.goto('/');

		await expect(page.getByTestId('fx-async-pending')).toBeVisible();
		await expect(page.getByTestId('fx-async-content')).toHaveCount(0);
		await expectMetaFile(page, 'fx-async-pending', 'src/App.svelte');

		await page.clock.runFor(400);

		await expect(page.getByTestId('fx-async-content')).toBeVisible();
		await expect(page.getByTestId('fx-async-pending')).toHaveCount(0);
		await expectMetaFile(page, 'fx-async-title', 'src/components/fixtures/AsyncFixture.svelte');
	});
});
