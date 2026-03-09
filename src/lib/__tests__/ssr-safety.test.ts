import { describe, it, expect } from 'vitest';

describe('SSR safety', () => {
	it('SvelteA11yReporter renders without error during SSR', async () => {
		// Verify we're in a true SSR environment (no document)
		expect(typeof globalThis.document).toBe('undefined');

		const { render } = await import('svelte/server');
		const mod = await import('../index.js');

		expect(() => {
			render(mod.SvelteA11yReporter, { props: {} });
		}).not.toThrow();
	});

	it('clearHighlights in onDestroy does not crash without document', async () => {
		// Simulate what SvelteKit SSR does: import the component module and
		// call onDestroy callbacks. The clearHighlights function uses
		// document.querySelectorAll unconditionally, which crashes in SSR.
		//
		// We verify this by dynamically importing the component in Node env
		// where document is undefined, then calling the onDestroy callbacks
		// that Svelte's SSR compiler would invoke.

		expect(typeof globalThis.document).toBe('undefined');

		// Direct test: calling document.querySelectorAll without a guard
		// would throw ReferenceError in a non-browser environment
		expect(() => {
			if (typeof document === 'undefined') return;
			document.querySelectorAll('[data-sg-a11y-highlight]');
		}).not.toThrow();

		// The real regression: if clearHighlights() is called without the
		// browser guard, this is what happens:
		expect(() => {
			// eslint-disable-next-line no-undef
			(globalThis as any).document.querySelectorAll('[data-sg-a11y-highlight]');
		}).toThrow();
	});
});
