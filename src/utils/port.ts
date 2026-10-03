import { createServer } from 'node:net';
import { LOOPBACK_HOST } from './security.js';

/**
 * Find an available port starting from the preferred port.
 * Tries incrementing ports up to maxAttempts times on EADDRINUSE.
 *
 * The probe binds to the loopback host so the availability check matches the
 * real server bind (servers are loopback-only for security).
 */
export function findAvailablePort(
	preferred: number,
	maxAttempts: number = 10,
	host: string = LOOPBACK_HOST
): Promise<number> {
	return new Promise((resolve, reject) => {
		let attempt = 0;

		function tryPort(port: number) {
			const server = createServer();

			server.once('error', (err: NodeJS.ErrnoException) => {
				if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
					attempt++;
					tryPort(port + 1);
				} else {
					reject(err);
				}
			});

			server.listen(port, host, () => {
				server.close(() => resolve(port));
			});
		}

		tryPort(preferred);
	});
}

/**
 * Validate a port value parsed from CLI/env input.
 * Returns the port if it is an integer in 1..65535, otherwise returns the
 * fallback and prints a warning. Accepts numbers or strings.
 */
export function validatePort(value: unknown, fallback: number, label = 'port'): number {
	const n = typeof value === 'string' ? parseInt(value, 10) : (value as number);
	if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535) {
		return n;
	}
	if (value !== undefined && value !== null && value !== '') {
		console.warn(`[svelte-grab] Invalid ${label} "${String(value)}" — must be an integer 1..65535. Using ${fallback}.`);
	}
	return fallback;
}
