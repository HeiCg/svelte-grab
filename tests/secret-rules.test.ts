import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
	SECRET_RULES,
	decodeJwt,
	detectSecret,
	findSecrets,
	isHighEntropyToken,
	isMeaningfulSecretValue,
	redact,
	redactText,
	redactUrl,
	redactionPrefixLength,
	scanValue,
	sensitiveKeyKind,
	sha256Hex,
	shannonEntropy,
	unflattenDevalue,
	utf8Length
} from '../src/lib/security/secret-rules.js';

/*
 * Every fake credential below is assembled at runtime (prefix + body) so the
 * repository never contains a literal that secret scanners would flag. None of
 * them is a real key.
 */
const b64url = (s: string) => Buffer.from(s).toString('base64url');
const fakeJwt = (payload: Record<string, unknown>, sig = 'FAKEsignatureFAKEsignature0123') =>
	`${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.${sig}`;
const FAKE = {
	jwt: fakeJwt({ sub: 'fake-user', name: 'Fake Person', iat: 1700000000 }),
	serviceRole: fakeJwt({ iss: 'supabase', role: 'service_role', iat: 1700000000 }),
	anonRole: fakeJwt({ iss: 'supabase', role: 'anon', iat: 1700000000 }),
	aws: 'AKIA' + 'FAKE0EXAMPLE0KEY',
	gcp: 'AIza' + 'SyFAKE0fake0FAKE0fake0FAKE0fake0FAK',
	stripeLive: 'sk_' + 'live_' + 'FAKEfake0000FAKEfake0000',
	stripeTest: 'sk_' + 'test_' + 'FAKEfake0000FAKEfake0000',
	stripeRestricted: 'rk_' + 'live_' + 'FAKEfake0000FAKEfake0000',
	ghp: 'ghp' + '_' + 'FAKEfakeFAKEfakeFAKEfakeFAKEfake0000',
	ghs: 'ghs' + '_' + 'FAKEfakeFAKEfakeFAKEfakeFAKEfake0000',
	githubPat: 'github' + '_pat_' + '11FAKE0000FAKEfake0000_FAKEfakeFAKE',
	openai: 'sk-' + 'proj-' + 'FAKEfake0000FAKEfake0000FAKE',
	anthropic: 'sk-' + 'ant-' + 'api03-FAKEfake0000FAKEfake0000',
	slack: 'xox' + 'b-' + '0000000000-FAKEfakeFAKE',
	slackHook: 'https://hooks.slack.com/services/' + 'T00000000/B00000000/FAKEfakeFAKEfake',
	privateKey: '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIFAKE\n-----END RSA PRIVATE KEY-----',
	entropy: 'Zr8Kq2Lp9Xw4Vb7Nm1Ty6Hc3Jd5Fs0Ga'
};

describe('secret-rules: provider formats', () => {
	const cases: [keyof typeof FAKE, string][] = [
		['jwt', 'jwt'],
		['serviceRole', 'supabase-service-role'],
		['anonRole', 'jwt'],
		['aws', 'aws-access-key'],
		['gcp', 'gcp-api-key'],
		['stripeLive', 'stripe-secret-key'],
		['stripeTest', 'stripe-secret-key'],
		['stripeRestricted', 'stripe-restricted-key'],
		['ghp', 'github-token'],
		['ghs', 'github-token'],
		['githubPat', 'github-token'],
		['openai', 'openai-key'],
		['anthropic', 'anthropic-key'],
		['slack', 'slack-token'],
		['slackHook', 'slack-webhook'],
		['privateKey', 'private-key']
	];
	for (const [name, kind] of cases) {
		it(`detects ${name} as ${kind} (high confidence)`, () => {
			const m = detectSecret(FAKE[name]);
			expect(m?.kind).toBe(kind);
			expect(m?.confidence).toBe('high');
		});
	}

	it('finds secrets embedded in text, at the right offsets', () => {
		const text = `const a = "${FAKE.aws}"; fetch(url, { headers: { k: '${FAKE.stripeLive}' } })`;
		const all = findSecrets(text);
		expect(all.map((m) => m.kind)).toEqual(['aws-access-key', 'stripe-secret-key']);
		for (const m of all) expect(text.slice(m.start, m.end)).toBe(m.value);
	});

	it('Bearer: the token after the scheme; a JWT bearer is reported as jwt', () => {
		const opaque = 'Bearer ' + 'FAKEopaqueTOKEN0000fake';
		const m = detectSecret(opaque);
		expect(m?.kind).toBe('bearer');
		expect(m?.value).toBe('FAKEopaqueTOKEN0000fake');
		expect(detectSecret(`Bearer ${FAKE.jwt}`)?.kind).toBe('jwt');
	});

	it('Anthropic keys are not reported as OpenAI keys', () => {
		expect(findSecrets(FAKE.anthropic).map((m) => m.kind)).toEqual(['anthropic-key']);
	});

	it('JWT needs a decodable header with alg', () => {
		expect(decodeJwt(FAKE.jwt)?.payload.sub).toBe('fake-user');
		const bogus = 'eyJhbGciOiJIUzI1NiJ9xx.eyJzdWIiOiJ4In0.abc'; // header base64 broken
		expect(detectSecret(bogus, { entropy: false })).toBeNull();
	});

	it('every rule has a global pattern', () => {
		for (const rule of SECRET_RULES) expect(rule.pattern.flags).toContain('g');
	});
});

describe('secret-rules: false positives', () => {
	it('UUIDs are not secrets', () => {
		expect(detectSecret('3f2b8c1e-9a4d-4e7f-b1c2-d3e4f5a6b7c8')).toBeNull();
		expect(isHighEntropyToken('3f2b8c1e-9a4d-4e7f-b1c2-d3e4f5a6b7c8')).toBe(false);
	});

	it('hex digests (asset hashes, sha1/sha256) are not secrets', () => {
		expect(detectSecret(createHash('sha256').update('app.js').digest('hex'))).toBeNull();
		expect(detectSecret(createHash('sha1').update('app.css').digest('hex'))).toBeNull();
		expect(detectSecret(createHash('md5').update('logo.png').digest('hex'))).toBeNull();
		expect(findSecrets('/assets/index-BXk3p9Qa.js /assets/vendor-4f9a1c2e.css')).toEqual([]);
	});

	it('base64 image data URIs are not secrets', () => {
		const png = 'data:image/png;base64,' + Buffer.from('x'.repeat(40) + 'PNGDATA12345678'.repeat(30)).toString('base64');
		expect(findSecrets(png)).toEqual([]);
		expect(findSecrets(`<img src="${png}">`)).toEqual([]);
	});

	it('plain identifiers, paths and prose are not secrets', () => {
		for (const s of [
			'thisIsAVeryLongCamelCaseIdentifierName',
			'/src/components/fixtures/LeakyRequests.svelte',
			'node_modules/.vite/deps/chunk-ABCDEF12.js',
			'The quick brown fox jumps over the lazy dog 12 times',
			'publishable pk_live_0000FAKE0000FAKE0000',
			'sk_live_short'
		]) {
			expect(findSecrets(s), s).toEqual([]);
		}
	});

	it('random-looking mixed tokens are only low-confidence (generic entropy)', () => {
		const m = detectSecret(FAKE.entropy);
		expect(m?.kind).toBe('high-entropy');
		expect(m?.confidence).toBe('low');
		expect(detectSecret(FAKE.entropy, { entropy: false })).toBeNull();
	});

	it('shannonEntropy', () => {
		expect(shannonEntropy('')).toBe(0);
		expect(shannonEntropy('aaaa')).toBe(0);
		expect(shannonEntropy('abcd')).toBeCloseTo(2);
		expect(shannonEntropy(FAKE.entropy)).toBeGreaterThan(4);
	});
});

describe('secret-rules: sensitive key names', () => {
	it('flags the sensitive names in any casing/separator', () => {
		const cases: [string, string][] = [
			['password', 'password'],
			['user_password', 'password'],
			['passwd', 'password'],
			['passwordHash', 'password'],
			['hash', 'hash'],
			['clientSecret', 'secret'],
			['SECRET_KEY', 'secret'],
			['token', 'token'],
			['access_token', 'token'],
			['refreshToken', 'token'],
			['apiKey', 'api-key'],
			['api_key', 'api-key'],
			['X-API-Key', 'api-key'],
			['Authorization', 'authorization'],
			['ssn', 'ssn'],
			['userSsn', 'ssn'],
			['creditCard', 'credit-card'],
			['card_number', 'credit-card'],
			['cvv', 'cvv'],
			['privateKey', 'private-key'],
			['private_key', 'private-key'],
			['sessionid', 'session'],
			['jwt', 'jwt']
		];
		for (const [name, kind] of cases) expect(sensitiveKeyKind(name), name).toBe(kind);
	});

	it('does not flag ordinary names or token counts', () => {
		for (const name of [
			'name',
			'email',
			'id',
			'title',
			'max_tokens',
			'inputTokens',
			'totalTokens',
			'contentHash',
			'commitHash',
			'lessons',
			'session_count',
			''
		]) {
			expect(sensitiveKeyKind(name), name).toBeNull();
		}
	});

	it('placeholders are not meaningful values', () => {
		expect(isMeaningfulSecretValue('hunter2-real')).toBe(true);
		for (const v of ['', '***', 'REDACTED', 'null', 'xxxx', 'abc', 42, null]) {
			expect(isMeaningfulSecretValue(v), String(v)).toBe(false);
		}
	});
});

describe('secret-rules: sha256 + redaction', () => {
	it('sha256Hex matches node:crypto (ASCII, UTF-8, multi-block)', () => {
		expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
		for (const s of ['héllo wörld ✓ 😀', 'x'.repeat(55), 'y'.repeat(64), 'z'.repeat(1000), FAKE.jwt]) {
			expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
		}
		expect(utf8Length('é😀')).toBe(Buffer.byteLength('é😀'));
	});

	it('redact shows kind, at most 4 chars, length and a sha prefix, never the value', () => {
		const r = redact(FAKE.jwt);
		expect(r).toBe(`jwt:eyJh…(len ${FAKE.jwt.length}, sha ${sha256Hex(FAKE.jwt).slice(0, 6)})`);
		expect(r).not.toContain(FAKE.jwt);
		expect(redact(FAKE.stripeLive)).toMatch(/^stripe-secret-key:sk_l…\(len \d+, sha [0-9a-f]{6}\)$/);
		expect(redact('hunter2pw', 'password')).toMatch(/^password:hu…\(len 9, sha [0-9a-f]{6}\)$/);
		expect(redact('abc', 'password')).toMatch(/^password:…\(len 3, sha [0-9a-f]{6}\)$/);
		expect(redactionPrefixLength(16)).toBe(4);
		expect(redactionPrefixLength(15)).toBe(2);
		expect(redactionPrefixLength(7)).toBe(0);
		// Same value -> same redaction (agents can match occurrences).
		expect(redact(FAKE.aws)).toBe(redact(FAKE.aws));
	});

	it('redactText replaces every secret and keeps the rest', () => {
		const text = `token=${FAKE.jwt} key=${FAKE.aws} ok`;
		const out = redactText(text);
		for (const secret of [FAKE.jwt, FAKE.aws]) expect(out).not.toContain(secret);
		expect(out).toMatch(/^token=jwt:eyJh…\(len \d+, sha [0-9a-f]{6}\) key=aws-access-key:AKIA…/);
		expect(out.endsWith(' ok')).toBe(true);
	});

	it('redactUrl: query/fragment values by shape or by sensitive name, path secrets, userinfo', () => {
		const url = `https://api.example.com/v1/${FAKE.ghp}/items?api_key=${FAKE.stripeTest}&page=2&password=hunter2pw&q=shoes#access_token=${FAKE.jwt}`;
		const { redacted, hits } = redactUrl(url);
		for (const secret of [FAKE.ghp, FAKE.stripeTest, 'hunter2pw', FAKE.jwt]) expect(redacted).not.toContain(secret);
		expect(redacted).toContain('page=2');
		expect(redacted).toContain('q=shoes');
		expect(hits.map((h) => [h.location, h.key, h.kind, h.shaped])).toEqual([
			['path', undefined, 'github-token', true],
			['query', 'api_key', 'stripe-secret-key', true],
			['query', 'password', 'password', false],
			['fragment', 'access_token', 'jwt', true]
		]);
		const withUser = redactUrl('https://admin:s3cretpass@db.example.com/x');
		expect(withUser.redacted).not.toContain('s3cretpass');
		expect(withUser.hits[0]).toMatchObject({ location: 'userinfo', kind: 'password' });
		expect(redactUrl('/plain/path?id=3f2b8c1e-9a4d-4e7f-b1c2-d3e4f5a6b7c8').hits).toEqual([]);
	});

	it('redactUrl decodes encoded values before matching', () => {
		const { redacted, hits } = redactUrl(`/x?auth=${encodeURIComponent('Bearer ' + FAKE.jwt)}`);
		expect(hits[0]).toMatchObject({ key: 'auth', kind: 'jwt' });
		expect(redacted).not.toContain(FAKE.jwt.slice(10));
	});
});

describe('secret-rules: structured values', () => {
	it('scanValue reports shaped strings and sensitive keys with paths', () => {
		const hits = scanValue({
			user: { id: 1, email: 'a@example.com', password_hash: '$2b$10$FAKEfakeFAKEfakeFAKEfake', ssn: 123456789 },
			session: { access_token: FAKE.jwt },
			items: [{ note: `key ${FAKE.aws}` }],
			csrf: 'short'
		});
		expect(hits.map((h) => [h.path, h.kind, h.shaped])).toEqual([
			['user.password_hash', 'password', false],
			['user.ssn', 'ssn', false],
			['session.access_token', 'jwt', true],
			['items[0].note', 'aws-access-key', true]
		]);
		for (const h of hits) expect(h.redacted).not.toContain('FAKEfakeFAKEfake');
	});

	it('scanValue survives cycles and caps depth', () => {
		const a: Record<string, unknown> = { token: 'abcdefgh-fake' };
		a.self = a;
		expect(scanValue(a)).toHaveLength(1);
		let deep: Record<string, unknown> = { password: 'deep-secret-value' };
		for (let i = 0; i < 20; i++) deep = { child: deep };
		expect(scanValue(deep)).toEqual([]);
	});

	it('unflattenDevalue resolves SvelteKit __data.json nodes', () => {
		// devalue.stringify({ user: { name: 'Ada', password: 'fake-pass-123' } })
		const flat = [{ user: 1 }, { name: 2, password: 3 }, 'Ada', 'fake-pass-123'];
		expect(unflattenDevalue(flat)).toEqual({ user: { name: 'Ada', password: 'fake-pass-123' } });
		expect(scanValue(unflattenDevalue(flat)).map((h) => h.path)).toEqual(['user.password']);
		expect(unflattenDevalue('nope')).toBeNull();
	});
});
