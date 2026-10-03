/**
 * Shared setup for tests/audit*.test.ts: copies tests/fixtures/audit-app to
 * a temp dir and swaps the secret placeholders for fake values assembled at
 * runtime (prefix + body), so the repository never holds a literal that
 * secret scanners / push protection would flag. None of them is a real key.
 */
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'audit-app');

const b64url = (s: string) => Buffer.from(s).toString('base64url');
const fakeJwt = (payload: Record<string, unknown>) =>
	`${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.FAKEsignatureFAKEsignature0123`;

export const FAKE = {
	stripe: 'sk_' + 'live_' + 'FAKEfake0000FAKEfake0000',
	aws: 'AKIA' + 'FAKE0EXAMPLE0KEY',
	serviceRole: fakeJwt({ iss: 'supabase', role: 'service_role', iat: 1700000000 }),
	anonJwt: fakeJwt({ iss: 'supabase', role: 'anon', iat: 1700000000 })
};

const PLACEHOLDERS: [string, string][] = [
	['__FAKE_STRIPE__', FAKE.stripe],
	['__FAKE_AWS__', FAKE.aws],
	['__FAKE_SERVICE_ROLE__', FAKE.serviceRole],
	['__FAKE_ANON_JWT__', FAKE.anonJwt]
];

function fillPlaceholders(dir: string): void {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			fillPlaceholders(path);
			continue;
		}
		let text = readFileSync(path, 'utf-8');
		for (const [from, to] of PLACEHOLDERS) text = text.split(from).join(to);
		writeFileSync(path, text);
	}
}

const created: string[] = [];

/** Temp copy of the fixture app with real-shaped fake secrets and ignored/oversized extras. */
export function makeFixtureApp(): string {
	const dir = mkdtempSync(join(tmpdir(), 'svelte-grab-audit-'));
	created.push(dir);
	cpSync(FIXTURE_DIR, dir, { recursive: true });
	renameSync(join(dir, '_gitignore'), join(dir, '.gitignore'));
	renameSync(join(dir, 'env.fixture'), join(dir, '.env'));
	fillPlaceholders(dir);

	// Default-ignored directories: offending content must not be reported.
	for (const ignored of ['node_modules/evil', 'dist', '.svelte-kit/output', 'build', 'coverage']) {
		mkdirSync(join(dir, ignored), { recursive: true });
		writeFileSync(join(dir, ignored, 'index.js'), `eval(x);\nexport const k = '${FAKE.stripe}';\n`);
	}
	// Over the 1 MB limit: skipped, not scanned.
	writeFileSync(
		join(dir, 'src', 'lib', 'huge.ts'),
		`eval(x);\n// ${'x'.repeat(1024 * 1024 + 10)}\n`
	);
	return dir;
}

/** A temp project with the given files. */
export function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'svelte-grab-audit-'));
	created.push(dir);
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(join(dir, rel, '..'), { recursive: true });
		writeFileSync(join(dir, rel), text);
	}
	return dir;
}

export function cleanupFixtures(): void {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}
