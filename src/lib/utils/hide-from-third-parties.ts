/**
 * Stamp redaction markers onto a dev-tool overlay element so its contents never
 * leak into third-party session-replay / analytics / error tools.
 *
 * The svelte-grab popups can show source file paths, prop values, captured
 * error messages and rendered HTML. None of that should ever be recorded by
 * tools like PostHog/rrweb, Sentry, FullStory, Datadog, LogRocket, Hotjar,
 * Microsoft Clarity, Heap or Smartlook — it is noise at best and a privacy /
 * security leak at worst.
 *
 * Each of those tools honours one or more "do not capture / mask this subtree"
 * attributes or CSS classes. `hideFromThirdParties` applies all of them at once,
 * idempotently, so a single call on the popup root opts the whole subtree out.
 *
 * Usage (call once, on mount, against the overlay/popup root):
 *   import { hideFromThirdParties } from '../utils/hide-from-third-parties.js';
 *   onMount(() => { if (rootEl) hideFromThirdParties(rootEl); });
 */

/**
 * CSS classes that mark an element (and its subtree) as do-not-capture for
 * class-based session-replay tools.
 *
 * - `ph-no-capture`  — PostHog / its rrweb-based session replay
 * - `fs-exclude`     — FullStory (exclude element from capture entirely)
 * - `fs-mask`        — FullStory (mask text content as a fallback)
 * - `rr-block`       — rrweb (block recording of the subtree)
 * - `data-hj-suppress` is an attribute, not a class — see below
 */
export const THIRD_PARTY_REDACT_CLASSES: readonly string[] = [
	'ph-no-capture',
	'fs-exclude',
	'fs-mask',
	'rr-block'
] as const;

/**
 * Attribute markers (name → value). An empty-string value means the attribute
 * is a boolean-style flag where mere presence is what the tool looks for.
 *
 * - data-sentry-block / data-sentry-mask — Sentry Session Replay
 * - data-fs-exclude                      — FullStory (attribute form of exclude)
 * - data-dd-privacy="hidden"             — Datadog RUM Session Replay
 * - data-private                         — LogRocket (private/redacted subtree)
 * - data-hj-suppress                     — Hotjar (suppress recording)
 * - data-clarity-mask="true"             — Microsoft Clarity (mask content)
 * - data-clarity-unmask="false"          — Microsoft Clarity (ensure not unmasked)
 * - data-heap-redact-text="true"         — Heap (redact text content)
 * - data-recording-disable               — Smartlook (disable recording)
 */
export const THIRD_PARTY_REDACT_ATTRS: ReadonlyArray<readonly [string, string]> = [
	['data-sentry-block', ''],
	['data-sentry-mask', ''],
	['data-fs-exclude', ''],
	['data-dd-privacy', 'hidden'],
	['data-private', ''],
	['data-hj-suppress', ''],
	['data-clarity-mask', 'true'],
	['data-clarity-unmask', 'false'],
	['data-heap-redact-text', 'true'],
	['data-recording-disable', '']
] as const;

/**
 * Apply every known third-party redaction marker to `el`.
 *
 * Idempotent: classes are added via the DOM token list (no duplicates) and
 * attributes are set to a fixed value, so calling this repeatedly is a no-op
 * after the first call.
 *
 * @param el - The dev-tool root element to opt out of all third-party capture.
 */
export function hideFromThirdParties(el: HTMLElement): void {
	if (!el) return;

	for (const cls of THIRD_PARTY_REDACT_CLASSES) {
		el.classList.add(cls);
	}

	for (const [name, value] of THIRD_PARTY_REDACT_ATTRS) {
		// Only write if missing or different — keeps it idempotent and avoids
		// triggering needless attribute MutationObserver churn.
		if (el.getAttribute(name) !== value) {
			el.setAttribute(name, value);
		}
	}
}
