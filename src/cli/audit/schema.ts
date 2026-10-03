/**
 * JSON Schema (draft 2020-12) of the `svelte-grab audit --json` report, and a
 * zero-dependency validator for the subset of keywords it uses.
 *
 * `finding-schema.json` next to this file is the same schema as a standalone
 * document (shipped with the audit skill); tests/audit-schema.test.ts keeps
 * the two identical. This constant is what the CLI validates against, so the
 * schema works from `dist/` without copying JSON assets.
 */
import { RULE_IDS, SEVERITIES, VERDICTS } from './types.js';

export const FINDING_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id: 'https://github.com/HeiCg/svelte-grab/schemas/audit-report.json',
	title: 'svelte-grab audit report',
	type: 'object',
	required: [
		'schemaVersion',
		'tool',
		'root',
		'generatedAt',
		'durationMs',
		'filesScanned',
		'filesSkipped',
		'minSeverity',
		'failed',
		'summary',
		'findings',
		'notes'
	],
	additionalProperties: false,
	properties: {
		schemaVersion: { const: 1 },
		tool: { const: 'svelte-grab audit' },
		root: { type: 'string', minLength: 1 },
		generatedAt: { type: 'string', format: 'date-time', pattern: '^\\d{4}-\\d{2}-\\d{2}T' },
		durationMs: { type: 'integer', minimum: 0 },
		filesScanned: { type: 'integer', minimum: 0 },
		filesSkipped: { type: 'integer', minimum: 0 },
		minSeverity: { enum: ['high', 'medium', 'low'] },
		failed: { type: 'boolean' },
		summary: {
			type: 'object',
			required: ['total', 'bySeverity', 'byVerdict'],
			additionalProperties: false,
			properties: {
				total: { type: 'integer', minimum: 0 },
				bySeverity: {
					type: 'object',
					required: [...SEVERITIES],
					additionalProperties: false,
					properties: Object.fromEntries(SEVERITIES.map((s) => [s, { type: 'integer', minimum: 0 }]))
				},
				byVerdict: {
					type: 'object',
					required: [...VERDICTS],
					additionalProperties: false,
					properties: Object.fromEntries(VERDICTS.map((v) => [v, { type: 'integer', minimum: 0 }]))
				}
			}
		},
		findings: { type: 'array', items: { $ref: '#/$defs/finding' } },
		notes: { type: 'array', items: { type: 'string' } }
	},
	$defs: {
		finding: {
			type: 'object',
			required: ['id', 'rule', 'severity', 'verdict', 'title', 'evidence', 'file', 'line', 'column', 'source', 'fix'],
			additionalProperties: false,
			properties: {
				id: { type: 'string', pattern: '^[a-z0-9-]+/[a-z0-9-]+:[0-9a-f]{6}$' },
				rule: { enum: [...RULE_IDS] },
				severity: { enum: [...SEVERITIES] },
				verdict: { enum: [...VERDICTS] },
				title: { type: 'string', minLength: 1 },
				evidence: { type: 'string', description: 'Redacted: never a full secret.' },
				file: { type: 'string', minLength: 1 },
				line: { type: 'integer', minimum: 1 },
				column: { type: 'integer', minimum: 1 },
				source: { type: 'string', pattern: '^.+:\\d+:\\d+$' },
				fix: { type: 'string', minLength: 1 }
			}
		}
	}
} as const;

type Schema = Record<string, unknown>;

export interface ValidationResult {
	valid: boolean;
	/** `"<json pointer>: <message>"`. */
	errors: string[];
}

function typeOf(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
	return typeof value;
}

function typeMatches(value: unknown, type: string): boolean {
	const actual = typeOf(value);
	return actual === type || (type === 'number' && actual === 'integer');
}

function resolveRef(root: Schema, ref: string): Schema {
	if (!ref.startsWith('#/')) throw new Error(`Unsupported $ref ${ref}`);
	let node: unknown = root;
	for (const part of ref.slice(2).split('/')) node = (node as Schema)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
	if (!node || typeof node !== 'object') throw new Error(`Unresolvable $ref ${ref}`);
	return node as Schema;
}

/**
 * Validate `value` against a JSON Schema using the keywords this package's
 * schemas use: `$ref` (local), `type`, `const`, `enum`, `required`,
 * `properties`, `additionalProperties` (boolean), `items`, `minLength`,
 * `pattern`, `minimum`. Unknown keywords (`format`, `description`, ...) are
 * annotations and ignored.
 */
export function validateAgainstSchema(value: unknown, schema: Schema, root: Schema = schema): ValidationResult {
	const errors: string[] = [];
	const check = (v: unknown, s: Schema, path: string): void => {
		if (typeof s.$ref === 'string') {
			check(v, resolveRef(root, s.$ref), path);
			return;
		}
		const at = path || '/';
		if ('const' in s && v !== s.const) errors.push(`${at}: must equal ${JSON.stringify(s.const)}`);
		if (Array.isArray(s.enum) && !s.enum.includes(v as never)) errors.push(`${at}: must be one of ${s.enum.join(', ')}`);
		if (s.type !== undefined) {
			const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
			if (!types.some((t) => typeMatches(v, t))) {
				errors.push(`${at}: must be ${types.join(' | ')}, got ${typeOf(v)}`);
				return;
			}
		}
		if (typeof v === 'string') {
			if (typeof s.minLength === 'number' && v.length < s.minLength) errors.push(`${at}: shorter than ${s.minLength}`);
			if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(v)) errors.push(`${at}: does not match ${s.pattern}`);
		}
		if (typeof v === 'number' && typeof s.minimum === 'number' && v < s.minimum) errors.push(`${at}: below ${s.minimum}`);
		if (Array.isArray(v) && s.items && typeof s.items === 'object') {
			v.forEach((item, i) => check(item, s.items as Schema, `${path}/${i}`));
		}
		if (typeOf(v) === 'object') {
			const obj = v as Record<string, unknown>;
			const props = (s.properties ?? {}) as Record<string, Schema>;
			if (Array.isArray(s.required)) {
				for (const key of s.required as string[]) if (!(key in obj)) errors.push(`${at}: missing required "${key}"`);
			}
			for (const [key, child] of Object.entries(obj)) {
				if (key in props) check(child, props[key], `${path}/${key}`);
				else if (s.additionalProperties === false) errors.push(`${at}: unexpected property "${key}"`);
			}
		}
	};
	check(value, schema, '');
	return { valid: errors.length === 0, errors };
}

/** Validate an audit report (the `--json` output) against {@link FINDING_SCHEMA}. */
export function validateAuditReport(report: unknown): ValidationResult {
	return validateAgainstSchema(report, FINDING_SCHEMA as unknown as Schema);
}
