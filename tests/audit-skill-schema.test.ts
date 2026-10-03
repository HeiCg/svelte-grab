import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateAgainstSchema } from '../src/cli/audit/schema';

const skillSchema = JSON.parse(
	readFileSync(new URL('../skills/svelte-grab-audit/finding-schema.json', import.meta.url), 'utf8')
);

describe('skill finding schema accepts svelte-grab audit findings', () => {
	it('validates a static finding and a runtime finding', () => {
		const report = {
			tool: 'svelte-grab audit',
			findings: [
				{
					id: 'secrets/client-exposure:abc123',
					rule: 'secrets/client-exposure',
					severity: 'high',
					verdict: 'confirmed',
					title: 'Stripe secret key in client-reachable code',
					evidence: "export const k = 'stripe-secret-key:sk_l…(len 32, sha 24a63e)';",
					file: 'src/lib/config.ts',
					line: 2,
					column: 27,
					source: 'src/lib/config.ts:2:27',
					fix: 'Move the key to $env/static/private and call the API from a server route.'
				},
				{
					id: 'token-in-url:513b60',
					severity: 'high',
					verdict: 'needs_validation',
					title: 'Secret in URL query parameter',
					evidence: 'api_key=stripe-secret-key:sk_t…(len 36, sha dd9910)',
					fix: 'Send it in a header from the server instead.'
				}
			]
		};
		const result = validateAgainstSchema(report, skillSchema);
		expect(result.errors ?? [], JSON.stringify(result)).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it('rejects a finding with an unknown severity (schema $ref is followed)', () => {
		const bad = {
			findings: [
				{ id: 'x', severity: 'critical', verdict: 'confirmed', title: 't', evidence: 'e', fix: 'f' }
			]
		};
		expect(validateAgainstSchema(bad, skillSchema).valid).toBe(false);
	});
});
