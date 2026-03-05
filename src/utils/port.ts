import { createServer } from 'node:net';

/**
 * Find an available port starting from the preferred port.
 * Tries incrementing ports up to maxAttempts times on EADDRINUSE.
 */
export function findAvailablePort(preferred: number, maxAttempts: number = 10): Promise<number> {
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

			server.listen(port, () => {
				server.close(() => resolve(port));
			});
		}

		tryPort(preferred);
	});
}
