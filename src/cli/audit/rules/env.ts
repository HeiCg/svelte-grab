/**
 * `.env*` rule `env/public-secret`: values under client-exposed prefixes
 * (`PUBLIC_` for `$env/*\/public`, `VITE_` for `import.meta.env`) that look
 * like secrets. Those values are inlined into the client bundle.
 *
 * Supabase `anon` / `authenticated` JWTs are public by design and skipped;
 * a `service_role` JWT is high. Example files (`.env.example`, `.sample`,
 * `.template`) are reported as needs_validation (often placeholders).
 */
import {
	decodeJwt,
	findSecrets,
	isHighEntropyToken,
	isMeaningfulSecretValue,
	redact,
	sensitiveKeyKind
} from '../secrets.js';
import type { SourceFile } from '../types.js';
import { FindingSink } from './shared.js';

const PUBLIC_PREFIX = /^(PUBLIC_|VITE_)/;
const SECRET_NAMES = new Set(['secret', 'private-key', 'password']);

function unquote(raw: string): string {
	const v = raw.trim();
	const q = v[0];
	if ((q === '"' || q === "'" || q === '`') && v.length > 1) {
		const end = v.indexOf(q, 1);
		return end === -1 ? v.slice(1) : v.slice(1, end);
	}
	const hash = v.search(/\s#/);
	return (hash === -1 ? v : v.slice(0, hash)).trim();
}

export function envRules(file: SourceFile): FindingSink {
	const sink = new FindingSink(file);
	const example = /\.(?:example|sample|template|dist)$/.test(file.rel);
	let offset = 0;
	for (const line of file.text.split('\n')) {
		const lineStart = offset;
		offset += line.length + 1;
		const m = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)$/.exec(line);
		if (!m) continue;
		const [, key, raw] = m;
		const prefix = PUBLIC_PREFIX.exec(key);
		if (!prefix) continue;
		const value = unquote(raw.replace(/\r$/, ''));
		if (!value) continue;
		const at = lineStart + line.indexOf(key);
		const report = (
			severity: 'high' | 'medium' | 'low',
			confirmed: boolean,
			title: string,
			redacted: string
		) => {
			sink.add(
				'env/public-secret',
				at,
				severity,
				confirmed && !example ? 'confirmed' : 'needs_validation',
				title,
				`${key}=${redacted}`,
				`${prefix[1]} variables are inlined into the client bundle. Rename it without the prefix and read it on the server only ($env/static/private); rotate the credential.`
			);
		};

		const shaped = findSecrets(value, { entropy: false })[0];
		if (shaped) {
			if (shaped.kind === 'jwt') {
				const role = decodeJwt(shaped.value)?.payload.role;
				if (role === 'anon' || role === 'authenticated') continue;
				report('medium', false, `JWT in client-exposed env var ${key}`, shaped.redacted);
				continue;
			}
			const weak = shaped.kind === 'bearer';
			report(
				weak ? 'medium' : 'high',
				!weak,
				`${shaped.label} in client-exposed env var ${key}`,
				shaped.redacted
			);
			continue;
		}
		const nameKind = sensitiveKeyKind(key.slice(prefix[1].length));
		if (nameKind && SECRET_NAMES.has(nameKind) && isMeaningfulSecretValue(value, 8)) {
			report('high', false, `Secret-named client-exposed env var ${key}`, redact(value, nameKind));
			continue;
		}
		if ((nameKind === 'token' || nameKind === 'api-key') && isHighEntropyToken(value)) {
			report(
				'low',
				false,
				`Possible credential in client-exposed env var ${key}`,
				redact(value, nameKind)
			);
		}
	}
	return sink;
}
