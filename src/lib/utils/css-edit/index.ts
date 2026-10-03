/**
 * Live CSS edit panel — pure data/logic layer for SvelteStyleGrab's opt-in
 * edit mode. Ported from react-grab. The Svelte 5 UI lives in
 * `SvelteStyleGrab.svelte`; everything here is framework-agnostic and SSR-safe.
 *
 * - property-definitions: the editable-property data table (grouped, typed)
 * - preview-styles:       apply/restore inline-style preview on live elements
 * - tailwind-class-map:   resolve a Tailwind token to a concrete CSS declaration
 * - format-edit-prompt:   build the per-source-location agent edit prompt
 */

export {
	EDITABLE_PROPERTIES,
	ALL_EDIT_CSS_PROPERTIES,
	EDIT_GROUP_LABELS,
	EDIT_GROUP_ORDER,
	FONT_WEIGHT_OPTIONS,
	TEXT_ALIGN_OPTIONS,
	DISPLAY_OPTIONS,
	getPropertyDef,
	groupedEditableProperties
} from './property-definitions.js';
export type {
	EditKind,
	EnumOption,
	EditGroup,
	EditablePropertyDef,
	NumericPropertyDef,
	ColorPropertyDef,
	EnumPropertyDef
} from './property-definitions.js';

export { applyPreview, restorePreview, restoreAll, hasPreview } from './preview-styles.js';

export { resolveTailwindClass } from './tailwind-class-map.js';
export type { ResolvedTailwind } from './tailwind-class-map.js';

export { formatEditPrompt, formatChangeSummary } from './format-edit-prompt.js';
export type { EditChange, EditTarget } from './format-edit-prompt.js';
