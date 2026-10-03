/**
 * Argument readers for runtime tools. Args arrive as untyped JSON from the
 * server; invalid values throw with a message the agent can act on.
 */

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value !== 'string') throw new Error(`"${key}" must be a string`);
	return value;
}

export function optionalInt(
	args: Record<string, unknown>,
	key: string,
	fallback: number,
	min: number,
	max: number
): number {
	const value = args[key];
	if (value === undefined || value === null) return fallback;
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error(`"${key}" must be a number`);
	}
	return Math.min(max, Math.max(min, Math.floor(value)));
}
