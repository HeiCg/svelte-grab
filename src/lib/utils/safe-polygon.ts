/**
 * Safe polygon tracker — prevents dropdowns/menus from closing when the mouse
 * traverses dead space between a trigger and its target.
 *
 * Computes a triangle from the cursor position to the far edge of the target
 * rectangle, and keeps the menu open while the cursor stays inside that triangle
 * or any of the target rectangles.
 */

export interface Point {
	x: number;
	y: number;
}

export interface TargetRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Compute the sign of the cross product for three points.
 * Used for point-in-triangle testing.
 */
function computeTriangleSign(p1: Point, p2: Point, p3: Point): number {
	return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
}

/**
 * Test whether a point lies inside a triangle defined by three vertices.
 */
function isPointInTriangle(point: Point, v1: Point, v2: Point, v3: Point): boolean {
	const s1 = computeTriangleSign(point, v1, v2);
	const s2 = computeTriangleSign(point, v2, v3);
	const s3 = computeTriangleSign(point, v3, v1);
	const hasNegative = s1 < 0 || s2 < 0 || s3 < 0;
	const hasPositive = s1 > 0 || s2 > 0 || s3 > 0;
	return !hasNegative || !hasPositive;
}

/**
 * Test whether a point lies inside a rectangle.
 */
function isPointInRect(point: Point, rect: TargetRect): boolean {
	return (
		point.x >= rect.x &&
		point.x <= rect.x + rect.width &&
		point.y >= rect.y &&
		point.y <= rect.y + rect.height
	);
}

/**
 * Compute the two corners of the target rect's far edge relative to the cursor.
 * These corners, together with the cursor position, form the safe triangle.
 */
function computeFarEdgeCorners(cursor: Point, rect: TargetRect): [Point, Point] {
	const bottom = rect.y + rect.height;
	const right = rect.x + rect.width;

	// Cursor is above the rect
	if (cursor.y <= rect.y) {
		return [
			{ x: rect.x, y: bottom },
			{ x: right, y: bottom }
		];
	}
	// Cursor is below the rect
	if (cursor.y >= bottom) {
		return [
			{ x: rect.x, y: rect.y },
			{ x: right, y: rect.y }
		];
	}
	// Cursor is to the left of the rect
	if (cursor.x <= rect.x) {
		return [
			{ x: right, y: rect.y },
			{ x: right, y: bottom }
		];
	}
	// Cursor is to the right (or inside, fallback)
	return [
		{ x: rect.x, y: rect.y },
		{ x: rect.x, y: bottom }
	];
}

/**
 * Create a safe polygon tracker instance.
 *
 * Usage:
 * ```ts
 * const tracker = createSafePolygonTracker();
 * tracker.start(cursorPos, [menuRect], () => closeMenu());
 * // Later:
 * tracker.stop();
 * ```
 */
export function createSafePolygonTracker(): {
	start: (cursor: Point, targets: TargetRect[], onLeave: () => void) => void;
	stop: () => void;
} {
	let removeListener: (() => void) | null = null;

	function stop(): void {
		removeListener?.();
		removeListener = null;
	}

	function start(cursorPosition: Point, targetRects: TargetRect[], onLeave: () => void): void {
		stop();

		const primaryTarget = targetRects[0];
		if (!primaryTarget) return;

		// If cursor is already inside the primary target, nothing to track
		if (isPointInRect(cursorPosition, primaryTarget)) return;

		const [corner1, corner2] = computeFarEdgeCorners(cursorPosition, primaryTarget);

		function isInAnySafeRect(point: Point): boolean {
			return targetRects.some((rect) => isPointInRect(point, rect));
		}

		function handleMouseMove(event: MouseEvent): void {
			const cursor: Point = { x: event.clientX, y: event.clientY };

			// Inside any target rect — stay open
			if (isInAnySafeRect(cursor)) {
				// Reached the primary target — stop tracking
				if (isPointInRect(cursor, primaryTarget)) {
					stop();
				}
				return;
			}

			// Inside the safe triangle — stay open
			if (isPointInTriangle(cursor, cursorPosition, corner1, corner2)) {
				return;
			}

			// Outside everything — leave
			stop();
			onLeave();
		}

		window.addEventListener('mousemove', handleMouseMove, true);
		removeListener = () => {
			window.removeEventListener('mousemove', handleMouseMove, true);
		};
	}

	return { start, stop };
}
