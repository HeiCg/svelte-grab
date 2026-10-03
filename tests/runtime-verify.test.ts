// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { uiVerify, VERIFY_CHECKS } from '../src/lib/runtime/verify.js';
import { RefRegistry } from '../src/lib/runtime/refs.js';
import { ConsoleCapture } from '../src/lib/runtime/console-capture.js';
import { HmrTracker } from '../src/lib/runtime/hmr.js';
import { dispatchRuntimeCommand, runtimeTools } from '../src/lib/runtime/commands.js';
import { UI_VERIFY_CHECKS } from '../src/mcp/runtime/tools.js';
import { buildFixture, component, h, meta, setBox } from './runtime-helpers.js';

let registry: RefRegistry;
let capture: ConsoleCapture;
let tracker: HmrTracker;
let clock: number;

function verify(args: Record<string, unknown>) {
	return uiVerify(args, { registry, capture, tracker });
}

/** The status line of one check (`PASS visible ...`). */
function line(text: string, check: string): string {
	return text.split('\n').find((l) => new RegExp(`^(PASS|WARN|FAIL) ${check}\\b`).test(l)) ?? '';
}

function checkData(data: Record<string, unknown> | undefined, check: string): Record<string, unknown> {
	return ((data?.checks ?? []) as Record<string, unknown>[]).find((c) => c.check === check)!;
}

function setSize(el: Element, sizes: Partial<Record<'scrollWidth' | 'clientWidth' | 'scrollHeight' | 'clientHeight', number>>) {
	for (const [k, v] of Object.entries(sizes)) Object.defineProperty(el, k, { configurable: true, value: v });
}

/** jsdom has no hit testing: install one that answers `hit` for any point. */
function mockHit(hit: Element | null) {
	(document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = () =>
		hit ? [hit, document.body] : [];
}

beforeEach(() => {
	document.head.innerHTML = '';
	document.body.innerHTML = '';
	registry = new RefRegistry();
	clock = 10_000;
	capture = new ConsoleCapture({ target: null, now: () => clock });
	tracker = new HmrTracker({ hot: null, storage: null, now: () => clock, pluginInfo: () => null, capture: null });
	setSize(document.documentElement, { scrollWidth: 1024, clientWidth: 1024 });
});

afterEach(() => {
	delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
	setSize(document.documentElement, { scrollWidth: 0, clientWidth: 0 });
});

describe('ui_verify', () => {
	it('is registered as a page tool and validates args', async () => {
		expect(Object.keys(runtimeTools)).toContain('ui_verify');
		expect([...UI_VERIFY_CHECKS]).toEqual([...VERIFY_CHECKS]); // server enum matches the page
		expect(() => verify({})).toThrow('ui_verify needs "ref"');
		expect(() => verify({ ref: 'e999' })).toThrow('Unknown ref "e999"');
		const { buttons } = buildFixture();
		const ref = registry.refFor(buttons[0]);
		expect(() => verify({ ref, checks: ['nope'] })).toThrow('Unknown check "nope"');
		expect(() => verify({ ref, checks: 'visible' })).toThrow('"checks" must be an array');
		expect(() => verify({ ref, since: 'today' })).toThrow('"since" must be a number');
		await expect(dispatchRuntimeCommand('ui_verify', {})).resolves.toMatchObject({ ok: false });
	});

	it('runs every check by default: verdict line first, one line per check, structured data', () => {
		const { buttons } = buildFixture();
		setBox(buttons[0], 10, 10, 100, 30);
		mockHit(buttons[0]);
		capture.retain();
		const ref = registry.refFor(buttons[0]);
		const { text, data } = verify({ ref });
		const lines = text.split('\n');
		expect(lines[0]).toBe(`PASS ${ref} button "a" Button src/lib/Button.svelte:2`);
		expect(lines.slice(1).map((l) => l.split(' ').slice(0, 2).join(' '))).toEqual([
			'PASS visible',
			'PASS overflow',
			'PASS console',
			'PASS a11y',
			'PASS contrast'
		]);
		expect(data).toMatchObject({ verdict: 'PASS', ref, locator: `[data-sg-ref="${ref}"]` });
		expect(((data!.checks as unknown[]) ?? []).length).toBe(VERIFY_CHECKS.length);
	});

	it('runs only the requested checks, in the fixed order', () => {
		const { buttons } = buildFixture();
		const ref = registry.refFor(buttons[0]);
		const { text } = verify({ ref, checks: ['contrast', 'a11y', 'contrast'] });
		expect(text.split('\n').slice(1).map((l) => l.split(' ')[1])).toEqual(['a11y', 'contrast']);
	});

	it('resolves a rebound ref like ui_inspect and notes it', () => {
		const { buttons } = buildFixture();
		const oldRef = registry.refFor(buttons[0]);
		const inst = component('Button', '/src/lib/Card.svelte', 7, null);
		const fresh = meta(h('button', {}, 'a'), '/src/lib/Button.svelte', 2, 1, inst);
		buttons[0].replaceWith(fresh);
		const { text, data } = verify({ ref: oldRef, checks: ['a11y'] });
		const newRef = fresh.getAttribute('data-sg-ref');
		expect(newRef).toBeTruthy();
		expect(text.split('\n')[1]).toBe(`# ${oldRef} was stale; rebound to ${newRef}`);
		expect(data).toMatchObject({ rebound: true, previous: oldRef, ref: newRef });
	});

	describe('visible', () => {
		it('FAILs for display:none on an ancestor, naming it', () => {
			const { cards, buttons } = buildFixture();
			cards[0].style.display = 'none';
			const ref = registry.refFor(buttons[0]);
			const l = line(verify({ ref, checks: ['visible'] }).text, 'visible');
			expect(l).toMatch(/^FAIL visible hidden: display: none on ancestor e\d+ div\.card Card src\/lib\/Card\.svelte:5$/);
		});

		it('FAILs for visibility hidden, opacity 0 and a zero-size box', () => {
			const { buttons } = buildFixture();
			const ref = registry.refFor(buttons[0]);
			buttons[0].style.visibility = 'hidden';
			expect(line(verify({ ref, checks: ['visible'] }).text, 'visible')).toBe('FAIL visible hidden: visibility: hidden');
			buttons[0].style.visibility = '';
			buttons[0].style.opacity = '0';
			expect(line(verify({ ref, checks: ['visible'] }).text, 'visible')).toBe('FAIL visible invisible: opacity: 0');
			buttons[0].style.opacity = '';
			expect(line(verify({ ref, checks: ['visible'] }).text, 'visible')).toBe('FAIL visible zero-size box (0x0)');
		});

		it('WARNs when off-screen', () => {
			const { buttons } = buildFixture();
			setBox(buttons[0], 10, 3000, 100, 30);
			const ref = registry.refFor(buttons[0]);
			const out = verify({ ref, checks: ['visible'] });
			expect(line(out.text, 'visible')).toMatch(/^WARN visible off-screen: box 10,3000 100x30 is outside the \d+x\d+ viewport/);
			expect(checkData(out.data, 'visible')).toMatchObject({ status: 'WARN', reason: 'off-screen' });
		});

		it('WARNs when another element covers its center, naming the coverer with component and source', () => {
			const { main, buttons } = buildFixture();
			setBox(buttons[0], 10, 10, 100, 30);
			const modalInst = component('Modal', '/src/App.svelte', 9);
			const overlay = meta(h('div', { class: 'backdrop svelte-x1y2z3' }), '/src/lib/Modal.svelte', 3, 1, modalInst);
			main.append(overlay);
			mockHit(overlay);
			const ref = registry.refFor(buttons[0]);
			const out = verify({ ref, checks: ['visible'] });
			const l = line(out.text, 'visible');
			expect(l).toMatch(/^WARN visible covered at its center \(60,25\) by e\d+ div\.backdrop Modal src\/lib\/Modal\.svelte:3$/);
			expect(checkData(out.data, 'visible')).toMatchObject({
				covered: true,
				coveredBy: { tag: 'div.backdrop', component: 'Modal', source: 'src/lib/Modal.svelte:3' }
			});
			expect(out.text.split('\n')[0]).toMatch(/^WARN /);
		});

		it('PASSes when the hit is a descendant, ignores svelte-grab overlays', () => {
			const { buttons } = buildFixture();
			const span = h('span', {}, 'inner');
			buttons[0].append(span);
			setBox(buttons[0], 10, 10, 100, 30);
			const ref = registry.refFor(buttons[0]);
			mockHit(span);
			expect(line(verify({ ref, checks: ['visible'] }).text, 'visible')).toBe('PASS visible box 10,10 100x30, in viewport, not covered');

			const ours = h('div', { 'data-svelte-grab-ui': '' });
			document.body.append(ours);
			(document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [ours, buttons[0]];
			expect(line(verify({ ref, checks: ['visible'] }).text, 'visible')).toBe('PASS visible box 10,10 100x30, in viewport, not covered');
		});

		it('says so when hit testing is unavailable', () => {
			const { buttons } = buildFixture();
			setBox(buttons[0], 10, 10, 100, 30);
			const ref = registry.refFor(buttons[0]);
			const l = line(verify({ ref, checks: ['visible'] }).text, 'visible');
			expect(l.startsWith('PASS visible')).toBe(true);
		});
	});

	describe('overflow', () => {
		it('FAILs when text content is clipped', () => {
			const { cards } = buildFixture();
			cards[0].style.overflow = 'hidden';
			setSize(cards[0], { scrollWidth: 400, clientWidth: 200, scrollHeight: 50, clientHeight: 50 });
			const ref = registry.refFor(cards[0]);
			const out = verify({ ref, checks: ['overflow'] });
			expect(line(out.text, 'overflow')).toBe(
				'FAIL overflow content is clipped (text cut off): scrollWidth 400 > clientWidth 200, overflow-x: hidden'
			);
			expect(checkData(out.data, 'overflow')).toMatchObject({ clipped: true });
		});

		it('WARNs when children spill out of the box, naming them', () => {
			const { cards } = buildFixture();
			setBox(cards[0], 0, 0, 200, 100);
			setSize(cards[0], { scrollWidth: 320, clientWidth: 200, scrollHeight: 100, clientHeight: 100 });
			const p = cards[0].querySelector('p')!;
			setBox(p, 0, 0, 320, 20);
			setBox(cards[0].querySelector('button')!, 0, 30, 100, 20);
			const ref = registry.refFor(cards[0]);
			const { text } = verify({ ref, checks: ['overflow'] });
			const lines = text.split('\n');
			expect(line(text, 'overflow')).toBe(
				"WARN overflow content spills out of the element's box: scrollWidth 320 > clientWidth 200, overflow-x: visible"
			);
			const i = lines.indexOf(line(text, 'overflow'));
			expect(lines[i + 1]).toMatch(/^ {2}e\d+ p Card src\/lib\/Card\.svelte:6 sticks out by 120px$/);
		});

		it('PASSes for scrollable content', () => {
			const { cards } = buildFixture();
			cards[0].style.overflowY = 'auto';
			setSize(cards[0], { scrollWidth: 200, clientWidth: 200, scrollHeight: 900, clientHeight: 100 });
			const ref = registry.refFor(cards[0]);
			expect(line(verify({ ref, checks: ['overflow'] }).text, 'overflow')).toMatch(
				/^PASS overflow content scrolls inside the element .*; no page-level horizontal overflow$/
			);
		});

		it('FAILs on page-level horizontal overflow, naming the widest offenders (outermost, top 3)', () => {
			const { main, buttons } = buildFixture();
			setBox(buttons[0], 10, 10, 100, 30);
			const stripInst = component('Strip', '/src/App.svelte', 12);
			const strip = meta(h('div', { class: 'strip svelte-q1w2e3' }), '/src/lib/Strip.svelte', 4, 1, stripInst);
			const inner = meta(h('span', {}, 'wide'), '/src/lib/Strip.svelte', 5, 3, stripInst);
			strip.append(inner);
			setBox(strip, 0, 200, 2400, 40);
			setBox(inner, 0, 200, 2400, 40); // same subtree: not listed twice
			// Wide but inside a horizontal scroller: does not widen the page.
			const scroller = h('div', { style: 'overflow-x: auto' });
			const table = meta(h('table'), '/src/lib/Table.svelte', 1, 1, component('Table', '/src/App.svelte', 14));
			scroller.append(table);
			setBox(table, 0, 300, 5000, 40);
			const tooWide = meta(h('p', {}, 'x'), '/src/App.svelte', 20, 3, null);
			setBox(tooWide, 0, 400, 1100, 20);
			main.append(strip, scroller, tooWide);
			setSize(document.documentElement, { scrollWidth: 2400, clientWidth: 1024 });

			const ref = registry.refFor(buttons[0]);
			const out = verify({ ref, checks: ['overflow'] });
			const lines = out.text.split('\n');
			expect(lines[0]).toMatch(/^FAIL /);
			const l = line(out.text, 'overflow');
			expect(l).toBe('FAIL overflow page scrolls horizontally: document scrollWidth 2400 > clientWidth 1024');
			const i = lines.indexOf(l);
			expect(lines[i + 1]).toMatch(
				/^ {2}e\d+ div\.strip Strip src\/lib\/Strip\.svelte:4 extends 1376px past the page edge \(right edge at 2400px\)$/
			);
			expect(lines[i + 2]).toMatch(/^ {2}e\d+ p App src\/App\.svelte:20 extends 76px past the page edge/);
			expect(out.text).not.toContain('Table');
			const page = checkData(out.data, 'overflow').page as { offenders: { ref: string }[] };
			expect(page.offenders).toHaveLength(2);
			expect(strip.getAttribute('data-sg-ref')).toBe(page.offenders[0].ref);

			// Fixed: the page fits again.
			strip.remove();
			tooWide.remove();
			setSize(document.documentElement, { scrollWidth: 1024, clientWidth: 1024 });
			expect(line(verify({ ref, checks: ['overflow'] }).text, 'overflow')).toMatch(/^PASS overflow .*no page-level horizontal overflow$/);
		});
	});

	describe('console', () => {
		beforeEach(() => buildFixture());
		const ref = () => registry.refFor(document.querySelector('button')!);

		it('FAILs on errors, WARNs on warnings, lists the top 5 with source (grouped)', () => {
			clock = 1_000;
			capture.retain();
			clock = 2_000;
			capture.record({ level: 'warn', origin: 'console', message: 'deprecated prop', source: { file: 'src/lib/Card.svelte', line: 3, column: 1 } });
			capture.record({ level: 'error', origin: 'console', message: 'TypeError: x is undefined', source: { file: 'src/lib/Button.svelte', line: 9, column: 5 } });
			capture.record({ level: 'error', origin: 'console', message: 'TypeError: x is undefined', source: { file: 'src/lib/Button.svelte', line: 9, column: 5 } });
			for (let i = 0; i < 5; i++) capture.record({ level: 'warn', origin: 'console', message: `w${i}`, source: null });
			const { text, data } = verify({ ref: ref(), checks: ['console'] });
			const lines = text.split('\n');
			expect(lines[1]).toBe(
				`FAIL console 2 errors, 6 warnings since the runtime started (${new Date(1_000).toISOString()})`
			);
			expect(lines[2]).toBe('  error src/lib/Button.svelte:9:5 TypeError: x is undefined (x2)');
			expect(lines[3]).toBe('  warn src/lib/Card.svelte:3:1 deprecated prop');
			expect(lines[4]).toBe('  warn (unknown source) w0');
			expect(lines[7]).toBe('  … 2 more distinct messages');
			expect(checkData(data, 'console')).toMatchObject({ errors: 2, warnings: 6, since: 1_000 });
		});

		it('counts from the start of the last HMR update', () => {
			capture.retain();
			clock = 2_000;
			capture.record({ level: 'error', origin: 'console', message: 'old error', source: null });
			clock = 3_000;
			tracker.ingest('vite:beforeUpdate', { updates: [{ path: '/src/lib/Card.svelte' }] }, 'vite-hmr');
			clock = 3_010;
			capture.record({ level: 'warn', origin: 'console', message: 'during update', source: null });
			clock = 3_050;
			tracker.ingest('vite:afterUpdate', { updates: [{ path: '/src/lib/Card.svelte' }] }, 'vite-hmr');
			const l = line(verify({ ref: ref(), checks: ['console'] }).text, 'console');
			expect(l).toBe(`WARN console 0 errors, 1 warning since the last HMR update (${new Date(3_000).toISOString()})`);
		});

		it('honors an explicit since', () => {
			capture.retain();
			clock = 2_000;
			capture.record({ level: 'error', origin: 'console', message: 'old', source: null });
			clock = 4_000;
			const l = line(verify({ ref: ref(), checks: ['console'], since: 3_000 }).text, 'console');
			expect(l).toBe(`PASS console no errors or warnings since ${new Date(3_000).toISOString()}`);
			expect(line(verify({ ref: ref(), checks: ['console'], since: 1_000 }).text, 'console')).toMatch(/^FAIL console 1 error, 0 warnings since/);
		});

		it('WARNs when the capture is not running', () => {
			const l = line(verify({ ref: ref(), checks: ['console'] }).text, 'console');
			expect(l).toBe('WARN console console capture is not running (the agent runtime is not connected), so errors are unknown');
		});
	});

	describe('a11y + contrast', () => {
		it('a11y FAILs for a button without an accessible name', () => {
			const inst = component('Icon', '/src/App.svelte', 3);
			const btn = meta(h('button'), '/src/lib/Icon.svelte', 1, 1, inst);
			document.body.append(btn);
			const ref = registry.refFor(btn);
			const { text } = verify({ ref, checks: ['a11y'] });
			expect(line(text, 'a11y')).toMatch(/^FAIL a11y 1 issue: button-label$/);
			expect(text).toMatch(/\n {2}\[critical\] button-label: /);
		});

		it('contrast: WARN below AA, FAIL below 3:1, PASS otherwise; a11y does not repeat contrast issues', () => {
			const p = meta(h('p', { style: 'color: rgb(119, 119, 119); background-color: rgb(255, 255, 255)' }, 'Muted'), '/src/App.svelte', 2, 1, null);
			document.body.append(p);
			const ref = registry.refFor(p);
			const out = verify({ ref, checks: ['a11y', 'contrast'] });
			expect(line(out.text, 'contrast')).toBe('WARN contrast 4.48:1 (needs 4.5:1)');
			expect(line(out.text, 'a11y')).toMatch(/^PASS a11y/);
			// a11y alone still reports it
			expect(line(verify({ ref, checks: ['a11y'] }).text, 'a11y')).toMatch(/^WARN a11y 1 issue: contrast$/);

			p.style.color = 'rgb(200, 200, 200)';
			expect(line(verify({ ref, checks: ['contrast'] }).text, 'contrast')).toMatch(/^FAIL contrast 1\.67:1 \(needs 4\.5:1\)$/);
			p.style.color = 'rgb(0, 0, 0)';
			expect(line(verify({ ref, checks: ['contrast'] }).text, 'contrast')).toBe('PASS contrast 21:1 (needs 4.5:1)');
		});

		it('contrast checks text descendants and names the worst one', () => {
			const { cards } = buildFixture();
			const p = cards[0].querySelector('p')!;
			p.style.color = 'rgb(220, 220, 220)';
			const ref = registry.refFor(cards[0]);
			const { text } = verify({ ref, checks: ['contrast'] });
			expect(line(text, 'contrast')).toMatch(/^FAIL contrast 1\.\d+:1 \(needs 4\.5:1\) on e\d+ p Card src\/lib\/Card\.svelte:6$/);
		});
	});
});
