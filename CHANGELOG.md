# Changelog

## 1.2.0 (2026-03-04)

### Bug Fixes

- **SvelteGrab:** Fix "Open in Editor" not working — `window.open()` silently fails for custom protocol URLs (`vscode://`, `cursor://`, etc.); now uses anchor element click which reliably triggers protocol handlers ([#6](https://github.com/HeiCg/svelte-grab/issues/6))
- **SvelteGrab:** Fix `detectProjectRoot` treating Vite dev-relative paths (`/src/...`, `/lib/...`) as absolute, which produced empty root strings and broken editor URLs
- **SvelteGrab:** Add console warning when editor URL cannot be resolved to an absolute path, with guidance to set the `projectRoot` prop

## 1.1.0 (2026-02-25)

### Bug Fixes

- **SvelteGrab:** Fix setTimeout/onDestroy race condition — if the component unmounts within 100ms, event listeners are no longer registered on a destroyed component
- **profiler-tracker:** Fix `detectBursts` early-exit that skipped per-component analysis when total events were below threshold
- **profiler-tracker:** Fix `characterData` mutations being silently discarded (`Text` nodes are not `HTMLElement`) — now uses `parentElement` as target
- **profiler-tracker:** Cache `detectBursts()` results with dirty-flag invalidation to avoid redundant recomputation
- **agent-client:** Fix pending request history entry being silently overwritten when a new request arrives before the previous one completes
- **agent-client:** Add exponential backoff with 60s cap to WebSocket reconnect (was fixed 3s)
- **agent-client:** Fix `disconnect()` not resolving pending requests — now calls `onError` and saves to history
- **SvelteRenderProfiler:** Add explicit `clearInterval(countdownInterval)` guard in `onDestroy`
- **css-analyzer:** Add explicit parentheses for operator precedence clarity in property filter
- **css-analyzer:** Include inline styles in conflict detection (`propertyRules` map)
- **css-analyzer:** Descend into `@supports` rules (like `@media` rules) when the condition is supported

### Performance

- **profiler-tracker:** Replace O(N*M) event filtering in `getProfiles()` with pre-grouped `Map<file, events[]>` for O(1) lookup

### Features

- **SvelteGrab:** Enrich `formatForAgent()` output — now includes element tag/role/text, component name, and full numbered component stack (not just 2 paths)
- **SvelteDevKit:** Forward all SvelteGrab props (`autoCopyFormat`, `showPopup`, `includeHtml`, `copyOnKeyboard`, `enableScreenshot`, `enableMultiSelect`, `showActiveIndicator`, `maxHistorySize`) and sub-tool config props (`stateSecondaryModifier`, `styleSecondaryModifier`, `maxSnapshots`, `profileDuration`, `burstThreshold`, `burstWindow`, `maxErrors`, `bufferMinutes`, `filterNodeModules`, `showCategories`, `includeSubtree`)
- **SvelteDevKit:** Add help overlay (Alt+?) showing all active keyboard shortcuts based on enabled tools
- **CLI init:** Use `SvelteDevKit` instead of `SvelteGrab` in generated layouts
- **CLI init:** Add Svelte 5+ version check with clear error message
- **CLI init:** Skip `<script context="module">` tags when injecting imports
- **CLI init:** Wrap `<SvelteDevKit />` in `{#if dev}` gate using `$app/environment`
- **All components:** Show "Copy failed" feedback when clipboard API fails (SvelteGrab, SvelteStateGrab, SvelteStyleGrab, SveltePropsTracer, SvelteA11yReporter, SvelteErrorContext)

### Code Quality

- **SvelteGrab:** Deduplicate utility functions — now imports `detectDevMode`, `shortenPath`, `isExcludedPath`, `extractComponentName`, `checkModifier`, `copyToClipboard` from `shared.ts` instead of defining local copies
- **shared.ts:** Remove dead `resolveTheme` function

## 1.0.1

Initial release.
