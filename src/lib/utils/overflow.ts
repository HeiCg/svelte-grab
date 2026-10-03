/**
 * Resolve the per-axis overflow values of a computed style.
 *
 * Browsers always expand the `overflow` shorthand into `overflow-x` /
 * `overflow-y`, but some DOM implementations (jsdom) keep the longhands at
 * their initial `visible` while reporting the shorthand. Fall back to the
 * shorthand's first/second value when a longhand is missing or `visible`.
 */
export function overflowAxes(
	cs: Pick<CSSStyleDeclaration, 'overflow' | 'overflowX' | 'overflowY'>
): {
	x: string;
	y: string;
} {
	const parts = (cs.overflow || '').trim().split(/\s+/).filter(Boolean);
	const shortX = parts[0];
	const shortY = parts[1] ?? parts[0];
	const pick = (longhand: string | undefined, short: string | undefined) =>
		longhand && longhand !== 'visible' ? longhand : short || longhand || 'visible';
	return { x: pick(cs.overflowX, shortX), y: pick(cs.overflowY, shortY) };
}
