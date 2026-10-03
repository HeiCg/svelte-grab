/**
 * Editable CSS property data tables for the SvelteStyleGrab live-edit panel.
 *
 * Ported from react-grab's `utils/property-definitions.ts` (data-only). Each
 * editable property declares its `kind` (numeric-stepper | color | enum-cycle),
 * its concrete CSS longhand properties, sensible min/max/step bounds for the
 * stepper control, and — for enums — the option list. Grouped into UI sections.
 *
 * This module is pure data + tiny pure helpers — no DOM access, SSR-safe.
 */

/** Discriminator for the control rendered for an editable property. */
export type EditKind = 'numeric-stepper' | 'color' | 'enum-cycle';

/** A single enum option (CSS value + human label). */
export interface EnumOption {
	value: string;
	label: string;
}

interface EditablePropertyBase {
	/**
	 * Stable identity. For aggregates this is the comma-joined cssProperties
	 * (e.g. "padding-top,padding-bottom") so a single key survives without
	 * needing to be parsed back.
	 */
	key: string;
	/** Human-friendly label shown in the panel. */
	label: string;
	/** UI section the property belongs to. */
	group: EditGroup;
	/** Concrete CSS longhand properties this row writes. */
	cssProperties: readonly string[];
}

/** A numeric property edited with a +/- stepper or numeric input. */
export interface NumericPropertyDef extends EditablePropertyBase {
	kind: 'numeric-stepper';
	/** CSS unit to append on write (e.g. "px", "%", "" for unitless). */
	unit: string;
	min: number;
	max: number;
	step: number;
}

/** A color property edited with a `<input type="color">`. */
export interface ColorPropertyDef extends EditablePropertyBase {
	kind: 'color';
}

/** An enum property cycled through a fixed option list. */
export interface EnumPropertyDef extends EditablePropertyBase {
	kind: 'enum-cycle';
	options: ReadonlyArray<EnumOption>;
}

export type EditablePropertyDef = NumericPropertyDef | ColorPropertyDef | EnumPropertyDef;

/** UI grouping for the panel. */
export type EditGroup = 'spacing' | 'sizing' | 'typography' | 'appearance' | 'layout';

export const EDIT_GROUP_LABELS: Record<EditGroup, string> = {
	spacing: 'Spacing',
	sizing: 'Sizing',
	typography: 'Typography',
	appearance: 'Appearance',
	layout: 'Layout'
};

export const EDIT_GROUP_ORDER: readonly EditGroup[] = [
	'spacing',
	'sizing',
	'typography',
	'appearance',
	'layout'
];

// --- Bounds, mirrored from react-grab's property-definitions constants. ---
const SPACING_UNIT_PX = 4;
const SPACING_MAX_UNITS = 96;
const SPACING_MAX_PX = SPACING_UNIT_PX * SPACING_MAX_UNITS; // 384
const SIZE_MAX_PX = 1024;
const FONT_SIZE_MIN_PX = 8;
const FONT_SIZE_MAX_PX = 96;
const LINE_HEIGHT_MIN_PX = 0;
const LINE_HEIGHT_MAX_PX = 120;
const RADIUS_MIN_PX = 0;
const RADIUS_MAX_PX = 96;

/**
 * Font-weight options. Computed style always returns the numeric form, so the
 * `value` is numeric (matches the snapshot) with descriptive labels.
 */
export const FONT_WEIGHT_OPTIONS: ReadonlyArray<EnumOption> = [
	{ value: '100', label: 'thin' },
	{ value: '200', label: 'extra-light' },
	{ value: '300', label: 'light' },
	{ value: '400', label: 'normal' },
	{ value: '500', label: 'medium' },
	{ value: '600', label: 'semibold' },
	{ value: '700', label: 'bold' },
	{ value: '800', label: 'extra-bold' },
	{ value: '900', label: 'black' }
];

export const TEXT_ALIGN_OPTIONS: ReadonlyArray<EnumOption> = [
	{ value: 'left', label: 'left' },
	{ value: 'center', label: 'center' },
	{ value: 'right', label: 'right' },
	{ value: 'justify', label: 'justify' }
];

export const DISPLAY_OPTIONS: ReadonlyArray<EnumOption> = [
	{ value: 'block', label: 'block' },
	{ value: 'flex', label: 'flex' },
	{ value: 'inline-block', label: 'inline-block' },
	{ value: 'inline', label: 'inline' },
	{ value: 'grid', label: 'grid' },
	{ value: 'none', label: 'none' }
];

/**
 * The full ordered table of editable properties for the panel. Aggregate keys
 * (comma-joined longhands) write all sides at once, mirroring react-grab.
 */
export const EDITABLE_PROPERTIES: ReadonlyArray<EditablePropertyDef> = [
	// --- spacing ---
	{
		kind: 'numeric-stepper',
		key: 'padding-top,padding-right,padding-bottom,padding-left',
		label: 'padding',
		group: 'spacing',
		cssProperties: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
		unit: 'px',
		min: 0,
		max: SPACING_MAX_PX,
		step: 1
	},
	{
		kind: 'numeric-stepper',
		key: 'margin-top,margin-right,margin-bottom,margin-left',
		label: 'margin',
		group: 'spacing',
		cssProperties: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
		unit: 'px',
		min: -128,
		max: SPACING_MAX_PX,
		step: 1
	},
	{
		kind: 'numeric-stepper',
		key: 'row-gap,column-gap',
		label: 'gap',
		group: 'spacing',
		cssProperties: ['row-gap', 'column-gap'],
		unit: 'px',
		min: 0,
		max: SPACING_MAX_PX,
		step: 1
	},
	// --- sizing ---
	{
		kind: 'numeric-stepper',
		key: 'width',
		label: 'width',
		group: 'sizing',
		cssProperties: ['width'],
		unit: 'px',
		min: 0,
		max: SIZE_MAX_PX,
		step: 1
	},
	{
		kind: 'numeric-stepper',
		key: 'height',
		label: 'height',
		group: 'sizing',
		cssProperties: ['height'],
		unit: 'px',
		min: 0,
		max: SIZE_MAX_PX,
		step: 1
	},
	// --- typography ---
	{
		kind: 'numeric-stepper',
		key: 'font-size',
		label: 'font size',
		group: 'typography',
		cssProperties: ['font-size'],
		unit: 'px',
		min: FONT_SIZE_MIN_PX,
		max: FONT_SIZE_MAX_PX,
		step: 1
	},
	{
		kind: 'enum-cycle',
		key: 'font-weight',
		label: 'font weight',
		group: 'typography',
		cssProperties: ['font-weight'],
		options: FONT_WEIGHT_OPTIONS
	},
	{
		kind: 'numeric-stepper',
		key: 'line-height',
		label: 'line height',
		group: 'typography',
		cssProperties: ['line-height'],
		unit: 'px',
		min: LINE_HEIGHT_MIN_PX,
		max: LINE_HEIGHT_MAX_PX,
		step: 1
	},
	{
		kind: 'enum-cycle',
		key: 'text-align',
		label: 'text align',
		group: 'typography',
		cssProperties: ['text-align'],
		options: TEXT_ALIGN_OPTIONS
	},
	// --- appearance ---
	{
		kind: 'color',
		key: 'color',
		label: 'text color',
		group: 'appearance',
		cssProperties: ['color']
	},
	{
		kind: 'color',
		key: 'background-color',
		label: 'background',
		group: 'appearance',
		cssProperties: ['background-color']
	},
	{
		kind: 'numeric-stepper',
		key: 'border-top-left-radius,border-top-right-radius,border-bottom-right-radius,border-bottom-left-radius',
		label: 'border radius',
		group: 'appearance',
		cssProperties: [
			'border-top-left-radius',
			'border-top-right-radius',
			'border-bottom-right-radius',
			'border-bottom-left-radius'
		],
		unit: 'px',
		min: RADIUS_MIN_PX,
		max: RADIUS_MAX_PX,
		step: 1
	},
	{
		kind: 'numeric-stepper',
		key: 'opacity',
		label: 'opacity',
		group: 'appearance',
		// Opacity is unitless [0..1] in CSS; the stepper works in percent and
		// the value is divided by 100 on write (see preview-styles).
		cssProperties: ['opacity'],
		unit: '%',
		min: 0,
		max: 100,
		step: 5
	},
	// --- layout ---
	{
		kind: 'enum-cycle',
		key: 'display',
		label: 'display',
		group: 'layout',
		cssProperties: ['display'],
		options: DISPLAY_OPTIONS
	}
];

/** Lookup a property definition by its stable `key`. */
export function getPropertyDef(key: string): EditablePropertyDef | undefined {
	return EDITABLE_PROPERTIES.find((p) => p.key === key);
}

/** The set of all distinct CSS longhands the table can write (deduped). */
export const ALL_EDIT_CSS_PROPERTIES: ReadonlyArray<string> = Array.from(
	new Set(EDITABLE_PROPERTIES.flatMap((p) => p.cssProperties))
);

/** Group the table by UI section, in display order. */
export function groupedEditableProperties(): {
	group: EditGroup;
	label: string;
	properties: EditablePropertyDef[];
}[] {
	return EDIT_GROUP_ORDER.map((group) => ({
		group,
		label: EDIT_GROUP_LABELS[group],
		properties: EDITABLE_PROPERTIES.filter((p) => p.group === group)
	})).filter((section) => section.properties.length > 0);
}
