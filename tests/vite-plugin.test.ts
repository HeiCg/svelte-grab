import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
	svelteGrab,
	createClientModule,
	createImportersMiddleware,
	findImporters,
	injectClientImport,
	isSameOriginRequest,
	IMPORTERS_PATH,
	VIRTUAL_CLIENT_ID,
	VITE_PLUGIN_GLOBAL,
	HMR_BRIDGE_EVENT,
	BRIDGED_EVENTS,
	type ModuleGraphLike,
	type ModuleNodeLike
} from '../src/vite/index.js';
import * as browserSide from '../src/lib/utils/vite-plugin-info.js';
import pkg from '../package.json' with { type: 'json' };

const ROOT = '/Users/me/app';

function node(file: string, url: string, id = file): ModuleNodeLike {
	return { id, file, url, importers: new Set() };
}

/** App.svelte and ControlFlow.svelte import Card.svelte; Card has a CSS sub-module. */
function fakeGraph(): ModuleGraphLike {
	const app = node(`${ROOT}/src/App.svelte`, '/src/App.svelte');
	const flow = node(`${ROOT}/src/components/ControlFlow.svelte`, '/src/components/ControlFlow.svelte');
	const card = node(`${ROOT}/src/components/Card.svelte`, '/src/components/Card.svelte');
	const cardCss = node(
		`${ROOT}/src/components/Card.svelte`,
		'/src/components/Card.svelte?svelte&type=style&lang.css',
		`${ROOT}/src/components/Card.svelte?svelte&type=style&lang.css`
	);
	const fixtureCard = node(`${ROOT}/src/components/FixtureCard.svelte`, '/src/components/FixtureCard.svelte');
	card.importers.add(app).add(flow);
	cardCss.importers.add(card);
	fixtureCard.importers.add(flow);
	const map = new Map<string, Set<ModuleNodeLike>>([
		[app.file!, new Set([app])],
		[flow.file!, new Set([flow])],
		[card.file!, new Set([card, cardCss])],
		[fixtureCard.file!, new Set([fixtureCard])]
	]);
	return { getModulesByFile: (f) => map.get(f), fileToModulesMap: map };
}

interface FakeRes {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
}

function run(
	method: string,
	url: string,
	headers: Record<string, string> = {},
	graph: ModuleGraphLike | null = fakeGraph()
): FakeRes & { json: any } {
	const res: FakeRes = { statusCode: 200, headers: {}, body: '' };
	const fakeRes = {
		set statusCode(v: number) {
			res.statusCode = v;
		},
		get statusCode() {
			return res.statusCode;
		},
		setHeader: (k: string, v: string) => {
			res.headers[k.toLowerCase()] = v;
		},
		end: (b?: string) => {
			res.body = b ?? '';
		}
	} as unknown as ServerResponse;
	const req = { method, url, headers: { host: 'localhost:5173', ...headers } } as unknown as IncomingMessage;
	createImportersMiddleware(() => graph ?? undefined, () => ROOT)(req, fakeRes, () => {
		throw new Error('next() should not be called');
	});
	return { ...res, json: res.body ? JSON.parse(res.body) : null };
}

describe('svelte-grab/vite plugin shape', () => {
	it('applies to the dev server only, after other plugins', () => {
		const plugin = svelteGrab();
		expect(plugin.name).toBe('svelte-grab');
		expect(plugin.apply).toBe('serve');
		expect(plugin.enforce).toBe('post');
	});

	it('shares its window/event names with the browser side', () => {
		expect(VITE_PLUGIN_GLOBAL).toBe(browserSide.VITE_PLUGIN_GLOBAL);
		expect(HMR_BRIDGE_EVENT).toBe(browserSide.HMR_BRIDGE_EVENT);
	});

	it('resolves and loads the virtual client with version, root and endpoints', () => {
		const plugin = svelteGrab() as any;
		plugin.configResolved({ root: ROOT, base: '/' });
		const resolved = plugin.resolveId(VIRTUAL_CLIENT_ID);
		expect(resolved).toBe(`\0${VIRTUAL_CLIENT_ID}`);
		expect(plugin.resolveId('svelte')).toBeNull();
		const code: string = plugin.load(resolved);
		expect(code).toContain(`"version":"${pkg.version}"`);
		expect(code).toContain(`"root":"${ROOT}"`);
		expect(code).toContain(`"importersEndpoint":"${IMPORTERS_PATH}"`);
		expect(code).toContain('import.meta.hot.on(type, forward(type))');
		expect(plugin.load('/src/App.svelte')).toBeNull();

		const off = svelteGrab({ importers: false, hmrBridge: false }) as any;
		off.configResolved({ root: ROOT, base: '/' });
		const offCode: string = off.load(resolved);
		expect(offCode).toContain('"hmrBridge":false');
		expect(offCode).toContain('"importersEndpoint":null');
	});

	it('injects the client into index.html, honouring base', () => {
		const plugin = svelteGrab() as any;
		plugin.configResolved({ root: ROOT, base: '/app/' });
		expect(plugin.transformIndexHtml()).toEqual([
			{
				tag: 'script',
				attrs: { type: 'module', src: `/app/@id/__x00__${VIRTUAL_CLIENT_ID}` },
				injectTo: 'head'
			}
		]);
	});

	it('prepends the client import to client modules that import svelte-grab', () => {
		const plugin = svelteGrab() as any;
		const code = `import { SvelteGrab } from "svelte-grab";\nexport default 1;`;
		expect(plugin.transform(code, '/app/src/routes/+layout.svelte')).toEqual({
			code: `import "${VIRTUAL_CLIENT_ID}";${code}`,
			map: null
		});
		expect(plugin.transform(code, '/app/src/routes/+layout.svelte', { ssr: true })).toBeNull();
		expect(plugin.transform(code, '/app/node_modules/x/index.js')).toBeNull();
		expect(plugin.transform('import "svelte";', '/app/src/a.ts')).toBeNull();
	});

	it('injectClientImport matches real imports of svelte-grab only', () => {
		expect(injectClientImport(`import { SvelteDevKit } from 'svelte-grab';`)).toMatch(/^import "virtual:svelte-grab\/client";/);
		expect(injectClientImport(`import x from "svelte-grab/vite";`)).not.toBeNull();
		expect(injectClientImport(`const m = await import('svelte-grab');`)).not.toBeNull();
		expect(injectClientImport(`const key = 'svelte-grab-tab-id';`)).toBeNull();
		expect(injectClientImport(`import "${VIRTUAL_CLIENT_ID}"; import 'svelte-grab';`)).toBeNull();
	});

	it('the client module forwards every bridged Vite event', () => {
		const code = createClientModule({ version: '1', root: ROOT, hmrBridge: true, importersEndpoint: null });
		for (const event of BRIDGED_EVENTS) expect(code).toContain(event);
		expect(code).toContain(`"${HMR_BRIDGE_EVENT}"`);
		expect(code).toContain('waitUntil');
	});

	it('mounts the importers middleware on the dev server (and not when disabled)', () => {
		const used: string[] = [];
		const server = { middlewares: { use: (path: string) => used.push(path) }, moduleGraph: fakeGraph() };
		(svelteGrab() as any).configureServer(server);
		expect(used).toEqual([IMPORTERS_PATH]);
		used.length = 0;
		(svelteGrab({ importers: false }) as any).configureServer(server);
		expect(used).toEqual([]);
	});
});

describe('findImporters', () => {
	it('finds importers by suffix, root-relative and absolute path', () => {
		const graph = fakeGraph();
		const expected = [
			{ file: 'src/App.svelte', url: '/src/App.svelte' },
			{ file: 'src/components/ControlFlow.svelte', url: '/src/components/ControlFlow.svelte' }
		];
		for (const q of ['Card.svelte', 'src/components/Card.svelte', '/src/components/Card.svelte', `${ROOT}/src/components/Card.svelte`]) {
			const out = findImporters(graph, ROOT, q);
			expect(out.found, q).toBe(true);
			expect(out.matches).toEqual(['src/components/Card.svelte']);
			// The CSS sub-module's importer (Card.svelte itself) is not reported.
			expect(out.importers).toEqual(expected);
		}
	});

	it('reports unknown files as not found', () => {
		expect(findImporters(fakeGraph(), ROOT, 'Nope.svelte')).toEqual({
			file: 'Nope.svelte',
			found: false,
			matches: [],
			importers: []
		});
		expect(findImporters(fakeGraph(), ROOT, 'ard.svelte').found).toBe(false);
	});
});

describe('importers endpoint', () => {
	it('answers GET with the importers as JSON', () => {
		const res = run('GET', '/?file=FixtureCard.svelte', { 'sec-fetch-site': 'same-origin', origin: 'http://localhost:5173' });
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toMatch(/application\/json/);
		expect(res.json).toMatchObject({
			found: true,
			matches: ['src/components/FixtureCard.svelte'],
			importers: [{ file: 'src/components/ControlFlow.svelte' }]
		});
	});

	it('rejects cross-origin requests', () => {
		expect(run('GET', '/?file=Card.svelte', { origin: 'http://evil.example' }).statusCode).toBe(403);
		expect(run('GET', '/?file=Card.svelte', { 'sec-fetch-site': 'cross-site' }).statusCode).toBe(403);
		expect(run('GET', '/?file=Card.svelte', { 'sec-fetch-site': 'same-site' }).statusCode).toBe(403);
		expect(run('GET', '/?file=Card.svelte', { origin: 'null' }).statusCode).toBe(403);
		expect(run('GET', '/?file=Card.svelte', { origin: 'http://localhost:9999' }).statusCode).toBe(403);
	});

	it('rejects other methods, missing/oversized file and a missing graph', () => {
		const post = run('POST', '/?file=Card.svelte');
		expect(post.statusCode).toBe(405);
		expect(post.headers.allow).toBe('GET, HEAD');
		expect(run('GET', '/').statusCode).toBe(400);
		expect(run('GET', `/?file=${'a'.repeat(2000)}`).statusCode).toBe(414);
		expect(run('GET', '/?file=Card.svelte', {}, null).statusCode).toBe(503);
	});

	it('isSameOriginRequest allows non-browser clients and same-origin browsers', () => {
		expect(isSameOriginRequest({ headers: { host: 'localhost:5173' } })).toBe(true);
		expect(isSameOriginRequest({ headers: { host: 'localhost:5173', 'sec-fetch-site': 'none' } })).toBe(true);
		expect(isSameOriginRequest({ headers: { host: 'localhost:5173', origin: 'http://localhost:5173' } })).toBe(true);
		expect(isSameOriginRequest({ headers: { host: 'localhost:5173', origin: 'not a url' } })).toBe(false);
	});
});
