/**
 * Version check and intro logging for SvelteGrab.
 * Prints a styled console message on first call and performs a
 * best-effort check against the npm registry for newer versions.
 */

let hasRun = false;

/**
 * Log a styled intro message and check for updates.
 * Only runs once per page load; subsequent calls are no-ops.
 */
export function logIntro(currentVersion: string): void {
	if (hasRun) return;
	hasRun = true;

	try {
		console.log(
			'%c[SvelteGrab]%c v' + currentVersion + ' ready',
			'color: #ff6b35; font-weight: bold;',
			'color: inherit;'
		);
	} catch {
		// Console not available (e.g. SSR context), skip silently
	}

	// Best-effort version check — fire and forget
	try {
		fetch('https://registry.npmjs.org/svelte-grab/latest', {
			signal: AbortSignal.timeout(5000)
		})
			.then((res) => {
				if (!res.ok) return;
				return res.json();
			})
			.then((data) => {
				if (!data || !data.version) return;

				const latest = data.version as string;
				if (latest !== currentVersion && isNewer(latest, currentVersion)) {
					console.warn(
						'[SvelteGrab] Update available: v' +
							latest +
							' (current: v' +
							currentVersion +
							'). Run: npm update svelte-grab'
					);
				}
			})
			.catch(() => {
				// Network errors are expected in dev environments, ignore
			});
	} catch {
		// fetch or AbortSignal.timeout not available, skip silently
	}
}

/**
 * Compare two semver strings to determine if `a` is newer than `b`.
 */
function isNewer(a: string, b: string): boolean {
	const partsA = a.split('.').map(Number);
	const partsB = b.split('.').map(Number);

	for (let i = 0; i < 3; i++) {
		const va = partsA[i] || 0;
		const vb = partsB[i] || 0;
		if (va > vb) return true;
		if (va < vb) return false;
	}

	return false;
}
