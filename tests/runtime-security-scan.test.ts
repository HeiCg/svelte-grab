// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NetworkCapture } from '../src/lib/runtime/network.js';
import { SECURITY_CHECKS, literalPairs, uiSecurityScan, type SecurityFinding } from '../src/lib/runtime/security-scan.js';
import { meta } from './runtime-helpers.js';

/** Fake credentials, assembled at runtime (never a literal secret in the repo). */
const FAKE_STRIPE = 'sk_' + 'test_' + 'FAKEfake0000FAKEfake0000';
const FAKE_STRIPE_LIVE = 'sk_' + 'live_' + 'FAKEfake0000FAKEfake0000';
const b64url = (s: string) => Buffer.from(s).toString('base64url');
const FAKE_JWT = `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url('{"sub":"fake-user","iat":1700000000}')}.FAKEsignatureFAKE0000`;
const FAKE_HASH = '$2b$10$' + 'FAKEfakeFAKEfakeFAKEfake0000';
const ALL_FAKES = [FAKE_STRIPE, FAKE_STRIPE_LIVE, FAKE_JWT, FAKE_HASH, 'fake-pass-1234'];

const PAGE = 'http://localhost:5173/dashboard';

/**
 * In-memory Web Storage: Node >= 25 defines its own global `localStorage`
 * (unusable without --localstorage-file) that shadows jsdom's, so the
 * storage check gets a fake window.
 */
function memoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		get length() {
			return map.size;
		},
		key: (i: number) => [...map.keys()][i] ?? null,
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, String(v)),
		removeItem: (k: string) => void map.delete(k),
		clear: () => map.clear()
	};
}
let local = memoryStorage();
let session = memoryStorage();
const storageWin = () => ({ localStorage: local, sessionStorage: session }) as unknown as Window;
const NO_HEADERS_FETCH = async () => new Response(null, { status: 200 });

function capture(): NetworkCapture {
	// Never installed: entries are recorded directly.
	return new NetworkCapture({ target: null });
}

async function scan(
	checks: string[],
	opts: {
		cap?: NetworkCapture;
		pageUrl?: string;
		env?: Record<string, unknown> | null;
		fetch?: (u: string, i?: RequestInit) => Promise<Response>;
		win?: Window;
	} = {}
) {
	const out = await uiSecurityScan(
		{ checks },
		{
			capture: opts.cap ?? capture(),
			pageUrl: opts.pageUrl ?? PAGE,
			env: opts.env ?? null,
			fetch: opts.fetch ?? NO_HEADERS_FETCH,
			...(opts.win ? { win: opts.win } : {})
		}
	);
	const findings = out.data!.findings as SecurityFinding[];
	// Mandatory redaction: no fake secret ever leaves the page.
	const dump = out.text + JSON.stringify(out.data);
	for (const secret of ALL_FAKES) expect(dump).not.toContain(secret);
	return { ...out, findings };
}

beforeEach(() => {
	local = memoryStorage();
	session = memoryStorage();
	document.body.innerHTML = '';
	document.head.innerHTML = '';
	for (const c of document.cookie.split(';')) {
		const name = c.split('=')[0].trim();
		if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
	}
});

describe('ui_security_scan: transit', () => {
	it('secret in a URL query -> high confirmed, with initiator source', async () => {
		const cap = capture();
		cap.record({
			type: 'fetch',
			url: `http://localhost:5173/api/mock?api_key=${FAKE_STRIPE}&page=1`,
			initiator: { file: 'src/components/LeakyRequests.svelte', line: 14, column: 3, component: 'LeakyRequests' }
		});
		cap.record({ type: 'fetch', url: `http://localhost:5173/api/mock?api_key=${FAKE_STRIPE}&page=2` });
		const { findings, text } = await scan(['transit'], { cap });
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			check: 'transit',
			severity: 'high',
			verdict: 'confirmed',
			title: 'Stripe secret key in URL query parameter "api_key"',
			source: 'src/components/LeakyRequests.svelte:14 (LeakyRequests)'
		});
		expect(findings[0].id).toMatch(/^token-in-url:[0-9a-f]{6}$/);
		expect(findings[0].evidence).toMatch(/api_key=stripe-secret-key:sk_t…\(len \d+, sha [0-9a-f]{6}\)&page=1 \(x2\)$/);
		expect(text).toMatch(/^SECURITY 1 high, 0 medium, 0 low, 0 info \(checks: transit\)\nHIGH\n {2}token-in-url:/);
	});

	it('auth header to a third-party origin -> high; same-origin auth header is fine', async () => {
		const cap = capture();
		cap.record({ type: 'fetch', method: 'POST', url: 'https://third-party.example/collect', requestHeaders: { authorization: `Bearer ${FAKE_JWT}` } });
		cap.record({ type: 'fetch', url: 'http://localhost:5173/api/me', requestHeaders: { authorization: `Bearer ${FAKE_JWT}` } });
		const { findings } = await scan(['transit'], { cap });
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			severity: 'high',
			verdict: 'confirmed',
			title: 'Credential header "authorization" sent to third-party third-party.example'
		});
		expect(findings[0].evidence).toMatch(/authorization: Bearer jwt:eyJh…\(len \d+, sha [0-9a-f]{6}\)$/);
	});

	it('credentials in a body to a third party -> finding; key-only -> needs_validation', async () => {
		const cap = capture();
		cap.record({
			type: 'beacon',
			method: 'POST',
			url: 'https://analytics.example/e',
			requestBody: JSON.stringify({ event: 'login', props: { password: 'fake-pass-1234', session: FAKE_JWT } })
		});
		const { findings } = await scan(['transit'], { cap });
		expect(findings.map((f) => [f.severity, f.verdict, f.title])).toEqual([
			['high', 'confirmed', 'JWT in request body to third-party analytics.example'],
			['medium', 'needs_validation', 'Sensitive field (password) in request body to third-party analytics.example']
		]);
	});

	it('the page URL itself is checked', async () => {
		const { findings } = await scan(['transit'], { pageUrl: `${PAGE}#access_token=${FAKE_JWT}` });
		expect(findings[0]).toMatchObject({ severity: 'high', title: 'JWT in URL fragment parameter "access_token"' });
	});
});

describe('ui_security_scan: storage, cookies, globals', () => {
	it('JWT in localStorage -> medium; server secret in sessionStorage -> high; own keys ignored', async () => {
		local.setItem('fake-auth', FAKE_JWT);
		local.setItem('prefs', JSON.stringify({ theme: 'dark' }));
		local.setItem('svelte-grab-history', JSON.stringify({ token: FAKE_JWT }));
		session.setItem('cfg', JSON.stringify({ stripe: { key: FAKE_STRIPE_LIVE } }));
		const { findings } = await scan(['storage'], { win: storageWin() });
		expect(findings.map((f) => [f.severity, f.verdict, f.title])).toEqual([
			['high', 'confirmed', 'Stripe secret key in sessionStorage "cfg"'],
			['medium', 'confirmed', 'JWT in localStorage "fake-auth"']
		]);
		expect(findings[1].id).toMatch(/^jwt-in-storage:/);
		expect(findings[1].evidence).toMatch(/^localStorage\["fake-auth"\] = jwt:eyJh…/);
		expect(findings[0].evidence).toMatch(/^sessionStorage\["cfg"\]\.stripe\.key = stripe-secret-key:sk_l…/);
	});

	it('opaque token under a sensitive storage key -> medium needs_validation', async () => {
		local.setItem('access_token', 'opaque-fake-token-value');
		const { findings } = await scan(['storage'], { win: storageWin() });
		expect(findings[0]).toMatchObject({ severity: 'medium', verdict: 'needs_validation' });
	});

	it('JS-readable auth cookies -> medium (missing HttpOnly); CSRF cookies are fine', async () => {
		document.cookie = 'session_id=fakeSessionValue1234';
		document.cookie = 'csrf_token=fakecsrf1234';
		document.cookie = 'theme=dark';
		const { findings } = await scan(['cookies']);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			check: 'cookies',
			severity: 'medium',
			title: 'Auth-looking cookie "session_id" is readable by JavaScript (missing HttpOnly)'
		});
		expect(findings[0].evidence).not.toContain('fakeSessionValue1234');
	});

	it('secrets on non-standard window globals', async () => {
		const w = window as unknown as Record<string, unknown>;
		w.APP_CONFIG = { stripeKey: FAKE_STRIPE_LIVE, name: 'demo' };
		try {
			const { findings } = await scan(['globals']);
			expect(findings).toEqual([
				expect.objectContaining({ check: 'globals', severity: 'high', title: 'Stripe secret key in window.APP_CONFIG' })
			]);
		} finally {
			delete w.APP_CONFIG;
		}
	});
});

describe('ui_security_scan: sveltekit + env', () => {
	afterEach(() => {
		delete (window as unknown as Record<string, unknown>).__sveltekit_dev;
	});

	it('not a SvelteKit page -> a note, no findings', async () => {
		const { findings, data } = await scan(['sveltekit']);
		expect(findings).toEqual([]);
		expect(data!.notes).toEqual([expect.stringMatching(/^sveltekit: not a SvelteKit page/)]);
	});

	it('inline boot script page data with a password hash (Kit 3 kit.start(...{ data }))', async () => {
		const script = document.createElement('script');
		// Not executed by jsdom (Kit's real boot script has no type).
		script.type = 'text/x-not-executed';
		script.textContent = `
			__sveltekit_dev = { base: new URL(".", location).pathname.slice(0, -1) };
			const element = document.currentScript.parentElement;
			import("/@fs/app/node_modules/@sveltejs/kit/src/runtime/client/entry.js").then((app) => {
				app.start(element, { node_ids: [0, 2], data: [null,{type:"data",data:{user:{id:1,name:"Ada",password_hash:"${FAKE_HASH}"}},uses:{}}], form: null, error: null });
			});`;
		document.body.append(script);
		const { findings } = await scan(['sveltekit']);
		expect(findings).toEqual([
			expect.objectContaining({
				check: 'sveltekit',
				severity: 'high',
				verdict: 'needs_validation',
				title: 'Sensitive field (password) in SvelteKit page data (inline boot script)'
			})
		]);
		expect(findings[0].evidence).toMatch(/^boot <script> data password_hash = password:\$2b\$…/);
	});

	it('data-sveltekit-fetched payloads and captured __data.json bodies (devalue flattened)', async () => {
		const fetched = document.createElement('script');
		fetched.type = 'application/json';
		fetched.setAttribute('data-sveltekit-fetched', '');
		fetched.setAttribute('data-url', '/api/profile');
		fetched.textContent = JSON.stringify({ status: 200, statusText: '', headers: {}, body: JSON.stringify({ apiKey: FAKE_STRIPE_LIVE }) });
		document.body.append(fetched);

		const cap = capture();
		cap.record({
			type: 'fetch',
			url: 'http://localhost:5173/account/__data.json?x-sveltekit-invalidated=01',
			responseBody: JSON.stringify({
				type: 'data',
				nodes: [null, { type: 'data', data: [{ user: 1 }, { name: 2, ssn: 3 }, 'Ada', '123-45-6789'], uses: {} }]
			})
		});
		cap.record({ type: 'fetch', url: 'http://localhost:5173/other/__data.json' });
		const { findings, data } = await scan(['sveltekit'], { cap });
		expect(findings.map((f) => [f.severity, f.title])).toEqual([
			['high', 'Stripe secret key in SvelteKit SSR fetch payload /api/profile'],
			['high', 'Sensitive field (ssn) in SvelteKit __data.json response']
		]);
		expect(findings[1].evidence).toMatch(/__data\.json\?x-sveltekit-invalidated=01 user\.ssn = ssn:12…/);
		expect(data!.notes).toEqual([expect.stringMatching(/1 __data\.json \/ remote-function response\(s\) captured without bodies/)]);
	});

	it('client env: secret-shaped VITE_ value -> high; sensitive name -> medium; Kit dynamic public env', async () => {
		(window as unknown as Record<string, unknown>).__sveltekit_dev = { env: { PUBLIC_ANALYTICS_TOKEN: 'fakeAnalyticsToken1234' } };
		const { findings } = await scan(['env'], {
			env: { MODE: 'development', DEV: true, BASE_URL: '/', VITE_STRIPE_SECRET: FAKE_STRIPE_LIVE, VITE_APP_NAME: 'demo' }
		});
		expect(findings.map((f) => [f.severity, f.verdict, f.title])).toEqual([
			['high', 'confirmed', 'Stripe secret key exposed to the browser as VITE_STRIPE_SECRET'],
			['medium', 'needs_validation', 'Sensitive name (token) exposed to the browser as PUBLIC_ANALYTICS_TOKEN']
		]);
	});

	it('literalPairs reads devalue.uneval object literals', () => {
		expect(literalPairs('{user:{name:"Ada","api-key":"x\\u0041y"},n:1}')).toEqual([
			{ key: 'name', value: 'Ada' },
			{ key: 'api-key', value: 'xAy' }
		]);
	});
});

describe('ui_security_scan: headers', () => {
	const headersFetch = (headers: Record<string, string>) => async () => new Response(null, { status: 200, headers });

	it('dev (loopback) host: missing headers are info / needs_validation', async () => {
		const { findings } = await scan(['headers']);
		expect(findings.length).toBeGreaterThan(0);
		for (const f of findings) {
			expect(f.severity).toBe('info');
			expect(f.verdict).toBe('needs_validation');
			expect(f.title).toContain('(dev server');
		}
		expect(findings.map((f) => f.id.split(':')[0]).sort()).toEqual(['clickjacking', 'csp-missing', 'no-nosniff', 'no-referrer-policy']);
	});

	it('production host: missing CSP medium, unsafe-inline medium, HSTS low', async () => {
		const missing = await scan(['headers'], { pageUrl: 'https://app.example.com/', fetch: headersFetch({}) });
		expect(missing.findings.find((f) => f.id.startsWith('csp-missing'))).toMatchObject({ severity: 'medium', verdict: 'confirmed' });
		expect(missing.findings.find((f) => f.id.startsWith('no-hsts'))).toMatchObject({ severity: 'low' });

		const weak = await scan(['headers'], {
			pageUrl: 'https://app.example.com/',
			fetch: headersFetch({
				'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'",
				'x-content-type-options': 'nosniff',
				'referrer-policy': 'strict-origin',
				'x-frame-options': 'DENY',
				'strict-transport-security': 'max-age=31536000'
			})
		});
		expect(weak.findings.map((f) => f.id.split(':')[0]).sort()).toEqual(['csp-unsafe-eval', 'csp-unsafe-inline']);

		const good = await scan(['headers'], {
			pageUrl: 'https://app.example.com/',
			fetch: headersFetch({
				'content-security-policy': "script-src 'self' 'nonce-abc'; frame-ancestors 'self'",
				'x-content-type-options': 'nosniff',
				'referrer-policy': 'strict-origin',
				'strict-transport-security': 'max-age=31536000'
			})
		});
		expect(good.findings).toEqual([]);
	});

	it('HEAD failure becomes a note', async () => {
		const { findings, data } = await scan(['headers'], {
			fetch: async () => {
				throw new TypeError('Failed to fetch');
			}
		});
		expect(findings).toEqual([]);
		expect(data!.notes).toEqual([expect.stringMatching(/^headers: HEAD \/dashboard failed/)]);
	});
});

describe('ui_security_scan: dom + mixed', () => {
	it('external target=_blank without rel (low), inline handlers / javascript: URLs from raw HTML (medium)', async () => {
		const host = meta(document.createElement('div'), 'src/routes/+page.svelte', 10, 1, null);
		host.innerHTML =
			'<a href="https://elsewhere.example/" target="_blank">x</a>' +
			'<a href="https://safe.example/" target="_blank" rel="noopener">ok</a>' +
			'<a href="/internal" target="_blank">same origin</a>' +
			'<img src="x.png" onerror="alert(1)">' +
			'<a href="javascript:alert(1)">js</a>';
		document.body.append(host);
		const { findings } = await scan(['dom']);
		expect(findings.map((f) => [f.severity, f.id.split(':')[0], f.source])).toEqual([
			['medium', 'inline-handler', 'src/routes/+page.svelte:10'],
			['medium', 'javascript-url', 'src/routes/+page.svelte:10'],
			['low', 'target-blank-no-rel', 'src/routes/+page.svelte:10']
		]);
		expect(findings[2].title).toBe('1 external link(s) with target="_blank" and no rel="noopener"');
	});

	it('https page: http requests and http subresources are mixed content', async () => {
		const cap = capture();
		cap.record({ type: 'fetch', url: 'http://api.example.com/data' });
		cap.record({ type: 'websocket', method: 'WS', url: 'ws://live.example.com/socket' });
		const img = document.createElement('img');
		img.setAttribute('src', 'http://cdn.example.com/a.png');
		document.body.append(img);
		const { findings } = await scan(['mixed'], { cap, pageUrl: 'https://app.example.com/' });
		expect(findings.map((f) => f.title)).toEqual([
			'Insecure http:// request from an https page',
			'Insecure ws:// request from an https page',
			'Insecure http:// <img> on an https page'
		]);
	});

	it('http dev page: ws:// to a remote host is low', async () => {
		const cap = capture();
		cap.record({ type: 'websocket', method: 'WS', url: 'ws://live.example.com/socket' });
		cap.record({ type: 'websocket', method: 'WS', url: 'ws://localhost:5173/' });
		const { findings } = await scan(['mixed'], { cap });
		expect(findings).toEqual([expect.objectContaining({ severity: 'low', title: 'Unencrypted WebSocket (ws://) to a remote host' })]);
	});
});

describe('ui_security_scan: handler', () => {
	it('runs every check by default, groups text by severity, rejects unknown checks', async () => {
		local.setItem('fake-auth', FAKE_JWT);
		const out = await uiSecurityScan({}, { capture: capture(), pageUrl: PAGE, env: null, fetch: NO_HEADERS_FETCH });
		const storage = await uiSecurityScan({}, { capture: capture(), pageUrl: PAGE, env: null, fetch: NO_HEADERS_FETCH, win: storageWin() });
		expect(storage.text).toMatch(/\nMEDIUM\n {2}jwt-in-storage:[0-9a-f]{6} \[confirmed\] JWT in localStorage "fake-auth"\n {4}evidence: /);
		expect(storage.text).not.toContain(FAKE_JWT);
		expect(out.data!.checks).toEqual([...SECURITY_CHECKS]);
		expect(out.text).toMatch(/^SECURITY 0 high, 0 medium, 0 low, \d+ info \(checks: transit, storage, cookies, globals, sveltekit, env, headers, dom, mixed\)/);
		expect(out.text).toMatch(/\nINFO\n {2}csp-missing:[0-9a-f]{6} \[needs_validation\] /);
		expect(out.text).toMatch(/\n {4}fix: /);
		expect(out.text).toMatch(/\nNOTES\n/);
		expect(out.text).not.toContain(FAKE_JWT);
		await expect(uiSecurityScan({ checks: ['nope'] })).rejects.toThrow(/Unknown check "nope"/);
	});

	it('same issue -> same id across runs', async () => {
		local.setItem('fake-auth', FAKE_JWT);
		const a = await scan(['storage'], { win: storageWin() });
		const b = await scan(['storage'], { win: storageWin() });
		expect(a.findings[0].id).toBe(b.findings[0].id);
	});
});
