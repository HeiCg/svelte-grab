/**
 * The audit's view of the shared secret rules.
 *
 * `src/lib/security/secret-rules.ts` is pure TypeScript (no DOM, no Node
 * APIs) and is the single source of truth for secret detection and
 * redaction, in the page runtime (`ui_network`, `ui_security_scan`) and here.
 * The server build (`tsc -p tsconfig.server.json`, rootDir `src`) follows this
 * import and emits it as `dist/lib/security/secret-rules.js`, next to the
 * copy `svelte-package` emits for the browser entry (`dist/security/`).
 */
export {
	detectSecret,
	findSecrets,
	isHighEntropyToken,
	isMeaningfulSecretValue,
	redact,
	redactText,
	sensitiveKeyKind,
	sha256Hex,
	decodeJwt,
	type SecretKind,
	type SecretMatch
} from '../../lib/security/secret-rules.js';
