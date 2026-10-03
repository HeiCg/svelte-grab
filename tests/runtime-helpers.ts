/**
 * Fake Svelte dev metadata for runtime tests (jsdom). Mirrors what
 * Svelte >= 5.35.1 attaches: `el.__svelte_meta = { loc, parent }`, where a
 * `type: 'component'` entry is created per rendered instance and carries the
 * usage site + `componentTag`.
 */
import type { DevStackEntry, SvelteMeta } from '../src/lib/types.js';

type WithMeta = Element & { __svelte_meta?: SvelteMeta };

export function component(
	tag: string,
	usageFile: string,
	line: number,
	parent: DevStackEntry | null = null
): DevStackEntry {
	return { type: 'component', file: usageFile, line, column: 1, parent, componentTag: tag };
}

export function block(
	type: string,
	file: string,
	line: number,
	parent: DevStackEntry | null
): DevStackEntry {
	return { type, file, line, column: 1, parent };
}

export function meta<T extends Element>(
	el: T,
	file: string,
	line: number,
	column: number,
	parent: DevStackEntry | null
): T {
	(el as WithMeta).__svelte_meta = { loc: { file, line, column }, parent };
	return el;
}

/** `document.createElement` + attributes + children in one call. */
export function h(
	tag: string,
	attrs: Record<string, string> = {},
	...children: (Element | string)[]
): HTMLElement {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
	for (const c of children) el.append(c);
	return el;
}

/**
 * Builds:
 *
 *   App.svelte
 *     <main>                                   App.svelte:1:1
 *       <h1>Title</h1>                         App.svelte:2:3
 *       <Card name="a" /> <Card name="b" />    App.svelte:3 / App.svelte:4
 *   Card.svelte
 *     <div class="card">                       Card.svelte:5:1
 *       <p>Card a</p>                          Card.svelte:6:3
 *       <Button label="a" />                   Card.svelte:7
 *   Button.svelte
 *     <button>a</button>                       Button.svelte:2:1
 */
export function buildFixture(): {
	main: HTMLElement;
	h1: HTMLElement;
	cards: HTMLElement[];
	buttons: HTMLElement[];
} {
	const main = meta(h('main'), '/src/App.svelte', 1, 1, null);
	const h1 = meta(h('h1', {}, 'Title'), '/src/App.svelte', 2, 3, null);
	main.append(h1);

	const cards: HTMLElement[] = [];
	const buttons: HTMLElement[] = [];
	['a', 'b'].forEach((name, i) => {
		const cardInst = component('Card', '/src/App.svelte', 3 + i);
		const card = meta(
			h('div', { class: 'card svelte-abc123' }),
			'/src/lib/Card.svelte',
			5,
			1,
			cardInst
		);
		const p = meta(h('p', {}, `Card ${name}`), '/src/lib/Card.svelte', 6, 3, cardInst);
		const btnInst = component('Button', '/src/lib/Card.svelte', 7, cardInst);
		const button = meta(h('button', {}, name), '/src/lib/Button.svelte', 2, 1, btnInst);
		card.append(p, button);
		main.append(card);
		cards.push(card);
		buttons.push(button);
	});

	document.body.append(main);
	return { main, h1, cards, buttons };
}

/** Give an element a fixed, visible bounding box (jsdom has no layout). */
export function setBox(el: Element, x: number, y: number, width: number, height: number): void {
	el.getBoundingClientRect = () =>
		({
			x,
			y,
			left: x,
			top: y,
			width,
			height,
			right: x + width,
			bottom: y + height,
			toJSON() {}
		}) as DOMRect;
}
