/**
 * Theme resolution shared by every svelte-grab dev-tool component.
 *
 * Today each component repeats this exact two-line dance:
 *   let baseTheme = $derived(lightTheme ? LIGHT_THEME : DARK_THEME);
 *   let colors    = $derived({ ...baseTheme, ...theme } as Required<ThemeConfig>);
 *
 * `resolveTheme` is the plain-function form of that logic. It is intentionally
 * NOT reactive on its own — callers wrap it in `$derived` so it recomputes when
 * `theme` / `lightTheme` change:
 *
 *   let colors = $derived(resolveTheme(theme, lightTheme));
 *
 * Outside a component (e.g. plain TS), just call it directly.
 */

import type { ThemeConfig } from '../types.js';
import { DARK_THEME, LIGHT_THEME } from './shared.js';

/**
 * A fully-resolved theme: the chosen preset merged with any per-color overrides.
 * Every field is guaranteed present (no `undefined`), matching the
 * `Required<ThemeConfig>` shape the components cast to today.
 */
export type ResolvedTheme = Required<ThemeConfig>;

/**
 * Merge a theme override on top of the dark or light preset.
 *
 * @param theme - Per-color overrides applied on top of the preset. Defaults to {}.
 * @param lightTheme - When true, use the light preset as the base. Default: false.
 * @returns The merged, fully-populated theme.
 */
export function resolveTheme(theme: ThemeConfig = {}, lightTheme = false): ResolvedTheme {
	const base = lightTheme ? LIGHT_THEME : DARK_THEME;
	return { ...base, ...theme } as ResolvedTheme;
}
