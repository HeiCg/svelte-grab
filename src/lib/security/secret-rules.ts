/**
 * Shared secret-detection rules and mandatory redaction
 * (docs/agent-runtime-spec.md, Phase 9: `ui_network`, `ui_security_scan`, and
 * later the static `svelte-grab audit` scanner).
 *
 * Pure TypeScript: no DOM, no browser-only globals, no Node APIs, so the same
 * module runs in the page runtime and in Node. SHA-256 is implemented here
 * (synchronous) so every API stays sync.
 *
 * - {@link findSecrets}: every secret-shaped substring of a text, most
 *   specific rule first (private keys, JWT, provider key formats, Bearer,
 *   then generic high-entropy tokens).
 * - {@link detectSecret}: the first secret in a single value.
 * - {@link sensitiveKeyKind}: whether a property / parameter / header NAME is
 *   sensitive (`password`, `apiKey`, `token`, ...).
 * - {@link redact}: `kind:abcd…(len N, sha xxxxxx)`. Never the full value:
 *   at most the first 4 characters (2 for values shorter than 16, none below
 *   8), the length and a 6-hex SHA-256 prefix so occurrences can be matched.
 * - {@link redactText} / {@link redactUrl}: the same applied to free text and
 *   to URLs (query, fragment, path, userinfo).
 *
 * Confidence: `high` for formats specific to a provider (or a JWT), `low` for
 * the generic entropy rule. Callers map it to a severity / verdict.
 */

export type SecretKind =
	| 'private-key'
	| 'jwt'
	| 'supabase-service-role'
	| 'aws-access-key'
	| 'gcp-api-key'
	| 'stripe-secret-key'
	| 'stripe-restricted-key'
	| 'github-token'
	| 'anthropic-key'
	| 'openai-key'
	| 'slack-token'
	| 'slack-webhook'
	| 'bearer'
	| 'high-entropy';

export type SecretConfidence = 'high' | 'low';

export interface SecretRule {
	kind: SecretKind;
	/** Human label, e.g. "Stripe secret key". */
	label: string;
	confidence: SecretConfidence;
	/** Global regex. Capture group 1, when present, is the secret itself. */
	pattern: RegExp;
	/** Extra check on the secret (e.g. a JWT header must decode). */
	validate?: (secret: string) => boolean;
	/** Narrower kind after inspecting the secret (JWT -> Supabase service role). */
	refine?: (secret: string) => SecretKind;
}

export interface SecretMatch {
	kind: SecretKind;
	label: string;
	confidence: SecretConfidence;
	/** The secret. Internal only: never print it, print `redacted`. */
	value: string;
	/** Offsets of `value` in the scanned text. */
	start: number;
	end: number;
	redacted: string;
}

/** Generic rule: minimum token length. */
export const MIN_ENTROPY_LENGTH = 24;
/** Generic rule: longer tokens are data (base64 images, bundles), not keys. */
export const MAX_ENTROPY_LENGTH = 256;
/** Generic rule: Shannon entropy threshold in bits per character. */
export const ENTROPY_THRESHOLD = 4.0;

const LABELS: Record<SecretKind, string> = {
	'private-key': 'Private key',
	jwt: 'JWT',
	'supabase-service-role': 'Supabase service_role JWT',
	'aws-access-key': 'AWS access key id',
	'gcp-api-key': 'Google API key',
	'stripe-secret-key': 'Stripe secret key',
	'stripe-restricted-key': 'Stripe restricted key',
	'github-token': 'GitHub token',
	'anthropic-key': 'Anthropic API key',
	'openai-key': 'OpenAI API key',
	'slack-token': 'Slack token',
	'slack-webhook': 'Slack webhook URL',
	bearer: 'Bearer token',
	'high-entropy': 'High-entropy string'
};

export function secretLabel(kind: SecretKind): string {
	return LABELS[kind];
}

// ------------------------------------------------------------------ base64 / JWT

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decode base64 / base64url to a (latin1 -> UTF-8 decoded) string, or `null`. */
export function decodeBase64Url(input: string): string | null {
	const s = input.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
	if (!/^[A-Za-z0-9+/]*$/.test(s) || s.length % 4 === 1) return null;
	const bytes: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (const ch of s) {
		buffer = (buffer << 6) | B64.indexOf(ch);
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((buffer >> bits) & 0xff);
		}
	}
	return utf8Decode(bytes);
}

function utf8Decode(bytes: number[]): string {
	let out = '';
	for (let i = 0; i < bytes.length; ) {
		const b = bytes[i++];
		let cp: number;
		if (b < 0x80) cp = b;
		else if (b >= 0xc0 && b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
		else if (b >= 0xe0 && b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
		else
			cp =
				((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
		out += String.fromCodePoint(Number.isFinite(cp) && cp <= 0x10ffff ? cp : 0xfffd);
	}
	return out;
}

/** Decoded JWT header + payload, or `null` when `token` is not a JWT. */
export function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } | null {
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	try {
		const header = JSON.parse(decodeBase64Url(parts[0]) ?? '');
		const payload = JSON.parse(decodeBase64Url(parts[1]) ?? '');
		if (!header || typeof header !== 'object' || typeof header.alg !== 'string') return null;
		if (!payload || typeof payload !== 'object') return null;
		return { header, payload };
	} catch {
		return null;
	}
}

// ------------------------------------------------------------------ rules

/** Rules in priority order: on overlapping matches the earlier rule wins. */
export const SECRET_RULES: readonly SecretRule[] = Object.freeze([
	{
		kind: 'private-key',
		label: LABELS['private-key'],
		confidence: 'high',
		pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g
	},
	{
		kind: 'jwt',
		label: LABELS.jwt,
		confidence: 'high',
		pattern: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
		validate: (s) => decodeJwt(s) !== null,
		refine: (s) => (decodeJwt(s)?.payload.role === 'service_role' ? 'supabase-service-role' : 'jwt')
	},
	{
		kind: 'slack-webhook',
		label: LABELS['slack-webhook'],
		confidence: 'high',
		pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]+/g
	},
	{
		kind: 'aws-access-key',
		label: LABELS['aws-access-key'],
		confidence: 'high',
		pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g
	},
	{
		kind: 'gcp-api-key',
		label: LABELS['gcp-api-key'],
		confidence: 'high',
		pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g
	},
	{
		kind: 'stripe-secret-key',
		label: LABELS['stripe-secret-key'],
		confidence: 'high',
		pattern: /\bsk_(?:live|test)_[0-9A-Za-z]{10,}\b/g
	},
	{
		kind: 'stripe-restricted-key',
		label: LABELS['stripe-restricted-key'],
		confidence: 'high',
		pattern: /\brk_(?:live|test)_[0-9A-Za-z]{10,}\b/g
	},
	{
		kind: 'github-token',
		label: LABELS['github-token'],
		confidence: 'high',
		pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g
	},
	{
		kind: 'anthropic-key',
		label: LABELS['anthropic-key'],
		confidence: 'high',
		pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g
	},
	{
		kind: 'openai-key',
		label: LABELS['openai-key'],
		confidence: 'high',
		pattern: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g
	},
	{
		kind: 'slack-token',
		label: LABELS['slack-token'],
		confidence: 'high',
		pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g
	},
	{
		kind: 'bearer',
		label: LABELS.bearer,
		confidence: 'high',
		pattern: /\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/gi
	}
]);

// ------------------------------------------------------------------ entropy

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
	if (!value) return 0;
	const counts = new Map<string, number>();
	for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	const len = [...value].length;
	let h = 0;
	for (const n of counts.values()) {
		const p = n / len;
		h -= p * Math.log2(p);
	}
	return h;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]+$/i;

/**
 * Whether a token passes the generic high-entropy rule. Excluded on purpose:
 * UUIDs, pure hex (content hashes, digests, ids), paths, tokens without at
 * least two digits and a letter, and anything longer than
 * {@link MAX_ENTROPY_LENGTH} (base64 images and other data).
 */
export function isHighEntropyToken(token: string): boolean {
	if (token.length < MIN_ENTROPY_LENGTH || token.length > MAX_ENTROPY_LENGTH) return false;
	if (UUID.test(token) || HEX.test(token)) return false;
	if ((token.match(/\//g) ?? []).length > 1) return false;
	const digits = (token.match(/[0-9]/g) ?? []).length;
	const lower = /[a-z]/.test(token);
	const upper = /[A-Z]/.test(token);
	if (digits < 2 || !(lower || upper)) return false;
	if (!(lower && upper) && token.length < 32) return false;
	return shannonEntropy(token) >= ENTROPY_THRESHOLD;
}

const ENTROPY_TOKEN = /[A-Za-z0-9+/_=-]{24,}/g;

// ------------------------------------------------------------------ scanning

export interface FindSecretsOptions {
	/** Include the generic high-entropy rule (default true). */
	entropy?: boolean;
}

/** Every secret-shaped substring of `text`, in text order, overlaps removed. */
export function findSecrets(text: string, options: FindSecretsOptions = {}): SecretMatch[] {
	if (typeof text !== 'string' || text.length < 8) return [];
	const found: SecretMatch[] = [];
	const overlaps = (start: number, end: number) => found.some((m) => start < m.end && end > m.start);

	for (const rule of SECRET_RULES) {
		rule.pattern.lastIndex = 0;
		for (const m of text.matchAll(rule.pattern)) {
			const value = m[1] ?? m[0];
			const start = (m.index ?? 0) + (m[1] !== undefined ? m[0].indexOf(m[1]) : 0);
			const end = start + value.length;
			if (overlaps(start, end)) continue;
			if (rule.validate && !rule.validate(value)) continue;
			const kind = rule.refine ? rule.refine(value) : rule.kind;
			found.push({
				kind,
				label: LABELS[kind],
				confidence: rule.confidence,
				value,
				start,
				end,
				redacted: redact(value, kind)
			});
		}
	}

	if (options.entropy !== false) {
		for (const m of text.matchAll(ENTROPY_TOKEN)) {
			const start = m.index ?? 0;
			// `base64,` prefix: a data: URI payload, never a key.
			if (text.slice(Math.max(0, start - 7), start) === 'base64,') continue;
			const token = m[0];
			const end = start + token.length;
			if (overlaps(start, end) || !isHighEntropyToken(token)) continue;
			found.push({
				kind: 'high-entropy',
				label: LABELS['high-entropy'],
				confidence: 'low',
				value: token,
				start,
				end,
				redacted: redact(token, 'high-entropy')
			});
		}
	}

	return found.sort((a, b) => a.start - b.start);
}

/** The first (most specific) secret in a single value, or `null`. */
export function detectSecret(value: string, options: FindSecretsOptions = {}): SecretMatch | null {
	const all = findSecrets(value, options);
	if (all.length === 0) return null;
	return all.find((m) => m.confidence === 'high') ?? all[0];
}

// ------------------------------------------------------------------ key names

export type SensitiveKeyKind =
	| 'password'
	| 'secret'
	| 'token'
	| 'api-key'
	| 'private-key'
	| 'authorization'
	| 'ssn'
	| 'credit-card'
	| 'cvv'
	| 'hash'
	| 'session'
	| 'jwt';

/** Normalized names that contain "token" but are counts/limits (LLM usage). */
const TOKEN_FALSE_POSITIVES =
	/maxtokens|tokencount|tokensused|tokenlimit|tokenizer|tokenize|inputtokens|outputtokens|totaltokens|completiontokens|prompttokens|cachedtokens|tokenusage/;
/** `*hash` names that are content hashes, not secrets. */
const HASH_FALSE_POSITIVES = /^(content|file|asset|commit|git|build|etag|route|url|location|integrity|chunk|module|cache)hash$/;

const KEY_RULES: [SensitiveKeyKind, RegExp][] = [
	['private-key', /privatekey|privkey/],
	['api-key', /apikey|apisecret|accesskey(id)?$|xapikey/],
	['password', /password|passwd|passphrase|^pwd$|^pass$/],
	['secret', /secret/],
	['jwt', /jwt/],
	['authorization', /^authorization$|^auth$|^authheader$|^proxyauthorization$/],
	['token', /token/],
	['ssn', /ssn$|socialsecurity/],
	['credit-card', /creditcard|cardnumber|^ccnumber$|^ccnum$|^pan$/],
	['cvv', /^cvv2?$|^cvc2?$|^csc$|cardcvv|cardcvc|securitycode$/],
	['hash', /hash$/],
	['session', /^session(id|token|key)?$|^sid$|sessid|connectsid/]
];

/** Lowercase, alphanumerics only: `api_key`, `apiKey`, `API-KEY` -> `apikey`. */
export function normalizeKeyName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The sensitive category of a property / parameter / header name, or `null`. */
export function sensitiveKeyKind(name: string): SensitiveKeyKind | null {
	if (typeof name !== 'string' || !name) return null;
	const n = normalizeKeyName(name);
	if (!n) return null;
	for (const [kind, re] of KEY_RULES) {
		if (!re.test(n)) continue;
		if (kind === 'token' && TOKEN_FALSE_POSITIVES.test(n)) continue;
		if (kind === 'hash' && HASH_FALSE_POSITIVES.test(n)) continue;
		return kind;
	}
	return null;
}

/** Values that are clearly placeholders, not credentials. */
const PLACEHOLDER = /^(?:\*+|x+|•+|null|undefined|none|redacted|\[redacted\]|<redacted>|true|false|changeme|example|placeholder)$/i;

/**
 * Whether a value stored under a sensitive key is worth reporting: a string
 * of at least `minLength` characters that is not a placeholder.
 */
export function isMeaningfulSecretValue(value: unknown, minLength = 4): value is string {
	return typeof value === 'string' && value.trim().length >= minLength && !PLACEHOLDER.test(value.trim());
}

// ------------------------------------------------------------------ SHA-256

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
	0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
	0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
	0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
	0xc67178f2
]);

function utf8Encode(value: string): number[] {
	const out: number[] = [];
	for (const ch of value) {
		const cp = ch.codePointAt(0)!;
		if (cp < 0x80) out.push(cp);
		else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
		else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
		else
			out.push(
				0xf0 | (cp >> 18),
				0x80 | ((cp >> 12) & 0x3f),
				0x80 | ((cp >> 6) & 0x3f),
				0x80 | (cp & 0x3f)
			);
	}
	return out;
}

/** UTF-8 byte length of a string. */
export function utf8Length(value: string): number {
	let n = 0;
	for (const ch of value) {
		const cp = ch.codePointAt(0)!;
		n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
	}
	return n;
}

/** Synchronous SHA-256 of the UTF-8 encoding of `value`, as lowercase hex. */
export function sha256Hex(value: string): string {
	const bytes = utf8Encode(value);
	const bitLen = bytes.length * 8;
	bytes.push(0x80);
	while (bytes.length % 64 !== 56) bytes.push(0);
	const hi = Math.floor(bitLen / 0x100000000);
	const lo = bitLen >>> 0;
	bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
	bytes.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

	const h = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
	]);
	const w = new Uint32Array(64);
	const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
	for (let off = 0; off < bytes.length; off += 64) {
		for (let i = 0; i < 16; i++) {
			const j = off + i * 4;
			w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
		}
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
			const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, hh] = h;
		for (let i = 0; i < 64; i++) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
			const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (S0 + maj) >>> 0;
			hh = g;
			g = f;
			f = e;
			e = (d + t1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) >>> 0;
		}
		h[0] = (h[0] + a) >>> 0;
		h[1] = (h[1] + b) >>> 0;
		h[2] = (h[2] + c) >>> 0;
		h[3] = (h[3] + d) >>> 0;
		h[4] = (h[4] + e) >>> 0;
		h[5] = (h[5] + f) >>> 0;
		h[6] = (h[6] + g) >>> 0;
		h[7] = (h[7] + hh) >>> 0;
	}
	return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
}

// ------------------------------------------------------------------ redaction

/** Characters of the secret shown in a redaction (4, 2 below 16 chars, 0 below 8). */
export function redactionPrefixLength(length: number): number {
	return length >= 16 ? 4 : length >= 8 ? 2 : 0;
}

/**
 * `kind:abcd…(len N, sha xxxxxx)`. `kind` defaults to the detected secret kind,
 * else `secret`. Never contains the full value.
 */
export function redact(value: string, kind?: string): string {
	const v = String(value);
	const k = kind ?? detectSecret(v, { entropy: false })?.kind ?? 'secret';
	const prefix = v.slice(0, redactionPrefixLength(v.length));
	return `${k}:${prefix}…(len ${v.length}, sha ${sha256Hex(v).slice(0, 6)})`;
}

/** `text` with every secret found by {@link findSecrets} replaced by its redaction. */
export function redactText(text: string, options: FindSecretsOptions = {}): string {
	const matches = findSecrets(text, options);
	if (matches.length === 0) return text;
	let out = '';
	let pos = 0;
	for (const m of matches) {
		out += text.slice(pos, m.start) + m.redacted;
		pos = m.end;
	}
	return out + text.slice(pos);
}

export type UrlSecretLocation = 'query' | 'fragment' | 'path' | 'userinfo';

export interface UrlSecretHit {
	location: UrlSecretLocation;
	/** Parameter name (query / fragment params). */
	key?: string;
	/** Secret kind, or the sensitive key category when only the name gave it away. */
	kind: string;
	confidence: SecretConfidence;
	/** True when the value matched a secret rule; false when only the key name is sensitive. */
	shaped: boolean;
	redacted: string;
}

export interface UrlScan {
	redacted: string;
	hits: UrlSecretHit[];
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value.replace(/\+/g, ' '));
	} catch {
		return value;
	}
}

function scanParams(part: string, location: 'query' | 'fragment', hits: UrlSecretHit[]): string {
	return part
		.split('&')
		.map((pair) => {
			const eq = pair.indexOf('=');
			if (eq <= 0) return pair;
			const rawKey = pair.slice(0, eq);
			const rawValue = pair.slice(eq + 1);
			const key = safeDecode(rawKey);
			const value = safeDecode(rawValue);
			const shaped = detectSecret(value);
			const keyKind = sensitiveKeyKind(key);
			if (shaped) {
				hits.push({ location, key, kind: shaped.kind, confidence: shaped.confidence, shaped: true, redacted: shaped.redacted });
				return `${rawKey}=${shaped.redacted}`;
			}
			if (keyKind && isMeaningfulSecretValue(value)) {
				const r = redact(value, keyKind);
				hits.push({ location, key, kind: keyKind, confidence: 'low', shaped: false, redacted: r });
				return `${rawKey}=${r}`;
			}
			return pair;
		})
		.join('&');
}

/**
 * Redact the secret parts of a URL: query and fragment parameter values that
 * are secret-shaped or sit under a sensitive name, high-confidence secrets in
 * the path, and the userinfo password. Works on absolute and relative URLs.
 */
export function redactUrl(url: string): UrlScan {
	const hits: UrlSecretHit[] = [];
	let rest = String(url);
	let fragment = '';
	const hashAt = rest.indexOf('#');
	if (hashAt !== -1) {
		fragment = rest.slice(hashAt + 1);
		rest = rest.slice(0, hashAt);
	}
	let query: string | null = null;
	const qAt = rest.indexOf('?');
	if (qAt !== -1) {
		query = rest.slice(qAt + 1);
		rest = rest.slice(0, qAt);
	}

	// userinfo: scheme://user:password@host
	rest = rest.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@:]*):([^/@]*)@/i, (_m, scheme: string, user: string, pass: string) => {
		if (!pass) return `${scheme}${user}:@`;
		const r = redact(safeDecode(pass), 'password');
		hits.push({ location: 'userinfo', kind: 'password', confidence: 'high', shaped: false, redacted: r });
		return `${scheme}${user}:${r}@`;
	});

	// path: only the specific (high-confidence) rules, never entropy.
	const pathMatches = findSecrets(rest, { entropy: false });
	if (pathMatches.length > 0) {
		let out = '';
		let pos = 0;
		for (const m of pathMatches) {
			out += rest.slice(pos, m.start) + m.redacted;
			pos = m.end;
			hits.push({ location: 'path', kind: m.kind, confidence: m.confidence, shaped: true, redacted: m.redacted });
		}
		rest = out + rest.slice(pos);
	}

	let out = rest;
	if (query !== null) out += '?' + scanParams(query, 'query', hits);
	if (hashAt !== -1) {
		out += '#' + (fragment.includes('=') ? scanParams(fragment, 'fragment', hits) : redactText(fragment));
	}
	return { redacted: out, hits };
}

// ------------------------------------------------------------------ structured values

export interface ValueSecretHit {
	/** Dotted path of the value, e.g. `user.password_hash` or `[2].token`. */
	path: string;
	/** Last key on the path (the property name). */
	key: string | null;
	kind: string;
	confidence: SecretConfidence;
	/** True when the value matched a secret rule; false when only the key name is sensitive. */
	shaped: boolean;
	redacted: string;
}

/**
 * Walk a JSON-like value (objects, arrays, strings) and report secret-shaped
 * strings and meaningful values under sensitive keys. Depth and node count
 * are bounded; cycles are skipped.
 */
export function scanValue(
	value: unknown,
	options: { maxDepth?: number; maxNodes?: number; entropy?: boolean } = {}
): ValueSecretHit[] {
	const maxDepth = options.maxDepth ?? 8;
	const maxNodes = options.maxNodes ?? 5_000;
	const hits: ValueSecretHit[] = [];
	const seen = new Set<object>();
	let nodes = 0;

	const visit = (v: unknown, path: string, key: string | null, depth: number): void => {
		if (++nodes > maxNodes) return;
		const keyKind = key !== null ? sensitiveKeyKind(key) : null;
		if (typeof v === 'string') {
			const shaped = detectSecret(v, { entropy: options.entropy });
			if (shaped) {
				hits.push({ path, key, kind: shaped.kind, confidence: shaped.confidence, shaped: true, redacted: shaped.redacted });
			} else if (keyKind && isMeaningfulSecretValue(v)) {
				hits.push({ path, key, kind: keyKind, confidence: 'low', shaped: false, redacted: redact(v, keyKind) });
			}
			return;
		}
		if (typeof v === 'number' && keyKind && (keyKind === 'ssn' || keyKind === 'credit-card' || keyKind === 'cvv')) {
			hits.push({ path, key, kind: keyKind, confidence: 'low', shaped: false, redacted: redact(String(v), keyKind) });
			return;
		}
		if (!v || typeof v !== 'object' || depth >= maxDepth || seen.has(v)) return;
		seen.add(v);
		if (Array.isArray(v)) {
			v.forEach((item, i) => visit(item, `${path}[${i}]`, key, depth + 1));
			return;
		}
		for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
			visit(child, path ? `${path}.${k}` : k, k, depth + 1);
		}
	};
	visit(value, '', null, 0);
	return hits;
}

/**
 * Resolve devalue's flattened JSON format (what SvelteKit's `__data.json`
 * nodes carry: `[root, ...values]` where object properties hold indices) into
 * key/value pairs, so {@link scanValue} sees real property names. Returns
 * `null` when `data` does not look flattened.
 */
export function unflattenDevalue(data: unknown): unknown {
	if (!Array.isArray(data) || data.length === 0) return null;
	const resolve = (index: unknown, depth: number, seen: Set<number>): unknown => {
		if (typeof index !== 'number' || !Number.isInteger(index)) return undefined;
		if (index < 0) return undefined; // devalue specials: undefined, NaN, ...
		if (index >= data.length || depth > 12 || seen.has(index)) return undefined;
		const raw = data[index];
		if (raw === null || typeof raw !== 'object') return raw;
		const next = new Set(seen).add(index);
		if (Array.isArray(raw)) {
			// Typed entries (["Date", ...], ["Map", ...]) carry string tags first.
			if (typeof raw[0] === 'string') return raw.slice(1).map((i) => resolve(i, depth + 1, next));
			return raw.map((i) => resolve(i, depth + 1, next));
		}
		const out: Record<string, unknown> = {};
		for (const [k, i] of Object.entries(raw as Record<string, unknown>)) out[k] = resolve(i, depth + 1, next);
		return out;
	};
	return resolve(0, 0, new Set());
}
