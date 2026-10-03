import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * In-page agent runtime (src/lib/runtime/) against the real playground.
 *
 * No MCP server: the tool handlers are loaded straight from Vite's dev server
 * (`/@fs/<abs path>`, the same module URL the library itself uses) and called
 * in the page, exactly as the SSE `runtime-command` handler would call them.
 */

const fsUrl = (rel: string) => '/@fs' + fileURLToPath(new URL(rel, import.meta.url));
const COMMANDS_URL = fsUrl('../src/lib/runtime/commands.ts');
const REFS_URL = fsUrl('../src/lib/runtime/refs.ts');

interface Outcome {
	ok: boolean;
	error?: string;
	result?: { text: string; data?: Record<string, unknown> };
}

interface Match {
	ref: string;
	stableKey: string;
	component: string | null;
	source: string | null;
	role: string | null;
	name: string;
	visible: boolean;
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

async function find(page: Page, args: Record<string, unknown>): Promise<Match[]> {
	const out = await callTool(page, 'ui_find', args);
	expect(out.ok, out.error).toBe(true);
	return (out.result!.data as { matches: Match[] }).matches;
}

interface Resolved {
	ref: string;
	stableKey: string;
	rebound: boolean;
	previous: string | null;
	testid: string | null;
	text: string;
}

async function resolve(page: Page, refOrKey: string): Promise<Resolved | null> {
	return page.evaluate(
		async ([url, q]) => {
			const mod = await import(/* @vite-ignore */ url);
			const r = mod.refRegistry.resolve(q);
			if (!r) return null;
			return {
				ref: r.ref,
				stableKey: r.stableKey,
				rebound: r.rebound === true,
				previous: r.previous ?? null,
				testid: r.element.getAttribute('data-testid'),
				text: (r.element.textContent ?? '').trim()
			};
		},
		[REFS_URL, refOrKey] as const
	);
}

test.describe('agent runtime: ui_snapshot / ui_find / ui_inspect', () => {
	test('ui_snapshot lists FixtureCard and Button with playground source files', async ({
		activated: page
	}) => {
		const out = await callTool(page, 'ui_snapshot', { scope: 'page', maxNodes: 500 });
		expect(out.ok, out.error).toBe(true);
		const text = out.result!.text;

		expect(text).toMatch(
			/^\s*e\d+ div FixtureCard src\/components\/fixtures\/FixtureCard\.svelte:\d+$/m
		);
		expect(text).toMatch(/^\s*e\d+ button "a: 0" Button src\/components\/Button\.svelte:\d+$/m);
		expect(text).toMatch(
			/^\s*e\d+ heading "Nested chain" Section src\/components\/fixtures\/Section\.svelte:\d+$/m
		);
		// svelte-grab's own overlay never shows up.
		expect(text).not.toMatch(/src\/lib\/(SvelteGrab|SvelteDevKit|ui\/)/);

		// The Button line is indented below its FixtureCard line.
		const lines = text.split('\n');
		const cardIdx = lines.findIndex((l) => l.includes('FixtureCard.svelte'));
		const buttonLine = lines.slice(cardIdx).find((l) => l.includes('"a: 0"'))!;
		const indent = (l: string) => l.length - l.trimStart().length;
		expect(indent(buttonLine)).toBeGreaterThan(indent(lines[cardIdx]));

		const nodes = (
			out.result!.data as { nodes: { ref: string; component: string; file: string }[] }
		).nodes;
		const btn = nodes.find((n) => n.component === 'Button' && n.file.endsWith('Button.svelte'));
		expect(btn).toBeTruthy();
		await expect(page.locator(`[data-sg-ref="${btn!.ref}"]`)).toHaveCount(1);
	});

	test('default viewport snapshot is bounded and scoped snapshots work', async ({
		activated: page
	}) => {
		const out = await callTool(page, 'ui_snapshot', {});
		expect(out.ok, out.error).toBe(true);
		expect(out.result!.text).toContain('svelte-grab playground');

		const [card] = await find(page, { component: 'FixtureCard' });
		const scoped = await callTool(page, 'ui_snapshot', { scope: card.ref, detail: 'normal' });
		expect(scoped.ok, scoped.error).toBe(true);
		const lines = scoped.result!.text.split('\n');
		expect(lines[0]).toMatch(
			new RegExp(`^${card.ref} div FixtureCard .* box=\\d+,\\d+ \\d+x\\d+ \\.fx-card$`)
		);
		expect(lines.some((l) => /^ {2}e\d+ button "a: 0" Button/.test(l))).toBe(true);
	});

	test('ui_find({component:"FixtureCard"}) returns both instances with working locators', async ({
		activated: page
	}) => {
		const matches = await find(page, { component: 'FixtureCard' });
		expect(matches).toHaveLength(2);
		for (const m of matches) {
			expect(m.component).toBe('FixtureCard');
			expect(m.source).toMatch(/src\/components\/fixtures\/FixtureCard\.svelte:\d+$/);
			expect(m.stableKey).toMatch(
				/^ui:\/\/.*FixtureCard\.svelte:\d+:\d+#FixtureCard\[role=,name=\]\[[01]\]$/
			);
			expect(m.visible).toBe(true);
		}
		await expect(page.locator(`[data-sg-ref="${matches[0].ref}"]`)).toHaveAttribute(
			'data-testid',
			'fx-card-a'
		);
		await expect(page.locator(`[data-sg-ref="${matches[1].ref}"]`)).toHaveAttribute(
			'data-testid',
			'fx-card-b'
		);

		// Act through Playwright on the ref locator, then find the new state.
		await page.locator(`[data-sg-ref="${matches[1].ref}"] button`).click();
		const [clicked] = await find(page, { role: 'button', name: 'b: 1' });
		expect(clicked.component).toBe('Button');
	});

	test('refs survive {#each} reverse/remove and stable keys re-resolve', async ({
		activated: page
	}) => {
		const [beta] = await find(page, { text: 'Beta', selector: '[data-testid="fx-each-list"] li' });
		const [gamma] = await find(page, {
			text: 'Gamma',
			selector: '[data-testid="fx-each-list"] li'
		});
		expect(beta.stableKey).toMatch(
			/ControlFlow\.svelte:\d+:\d+#ControlFlow\[role=listitem,name=Beta\]\[0\]$/
		);

		await page.getByTestId('fx-each-reverse').click();
		await page.getByTestId('fx-each-remove').click(); // removes Gamma (first after reverse)
		await expect(page.getByTestId('fx-each-item-3')).toHaveCount(0);

		const byRef = await resolve(page, beta.ref);
		expect(byRef).toMatchObject({ ref: beta.ref, rebound: false, testid: 'fx-each-item-2' });
		const byKey = await resolve(page, beta.stableKey);
		expect(byKey).toMatchObject({ ref: beta.ref, testid: 'fx-each-item-2' });
		await expect(page.locator(`[data-sg-ref="${beta.ref}"]`)).toHaveText('Beta');

		// A removed row does not silently rebind to another row.
		expect(await resolve(page, gamma.ref)).toBeNull();
	});

	test('a re-rendered element rebinds by stable key', async ({ activated: page }) => {
		const [branch] = await find(page, { selector: '[data-testid="fx-branch-else-if"]' });

		await page.getByTestId('fx-mode-many').click();
		await expect(page.getByTestId('fx-branch-else-if')).toHaveCount(0);
		await page.getByTestId('fx-mode-few').click();
		await expect(page.getByTestId('fx-branch-else-if')).toBeVisible();

		const res = await resolve(page, branch.ref);
		expect(res).toMatchObject({ rebound: true, previous: branch.ref, testid: 'fx-branch-else-if' });
		expect(res!.ref).not.toBe(branch.ref);
		expect(res!.stableKey).toBe(branch.stableKey);
		await expect(page.locator(`[data-sg-ref="${res!.ref}"]`)).toHaveText('Branch: else if (few)');
	});

	test('ui_inspect on a FixtureCard Button ref returns source, stack and layout', async ({
		activated: page
	}) => {
		const [button] = await find(page, { role: 'button', name: 'a: 0' });
		expect(button.component).toBe('Button');

		const out = await callTool(page, 'ui_inspect', { ref: button.ref });
		expect(out.ok, out.error).toBe(true);
		const text = out.result!.text;

		const lines = text.split('\n');
		expect(lines[0]).toMatch(
			new RegExp(`^${button.ref} button "a: 0" Button src/components/Button\\.svelte:\\d+$`)
		);
		expect(lines).toContain(`Locator: [data-sg-ref="${button.ref}"]`);

		const sectionOf = (title: string) => {
			const start = lines.indexOf(title);
			expect(start, `${title} section`).toBeGreaterThan(-1);
			const body: string[] = [];
			for (const l of lines.slice(start + 1)) {
				if (!l.startsWith('  ')) break;
				body.push(l);
			}
			return body.join('\n');
		};

		expect(sectionOf('SOURCE')).toMatch(/src\/components\/Button\.svelte:\d+:\d+/);
		expect(sectionOf('COMPONENT')).toMatch(
			/this instance is used at src\/components\/fixtures\/FixtureCard\.svelte:\d+/
		);
		const stack = sectionOf('STACK');
		expect(stack).toMatch(/FixtureCard \(src\/App\.svelte:\d+\)/);
		expect(stack).toMatch(/Section \(src\/App\.svelte:\d+\)/);
		expect(sectionOf('LAYOUT')).toMatch(/box: \d+,\d+ [1-9]\d*x[1-9]\d* \(viewport px/);
		expect(sectionOf('STYLES')).toMatch(/background-color: rgb\(37, 99, 235\) -> Svelte scoped/);
		expect(sectionOf('A11Y')).toMatch(/role: button, name: "a: 0"/);
		expect(sectionOf('USAGE')).toMatch(/instances of <Button> on the page/);
		expect(sectionOf('USAGE')).toContain(`${button.ref} (this)`);
		expect(text.length).toBeLessThanOrEqual(8000);

		const data = out.result!.data as {
			source: { file: string };
			layout: { visible: boolean; box: { width: number } };
			usage: { count: number };
		};
		expect(data.source.file).toMatch(/Button\.svelte$/);
		expect(data.layout.visible).toBe(true);
		expect(data.layout.box.width).toBeGreaterThan(0);
		expect(data.usage.count).toBeGreaterThanOrEqual(2);
	});

	test('unknown tools and bad args come back as ok:false', async ({ activated: page }) => {
		expect(await callTool(page, 'ui_nope', {})).toEqual({ ok: false, error: 'Unknown tool' });
		const bad = await callTool(page, 'ui_snapshot', { scope: 'e999999' });
		expect(bad.ok).toBe(false);
		expect(bad.error).toMatch(/Unknown scope/);
	});
});
