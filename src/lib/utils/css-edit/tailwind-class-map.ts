/**
 * Resolve a Tailwind utility token to a concrete CSS declaration.
 *
 * Ported as a useful subset from react-grab's `utils/tailwind-class-map.ts`
 * (plus `tailwind-palette-data.ts`). The edit panel lets the user type either a
 * raw `prop: value` declaration OR a Tailwind class; this module handles the
 * Tailwind side. It covers the common cases:
 *
 *   - spacing      p-/px-/py-/pt-…  m-/mx-…  gap-/gap-x-/gap-y-   (4px scale)
 *   - sizing       w-/h-  (numeric scale; only px-resolvable values)
 *   - typography   text-<size>  leading-  font-<weight>  text-<align>
 *   - radius       rounded-/rounded-t-/…  (radius scale)
 *   - opacity      opacity-<0..100>
 *   - colors       text-/bg-/border-  +  default palette  (e.g. bg-blue-500)
 *   - arbitrary    text-[13px]  bg-[#abc]  p-[10px]  …
 *
 * `resolveTailwindClass(token)` returns `{ property, value }` where `property`
 * may be a comma-joined longhand list (e.g. "padding-top,padding-right,…") that
 * the caller fans out across, mirroring react-grab's aggregate keys.
 *
 * Pure / SSR-safe. Coverage is intentionally partial — common cases only.
 */

/**
 * Default Tailwind color palette (subset of the standard families). Ported from
 * react-grab's `tailwind-palette-data.ts`, inlined here so the edit panel needs
 * no extra module.
 */
const TAILWIND_PALETTE: Record<string, Record<number, string>> = {
	slate: {
		50: '#f8fafc',
		100: '#f1f5f9',
		200: '#e2e8f0',
		300: '#cbd5e1',
		400: '#94a3b8',
		500: '#64748b',
		600: '#475569',
		700: '#334155',
		800: '#1e293b',
		900: '#0f172a',
		950: '#020617'
	},
	gray: {
		50: '#f9fafb',
		100: '#f3f4f6',
		200: '#e5e7eb',
		300: '#d1d5db',
		400: '#9ca3af',
		500: '#6b7280',
		600: '#4b5563',
		700: '#374151',
		800: '#1f2937',
		900: '#111827',
		950: '#030712'
	},
	zinc: {
		50: '#fafafa',
		100: '#f4f4f5',
		200: '#e4e4e7',
		300: '#d4d4d8',
		400: '#a1a1aa',
		500: '#71717a',
		600: '#52525b',
		700: '#3f3f46',
		800: '#27272a',
		900: '#18181b',
		950: '#09090b'
	},
	neutral: {
		50: '#fafafa',
		100: '#f5f5f5',
		200: '#e5e5e5',
		300: '#d4d4d4',
		400: '#a3a3a3',
		500: '#737373',
		600: '#525252',
		700: '#404040',
		800: '#262626',
		900: '#171717',
		950: '#0a0a0a'
	},
	stone: {
		50: '#fafaf9',
		100: '#f5f5f4',
		200: '#e7e5e4',
		300: '#d6d3d1',
		400: '#a8a29e',
		500: '#78716c',
		600: '#57534e',
		700: '#44403c',
		800: '#292524',
		900: '#1c1917',
		950: '#0c0a09'
	},
	red: {
		50: '#fef2f2',
		100: '#fee2e2',
		200: '#fecaca',
		300: '#fca5a5',
		400: '#f87171',
		500: '#ef4444',
		600: '#dc2626',
		700: '#b91c1c',
		800: '#991b1b',
		900: '#7f1d1d',
		950: '#450a0a'
	},
	orange: {
		50: '#fff7ed',
		100: '#ffedd5',
		200: '#fed7aa',
		300: '#fdba74',
		400: '#fb923c',
		500: '#f97316',
		600: '#ea580c',
		700: '#c2410c',
		800: '#9a3412',
		900: '#7c2d12',
		950: '#431407'
	},
	amber: {
		50: '#fffbeb',
		100: '#fef3c7',
		200: '#fde68a',
		300: '#fcd34d',
		400: '#fbbf24',
		500: '#f59e0b',
		600: '#d97706',
		700: '#b45309',
		800: '#92400e',
		900: '#78350f',
		950: '#451a03'
	},
	yellow: {
		50: '#fefce8',
		100: '#fef9c3',
		200: '#fef08a',
		300: '#fde047',
		400: '#facc15',
		500: '#eab308',
		600: '#ca8a04',
		700: '#a16207',
		800: '#854d0e',
		900: '#713f12',
		950: '#422006'
	},
	lime: {
		50: '#f7fee7',
		100: '#ecfccb',
		200: '#d9f99d',
		300: '#bef264',
		400: '#a3e635',
		500: '#84cc16',
		600: '#65a30d',
		700: '#4d7c0f',
		800: '#3f6212',
		900: '#365314',
		950: '#1a2e05'
	},
	green: {
		50: '#f0fdf4',
		100: '#dcfce7',
		200: '#bbf7d0',
		300: '#86efac',
		400: '#4ade80',
		500: '#22c55e',
		600: '#16a34a',
		700: '#15803d',
		800: '#166534',
		900: '#14532d',
		950: '#052e16'
	},
	emerald: {
		50: '#ecfdf5',
		100: '#d1fae5',
		200: '#a7f3d0',
		300: '#6ee7b7',
		400: '#34d399',
		500: '#10b981',
		600: '#059669',
		700: '#047857',
		800: '#065f46',
		900: '#064e3b',
		950: '#022c22'
	},
	teal: {
		50: '#f0fdfa',
		100: '#ccfbf1',
		200: '#99f6e4',
		300: '#5eead4',
		400: '#2dd4bf',
		500: '#14b8a6',
		600: '#0d9488',
		700: '#0f766e',
		800: '#115e59',
		900: '#134e4a',
		950: '#042f2e'
	},
	cyan: {
		50: '#ecfeff',
		100: '#cffafe',
		200: '#a5f3fc',
		300: '#67e8f9',
		400: '#22d3ee',
		500: '#06b6d4',
		600: '#0891b2',
		700: '#0e7490',
		800: '#155e75',
		900: '#164e63',
		950: '#083344'
	},
	sky: {
		50: '#f0f9ff',
		100: '#e0f2fe',
		200: '#bae6fd',
		300: '#7dd3fc',
		400: '#38bdf8',
		500: '#0ea5e9',
		600: '#0284c7',
		700: '#0369a1',
		800: '#075985',
		900: '#0c4a6e',
		950: '#082f49'
	},
	blue: {
		50: '#eff6ff',
		100: '#dbeafe',
		200: '#bfdbfe',
		300: '#93c5fd',
		400: '#60a5fa',
		500: '#3b82f6',
		600: '#2563eb',
		700: '#1d4ed8',
		800: '#1e40af',
		900: '#1e3a8a',
		950: '#172554'
	},
	indigo: {
		50: '#eef2ff',
		100: '#e0e7ff',
		200: '#c7d2fe',
		300: '#a5b4fc',
		400: '#818cf8',
		500: '#6366f1',
		600: '#4f46e5',
		700: '#4338ca',
		800: '#3730a3',
		900: '#312e81',
		950: '#1e1b4b'
	},
	violet: {
		50: '#f5f3ff',
		100: '#ede9fe',
		200: '#ddd6fe',
		300: '#c4b5fd',
		400: '#a78bfa',
		500: '#8b5cf6',
		600: '#7c3aed',
		700: '#6d28d9',
		800: '#5b21b6',
		900: '#4c1d95',
		950: '#2e1065'
	},
	purple: {
		50: '#faf5ff',
		100: '#f3e8ff',
		200: '#e9d5ff',
		300: '#d8b4fe',
		400: '#c084fc',
		500: '#a855f7',
		600: '#9333ea',
		700: '#7e22ce',
		800: '#6b21a8',
		900: '#581c87',
		950: '#3b0764'
	},
	fuchsia: {
		50: '#fdf4ff',
		100: '#fae8ff',
		200: '#f5d0fe',
		300: '#f0abfc',
		400: '#e879f9',
		500: '#d946ef',
		600: '#c026d3',
		700: '#a21caf',
		800: '#86198f',
		900: '#701a75',
		950: '#4a044e'
	},
	pink: {
		50: '#fdf2f8',
		100: '#fce7f3',
		200: '#fbcfe8',
		300: '#f9a8d4',
		400: '#f472b6',
		500: '#ec4899',
		600: '#db2777',
		700: '#be185d',
		800: '#9d174d',
		900: '#831843',
		950: '#500724'
	},
	rose: {
		50: '#fff1f2',
		100: '#ffe4e6',
		200: '#fecdd3',
		300: '#fda4af',
		400: '#fb7185',
		500: '#f43f5e',
		600: '#e11d48',
		700: '#be123c',
		800: '#9f1239',
		900: '#881337',
		950: '#4c0519'
	}
};

export interface ResolvedTailwind {
	/** Concrete CSS property, or comma-joined longhands for an aggregate. */
	property: string;
	/** Concrete CSS value (with unit / hex). */
	value: string;
}

const SPACING_UNIT_PX = 4;

// Spacing-scale prefix → comma-joined CSS longhand(s).
const SPACING_PREFIX_TO_PROPERTY: Record<string, string> = {
	p: 'padding-top,padding-right,padding-bottom,padding-left',
	px: 'padding-left,padding-right',
	py: 'padding-top,padding-bottom',
	pt: 'padding-top',
	pr: 'padding-right',
	pb: 'padding-bottom',
	pl: 'padding-left',
	m: 'margin-top,margin-right,margin-bottom,margin-left',
	mx: 'margin-left,margin-right',
	my: 'margin-top,margin-bottom',
	mt: 'margin-top',
	mr: 'margin-right',
	mb: 'margin-bottom',
	ml: 'margin-left',
	gap: 'row-gap,column-gap',
	'gap-x': 'column-gap',
	'gap-y': 'row-gap',
	w: 'width',
	h: 'height',
	'min-w': 'min-width',
	'min-h': 'min-height',
	'max-w': 'max-width',
	'max-h': 'max-height',
	inset: 'top,right,bottom,left',
	'inset-x': 'left,right',
	'inset-y': 'top,bottom',
	top: 'top',
	right: 'right',
	bottom: 'bottom',
	left: 'left'
};

// Radius prefix → comma-joined corners.
const RADIUS_PREFIX_TO_PROPERTY: Record<string, string> = {
	rounded:
		'border-top-left-radius,border-top-right-radius,border-bottom-right-radius,border-bottom-left-radius',
	'rounded-t': 'border-top-left-radius,border-top-right-radius',
	'rounded-b': 'border-bottom-left-radius,border-bottom-right-radius',
	'rounded-l': 'border-top-left-radius,border-bottom-left-radius',
	'rounded-r': 'border-top-right-radius,border-bottom-right-radius',
	'rounded-tl': 'border-top-left-radius',
	'rounded-tr': 'border-top-right-radius',
	'rounded-bl': 'border-bottom-left-radius',
	'rounded-br': 'border-bottom-right-radius'
};

// Named radius scale (rem values converted to px at 16px/rem).
const RADIUS_SCALE_PX: Record<string, number> = {
	none: 0,
	sm: 2,
	'': 4, // `rounded`
	md: 6,
	lg: 8,
	xl: 12,
	'2xl': 16,
	'3xl': 24,
	full: 9999
};

// Tailwind font-size scale (px).
const TEXT_SIZE_PX: Record<string, number> = {
	xs: 12,
	sm: 14,
	base: 16,
	lg: 18,
	xl: 20,
	'2xl': 24,
	'3xl': 30,
	'4xl': 36,
	'5xl': 48,
	'6xl': 60,
	'7xl': 72,
	'8xl': 96,
	'9xl': 128
};

// Named font-weight tokens → numeric value.
const FONT_WEIGHT_NAMED: Record<string, string> = {
	thin: '100',
	extralight: '200',
	light: '300',
	normal: '400',
	medium: '500',
	semibold: '600',
	bold: '700',
	extrabold: '800',
	black: '900'
};

// Text-align utilities.
const TEXT_ALIGN: Record<string, string> = {
	'text-left': 'left',
	'text-center': 'center',
	'text-right': 'right',
	'text-justify': 'justify'
};

// Color utility prefix → CSS property.
const COLOR_PREFIX_TO_PROPERTY: Record<string, string> = {
	text: 'color',
	bg: 'background-color',
	border: 'border-color',
	fill: 'fill',
	stroke: 'stroke'
};

const KEYWORD_COLOR_HEX: Record<string, string> = {
	black: '#000000',
	white: '#ffffff',
	transparent: '#00000000'
};

/** Normalize raw user input into a canonical tailwind-ish token. */
function normalize(token: string): string {
	return token.trim().toLowerCase().replace(/\s+/g, '-');
}

/** Strip variant prefixes (`hover:`, `md:`) and a leading `!`. */
function stripModifiers(token: string): string {
	let depth = 0;
	let lastColon = -1;
	for (let i = 0; i < token.length; i++) {
		const c = token[i];
		if (c === '[') depth++;
		else if (c === ']') depth--;
		else if (c === ':' && depth === 0) lastColon = i;
	}
	const base = lastColon >= 0 ? token.slice(lastColon + 1) : token;
	return base.startsWith('!') ? base.slice(1) : base;
}

/** Resolve a Tailwind color shade token (e.g. "blue-500", "white") to hex. */
function resolveColorTail(tail: string): string | null {
	if (!tail) return null;
	const keyword = KEYWORD_COLOR_HEX[tail];
	if (keyword) return keyword;
	const sep = tail.lastIndexOf('-');
	if (sep < 0) return null;
	const familyToken = tail.slice(0, sep);
	const family = familyToken === 'grey' ? 'gray' : familyToken;
	const shade = Number.parseInt(tail.slice(sep + 1), 10);
	if (!Number.isFinite(shade)) return null;
	return TAILWIND_PALETTE[family]?.[shade] ?? null;
}

/** Find the longest known prefix for a hyphen-split token. */
function matchPrefix(base: string, table: Record<string, string>): string | null {
	const bracketIndex = base.indexOf('[');
	const stem = bracketIndex > 0 ? base.slice(0, bracketIndex).replace(/-$/, '') : base;
	const segments = stem.split('-').filter(Boolean);
	for (let len = segments.length; len >= 1; len--) {
		const candidate = segments.slice(0, len).join('-');
		if (table[candidate] !== undefined) return candidate;
	}
	return null;
}

/** Extract the value tail of a prefixed class, or null if it doesn't match. */
function tail(base: string, prefix: string): string | null {
	if (base === prefix) return '';
	const withSep = `${prefix}-`;
	if (!base.startsWith(withSep)) return null;
	return base.slice(withSep.length);
}

/** Read the inner value of an arbitrary `prefix-[value]` class. */
function arbitraryValue(base: string): string | null {
	const open = base.indexOf('[');
	if (open < 0) return null;
	const close = base.lastIndexOf(']');
	if (close <= open) return null;
	return (
		base
			.slice(open + 1, close)
			.replace(/_/g, ' ')
			.trim() || null
	);
}

const NUMERIC_SCALE = /^-?\d+(?:\.\d+)?$/;

/**
 * Resolve a single Tailwind utility token to a concrete CSS declaration, or
 * null when the token isn't recognized. The returned `property` may be a
 * comma-joined longhand list — callers fan out across `property.split(',')`.
 */
export function resolveTailwindClass(token: string): ResolvedTailwind | null {
	const base = stripModifiers(normalize(token));
	if (!base) return null;

	// --- Enum / named single-token utilities first (no value tail). ---
	if (TEXT_ALIGN[base]) return { property: 'text-align', value: TEXT_ALIGN[base] };

	// font-<named-weight> e.g. font-bold
	if (base.startsWith('font-')) {
		const weight = FONT_WEIGHT_NAMED[base.slice('font-'.length)];
		if (weight) return { property: 'font-weight', value: weight };
	}

	const arbitrary = arbitraryValue(base);

	// --- Color utilities (text-/bg-/border-/fill/stroke). ---
	const colorPrefix = matchPrefix(base, COLOR_PREFIX_TO_PROPERTY);
	if (colorPrefix && COLOR_PREFIX_TO_PROPERTY[colorPrefix]) {
		const property = COLOR_PREFIX_TO_PROPERTY[colorPrefix];
		if (arbitrary !== null) {
			// Only treat the arbitrary value as a color when it looks like one,
			// so `text-[13px]` falls through to the size branch below.
			if (/^(#|rgb|rgba|hsl|hsla|oklch|color|var\()/i.test(arbitrary)) {
				return { property, value: arbitrary };
			}
		} else {
			const colorTail = tail(base, colorPrefix);
			if (colorTail !== null) {
				// Guard: `text-<size>` is typography, not color.
				const head = colorTail.split('-')[0];
				if (!(colorPrefix === 'text' && TEXT_SIZE_PX[head] !== undefined)) {
					const hex = resolveColorTail(colorTail);
					if (hex) return { property, value: hex };
				}
			}
		}
	}

	// --- Typography: text-<size> + arbitrary text-[..px]. ---
	if (colorPrefix === 'text' || base.startsWith('text-')) {
		const t = tail(base, 'text');
		if (t !== null) {
			if (arbitrary !== null && /^-?\d/.test(arbitrary)) {
				return { property: 'font-size', value: arbitrary };
			}
			if (TEXT_SIZE_PX[t] !== undefined) {
				return { property: 'font-size', value: `${TEXT_SIZE_PX[t]}px` };
			}
		}
	}

	// leading-<n> → line-height (n on the 4px scale, or arbitrary).
	if (base.startsWith('leading') || base === 'leading') {
		const t = tail(base, 'leading');
		if (t !== null) {
			if (arbitrary !== null) return { property: 'line-height', value: arbitrary };
			if (NUMERIC_SCALE.test(t)) {
				return { property: 'line-height', value: `${Number(t) * SPACING_UNIT_PX}px` };
			}
		}
	}

	// opacity-<0..100>
	if (base.startsWith('opacity')) {
		const t = tail(base, 'opacity');
		if (t !== null) {
			const raw = arbitrary ?? t;
			const n = Number(raw);
			if (Number.isFinite(n)) {
				// `opacity-50` → 0.5; arbitrary `opacity-[0.4]` passes through.
				const value = arbitrary !== null && n <= 1 ? String(n) : String(n / 100);
				return { property: 'opacity', value };
			}
		}
	}

	// --- Radius (rounded / rounded-t / rounded-[..]). ---
	const radiusPrefix = matchPrefix(base, RADIUS_PREFIX_TO_PROPERTY);
	if (radiusPrefix && RADIUS_PREFIX_TO_PROPERTY[radiusPrefix]) {
		const property = RADIUS_PREFIX_TO_PROPERTY[radiusPrefix];
		if (arbitrary !== null) return { property, value: arbitrary };
		const t = tail(base, radiusPrefix);
		if (t !== null && RADIUS_SCALE_PX[t] !== undefined) {
			return { property, value: `${RADIUS_SCALE_PX[t]}px` };
		}
	}

	// --- Spacing / sizing scale (p-/m-/gap-/w-/h-/inset-/…). ---
	const spacingPrefix = matchPrefix(base, SPACING_PREFIX_TO_PROPERTY);
	if (spacingPrefix && SPACING_PREFIX_TO_PROPERTY[spacingPrefix]) {
		const property = SPACING_PREFIX_TO_PROPERTY[spacingPrefix];
		if (arbitrary !== null) return { property, value: arbitrary };
		const t = tail(base, spacingPrefix);
		if (t !== null) {
			// Common keyword sizes for w/h.
			if (t === 'full') return { property, value: '100%' };
			if (t === 'auto') return { property, value: 'auto' };
			if (t === 'px') return { property, value: '1px' };
			if (NUMERIC_SCALE.test(t)) {
				return { property, value: `${Number(t) * SPACING_UNIT_PX}px` };
			}
		}
	}

	return null;
}
