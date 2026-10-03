/**
 * FAKE credentials for the LeakyRequests fixture (ui_network /
 * ui_security_scan). None of these is a real key or token. They are assembled
 * at runtime so the repository never contains a literal that secret scanners
 * would flag. e2e/network.spec.ts imports them to assert that tool output
 * never contains them (mandatory redaction).
 */

function base64url(text: string): string {
	return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Stripe-shaped test key, clearly fake. */
export const FAKE_API_KEY = 'sk_' + 'test_' + 'FAKEplaygroundKEYnotREAL0000';

/** JWT-shaped token, clearly fake (payload says so, signature is not a signature). */
export const FAKE_JWT = [
	base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
	base64url(
		JSON.stringify({
			sub: 'FAKE-user-do-not-use',
			note: 'fake token for the svelte-grab playground',
			iat: 1700000000
		})
	),
	'FAKE_SIGNATURE_not_a_real_token'
].join('.');

/** Fake third-party collector (intercepted by Playwright in e2e; fails offline otherwise). */
export const FAKE_THIRD_PARTY_URL = 'https://third-party.example/collect';

/** localStorage key the fixture writes the fake JWT to. */
export const FAKE_STORAGE_KEY = 'fake-auth-token';
