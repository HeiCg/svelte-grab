<script lang="ts">
	import { FAKE_API_KEY, FAKE_JWT, FAKE_STORAGE_KEY, FAKE_THIRD_PARTY_URL } from './fake-secrets';

	/*
	 * Deliberately insecure requests for ui_network / ui_security_scan. Every
	 * credential is FAKE (see fake-secrets.ts). The same-origin endpoints under
	 * /__fake/api/ are mocked by Playwright (page.route) in e2e; when clicked by
	 * hand, Vite's SPA fallback answers them.
	 */
	let status = $state('idle');

	async function keyInUrl() {
		status = 'key-in-url: sending';
		try {
			await fetch(`/__fake/api/mock?api_key=${FAKE_API_KEY}&page=1`);
			status = 'key-in-url: done';
		} catch {
			status = 'key-in-url: failed';
		}
	}

	async function authToThirdParty() {
		status = 'third-party: sending';
		try {
			await fetch(FAKE_THIRD_PARTY_URL, {
				method: 'POST',
				headers: { Authorization: `Bearer ${FAKE_JWT}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ event: 'fake-click' })
			});
			status = 'third-party: done';
		} catch {
			status = 'third-party: failed';
		}
	}

	function storeToken() {
		localStorage.setItem(FAKE_STORAGE_KEY, FAKE_JWT);
		status = 'stored: done';
	}

	async function duplicates() {
		status = 'duplicates: sending';
		try {
			await Promise.all([fetch('/__fake/api/items'), fetch('/__fake/api/items')]);
			status = 'duplicates: done';
		} catch {
			status = 'duplicates: failed';
		}
	}
</script>

<!-- FAKE credentials only: see fake-secrets.ts. -->
<div class="fx-leaky" data-testid="fx-leaky">
	<button data-testid="fx-leaky-url" onclick={keyInUrl}>Key in URL</button>
	<button data-testid="fx-leaky-third-party" onclick={authToThirdParty}>Auth to third party</button>
	<button data-testid="fx-leaky-storage" onclick={storeToken}>Token in localStorage</button>
	<button data-testid="fx-leaky-duplicates" onclick={duplicates}>Duplicate requests</button>
	<p data-testid="fx-leaky-status">{status}</p>
</div>

<style>
	.fx-leaky {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.fx-leaky p {
		flex-basis: 100%;
		margin: 4px 0 0;
		color: #374151;
	}
</style>
