// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	actionOffsets,
	formatSeconds,
	performAction,
	uiProfile,
	type LongFrameWatch,
	type ProfileComponent,
	type ProfileOptions
} from '../src/lib/runtime/profile.js';
import { RefRegistry } from '../src/lib/runtime/refs.js';
import { runtimeTools } from '../src/lib/runtime/commands.js';
import { ProfilerTracker } from '../src/lib/utils/profiler-tracker.js';
import type { FpsMeter } from '../src/lib/utils/fps-meter.js';
import { buildFixture, component, h, meta } from './runtime-helpers.js';

let registry: RefRegistry;

beforeEach(() => {
	document.body.innerHTML = '';
	registry = new RefRegistry();
});

afterEach(() => {
	vi.useRealTimers();
});

/** One macrotask: lets jsdom deliver the pending MutationObserver batch. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Set a text node's data `times` times, one MutationObserver batch each. */
async function hammerText(el: Element, times: number): Promise<void> {
	if (!el.firstChild) el.append('');
	for (let i = 0; i < times; i++) {
		(el.firstChild as Text).data = `v${i}`;
		await tick();
	}
}

function fakeFps(samples: number[], frames: number): ProfileOptions['fpsMeter'] {
	return (onSample) => {
		for (const s of samples) onSample(s);
		const meter: FpsMeter = { current: 60, rolling: 60, frames, stop: () => {} };
		return meter;
	};
}

const loaf =
	(count: number, worstMs: number): (() => LongFrameWatch) =>
	() => ({
		type: 'long-animation-frame',
		stop: () => ({ count, worstMs })
	});

/** Options with a sleep that runs `during` instead of waiting. */
function opts(during: () => Promise<void> | void, extra: ProfileOptions = {}): ProfileOptions {
	return {
		registry,
		sleep: async () => {
			await during();
		},
		fpsMeter: fakeFps([58, 61], 180),
		longFrames: loaf(0, 0),
		...extra
	};
}

function comps(data: Record<string, unknown> | undefined): ProfileComponent[] {
	return (data as { components: ProfileComponent[] }).components;
}

describe('ui_profile: registration and args', () => {
	it('is a page tool', () => {
		expect(Object.keys(runtimeTools)).toContain('ui_profile');
	});

	it('rejects bad args with actionable messages', async () => {
		const { buttons } = buildFixture();
		const ref = registry.refFor(buttons[0]);
		const o = opts(() => {});
		await expect(uiProfile({ durationMs: 'x' }, o)).rejects.toThrow(
			'"durationMs" must be a number'
		);
		await expect(uiProfile({ action: 'click' }, o)).rejects.toThrow('"action" must be an object');
		await expect(uiProfile({ action: { type: 'click' } }, o)).rejects.toThrow(
			'"action.ref" is required'
		);
		await expect(uiProfile({ action: { ref, type: 'hover' } }, o)).rejects.toThrow(
			'"action.type" must be one of click, input, scroll'
		);
		await expect(uiProfile({ action: { ref, type: 'input' } }, o)).rejects.toThrow(
			'"action.value" is required for an input'
		);
		await expect(uiProfile({ action: { ref, type: 'scroll', value: 'down' } }, o)).rejects.toThrow(
			'"dy" or "dx,dy"'
		);
		await expect(uiProfile({ action: { ref: 'e404', type: 'click' } }, o)).rejects.toThrow(
			'Unknown action ref "e404"'
		);
		await expect(uiProfile({ ref: 'e404' }, o)).rejects.toThrow('Unknown ref "e404"');
		await expect(uiProfile({ ref, component: 'Card' }, o)).rejects.toThrow(
			'either "component" or "ref"'
		);
	});
});

describe('ui_profile: aggregation and verdict', () => {
	it('reports HOT for a component above the burst threshold, with kinds, rates, top elements, FPS and long frames', async () => {
		const { buttons, cards } = buildFixture();
		const p = cards[0].querySelector('p')!;
		const out = await uiProfile(
			{ durationMs: 3000 },
			opts(
				async () => {
					await hammerText(buttons[0], 25);
					p.setAttribute('title', 'once');
					await tick();
				},
				{ longFrames: loaf(2, 120) }
			)
		);
		const lines = out.text.split('\n');
		expect(lines[0]).toBe('HOT Button 25 mutations in 3s (burst x1)');
		expect(lines[1]).toBe('ui_profile 3s, scope: page');
		expect(lines[2]).toBe('COMPONENTS by mutations (2 of 2):');
		expect(lines[3]).toBe(
			'  Button 25 mutations, 8.3/s, 1 burst, 25 batches [characterData 25] src/lib/Button.svelte'
		);
		expect(lines[4]).toMatch(/^ {4}top: e\d+ button src\/lib\/Button\.svelte:2 x25$/);
		expect(lines[5]).toBe(
			'  Card 1 mutation, 0.3/s, 0 bursts, 1 batch [attributes 1] src/lib/Card.svelte'
		);
		expect(out.text).toContain('\nFPS avg 60, min 58 (2 whole-second samples)\n');
		expect(out.text).toContain('\nLONG FRAMES 2, worst 120ms (long-animation-frame, > 50ms)\n');
		expect(out.text).toContain('Svelte 5 has no component re-renders');

		// The top element ref is stamped and points at the hot button.
		const topRef = lines[4].trim().split(' ')[1];
		expect(buttons[0].getAttribute('data-sg-ref')).toBe(topRef);

		const data = out.data!;
		expect(data.verdict).toBe('HOT');
		expect(data.hot).toEqual(['Button']);
		expect(data.totalMutations).toBe(26);
		expect(data.burst).toEqual({ threshold: 20, windowMs: 1000 });
		expect(data.fps).toEqual({ avg: 60, min: 58, samples: 2 });
		expect(data.longFrames).toEqual({ type: 'long-animation-frame', count: 2, worstMs: 120 });
		const [button, card] = comps(data);
		expect(button).toMatchObject({
			name: 'Button',
			file: '/src/lib/Button.svelte',
			mutations: 25,
			batches: 25,
			bursts: 1,
			hot: true,
			kinds: { childList: 0, attributes: 0, characterData: 25 },
			topElements: [{ ref: topRef, tag: 'button', source: 'src/lib/Button.svelte:2', count: 25 }]
		});
		expect(card).toMatchObject({ name: 'Card', mutations: 1, bursts: 0, hot: false });
	});

	it('reports QUIET with the busiest component, or no mutations at all; notes missing long-frame support', async () => {
		const { cards } = buildFixture();
		const p = cards[1].querySelector('p')!;
		const quiet = await uiProfile(
			{ durationMs: 1500 },
			opts(async () => {
				await hammerText(p, 3);
			})
		);
		expect(quiet.text.split('\n')[0]).toBe(
			'QUIET no component above the burst threshold (20 mutation batches within 1000ms); busiest: Card 3 mutations in 1.5s'
		);
		expect(quiet.data!.verdict).toBe('QUIET');
		expect(quiet.data!.hot).toEqual([]);

		const none = await uiProfile(
			{ durationMs: 1000 },
			opts(() => {}, {
				longFrames: () => ({ type: null, stop: () => ({ count: 0, worstMs: 0 }) }),
				fpsMeter: fakeFps([], 0)
			})
		);
		const text = none.text;
		expect(text.split('\n')[0]).toMatch(/; no DOM mutations$/);
		expect(text).toContain('No DOM mutations attributed to Svelte components during the window.');
		expect(text).toContain('Note: FPS unavailable');
		expect(text).toContain('Note: long frames unavailable');
		expect(text).not.toContain('LONG FRAMES');
		expect(none.data!.fps).toBeNull();
		expect(none.data!.longFrames).toBeNull();
	});

	it('counts mutations made right before the window closes (pending records are flushed on stop)', async () => {
		const { h1 } = buildFixture();
		const out = await uiProfile(
			{ durationMs: 500 },
			opts(() => {
				h1.setAttribute('data-x', '1'); // no yield: still queued when the tracker stops
			})
		);
		expect(comps(out.data)).toMatchObject([{ name: 'App', mutations: 1 }]);
	});

	it("ignores svelte-grab's own UI and data-sg-ref stamps", async () => {
		const { buttons } = buildFixture();
		const overlay = h('div', { 'data-svelte-grab-ui': '' });
		const inside = meta(h('span', {}, '0'), '/src/lib/Overlay.svelte', 1, 1, null);
		overlay.append(inside);
		document.body.append(overlay);
		const out = await uiProfile(
			{},
			opts(async () => {
				await hammerText(inside, 30);
				for (let i = 0; i < 30; i++) {
					buttons[0].setAttribute('data-sg-ref', `e${900 + i}`);
					await tick();
				}
			})
		);
		expect(comps(out.data)).toEqual([]);
		expect(out.data!.verdict).toBe('QUIET');
	});
});

describe('ui_profile: scope', () => {
	it('component scope keeps the component and everything rendered inside its instances', async () => {
		const { h1, cards, buttons } = buildFixture();
		const during = async () => {
			await hammerText(h1, 2); // App.svelte, outside any Card
			await hammerText(cards[0].querySelector('p')!, 2); // Card.svelte
			await hammerText(buttons[1], 2); // Button rendered inside a Card instance
		};
		const card = await uiProfile({ component: 'card' }, opts(during));
		expect(comps(card.data).map((c) => [c.name, c.mutations])).toEqual([
			['Card', 2],
			['Button', 2]
		]);
		expect(card.text).toContain('scope: component card');
		expect(card.data!.scope).toEqual({ component: 'card' });

		const button = await uiProfile({ component: 'Button' }, opts(during));
		expect(comps(button.data).map((c) => c.name)).toEqual(['Button']);
	});

	it('ref scope keeps only that subtree', async () => {
		const { cards, buttons } = buildFixture();
		const ref = registry.refFor(cards[1]);
		const out = await uiProfile(
			{ ref },
			opts(async () => {
				await hammerText(buttons[0], 3); // cards[0]: outside
				await hammerText(buttons[1], 4); // cards[1]: inside
			})
		);
		expect(comps(out.data)).toMatchObject([{ name: 'Button', mutations: 4 }]);
		expect(out.text).toContain(`scope: ref ${ref} subtree`);
	});
});

describe('ui_profile: actions', () => {
	it('click dispatches the pointer/mouse sequence, untrusted, on the element', () => {
		const btn = h('button', {}, 'go');
		document.body.append(btn);
		const seen: string[] = [];
		for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
			btn.addEventListener(type, (e) => seen.push(`${type}:${e.isTrusted}:${e.bubbles}`));
		}
		performAction(btn, { type: 'click' });
		const order = seen.map((s) => s.split(':')[0]);
		expect(order.filter((t) => t.startsWith('mouse') || t === 'click')).toEqual([
			'mousedown',
			'mouseup',
			'click'
		]);
		if (typeof window.PointerEvent === 'function') {
			expect(order).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
		}
		expect(seen.every((s) => s.endsWith(':false:true'))).toBe(true);
		expect(document.activeElement).toBe(btn);
	});

	it('input sets the value and fires input + change; checkboxes toggle; other elements throw', () => {
		const input = h('input') as HTMLInputElement;
		const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
		const div = h('div');
		document.body.append(input, box, div);
		const seen: string[] = [];
		input.addEventListener('input', () => seen.push(`input:${input.value}`));
		input.addEventListener('change', () => seen.push(`change:${input.value}`));
		performAction(input, { type: 'input', value: 'hello' });
		expect(seen).toEqual(['input:hello', 'change:hello']);

		performAction(box, { type: 'input', value: 'true' });
		expect(box.checked).toBe(true);
		performAction(box, { type: 'input', value: 'false' });
		expect(box.checked).toBe(false);

		expect(() => performAction(div, { type: 'input', value: 'x' })).toThrow('got <div>');
	});

	it('scroll scrolls a scrollable element by the delta, or into view without one', () => {
		const pane = h('div');
		document.body.append(pane);
		Object.defineProperty(pane, 'scrollHeight', { value: 1000 });
		Object.defineProperty(pane, 'clientHeight', { value: 100 });
		performAction(pane, { type: 'scroll', delta: { x: 0, y: 250 } });
		expect(pane.scrollTop).toBe(250);

		const target = h('p');
		document.body.append(target);
		const intoView = vi.fn();
		(target as unknown as { scrollIntoView: unknown }).scrollIntoView = intoView;
		performAction(target, { type: 'scroll' });
		expect(intoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' });
	});

	it('spreads repeat runs evenly over the window (i * durationMs / repeat)', async () => {
		expect(actionOffsets(3000, 3)).toEqual([0, 1000, 2000]);
		expect(actionOffsets(1000, 3)).toEqual([0, 333, 666]);
		expect(actionOffsets(1500, 1)).toEqual([0]);

		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const { buttons } = buildFixture();
		let clicks = 0;
		buttons[0].addEventListener('click', () => clicks++);
		const ref = registry.refFor(buttons[0]);
		const running = uiProfile(
			{ durationMs: 3000, action: { ref, type: 'click', repeat: 3 } },
			{ registry, fpsMeter: fakeFps([], 0), longFrames: loaf(0, 0) }
		);
		expect(clicks).toBe(1);
		await vi.advanceTimersByTimeAsync(999);
		expect(clicks).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(clicks).toBe(2);
		await vi.advanceTimersByTimeAsync(1000);
		expect(clicks).toBe(3);
		await vi.advanceTimersByTimeAsync(1000);
		const out = await running;
		expect(out.data!.action).toEqual({
			ref,
			type: 'click',
			repeat: 3,
			offsetsMs: [0, 1000, 2000],
			performed: 3,
			skipped: [],
			isTrusted: false
		});
		expect(out.text).toContain(`action: click ${ref} x3 (isTrusted=false)`);
	});

	it('skips (and notes) runs whose ref no longer resolves', async () => {
		const inst = component('Toggle', '/src/App.svelte', 9);
		const btn = meta(h('button', {}, 'once'), '/src/lib/Toggle.svelte', 1, 1, inst);
		document.body.append(btn);
		btn.addEventListener('click', () => btn.remove());
		const ref = registry.refFor(btn);
		const out = await uiProfile(
			{ durationMs: 1000, action: { ref, type: 'click', repeat: 2 } },
			opts(() => {})
		);
		const action = out.data!.action as { performed: number; skipped: string[] };
		expect(action.performed).toBe(1);
		expect(action.skipped).toEqual([`run 2/2: ref ${ref} no longer resolves`]);
		expect(out.text).toContain(`x2 (1 performed) (isTrusted=false)`);
		expect(out.text).toContain(`Note: run 2/2: ref ${ref} no longer resolves`);
	});
});

describe('ProfilerTracker options', () => {
	it('filter and trackElements feed getTopElements / getMutationKinds', async () => {
		const { buttons, cards } = buildFixture();
		const tracker = new ProfilerTracker(20, 1000, null, {
			filter: (t) => t !== cards[1].querySelector('p'),
			trackElements: true
		});
		tracker.start();
		await hammerText(buttons[0], 3);
		await hammerText(buttons[1], 1);
		await hammerText(cards[1].querySelector('p')!, 5); // filtered out
		tracker.stop();
		expect(tracker.getTopElements('/src/lib/Button.svelte')).toEqual([
			{ element: buttons[0], count: 3 },
			{ element: buttons[1], count: 1 }
		]);
		expect(tracker.getMutationKinds('/src/lib/Button.svelte')).toEqual({
			childList: 0,
			attributes: 0,
			characterData: 4
		});
		expect(tracker.getMutationKinds('/src/lib/Card.svelte')).toEqual({
			childList: 0,
			attributes: 0,
			characterData: 0
		});
		expect(tracker.getTopElements('/src/lib/Card.svelte')).toEqual([]);
	});
});

describe('formatSeconds', () => {
	it('drops a trailing .0', () => {
		expect(formatSeconds(3000)).toBe('3s');
		expect(formatSeconds(1503)).toBe('1.5s');
		expect(formatSeconds(30_000)).toBe('30s');
	});
});
