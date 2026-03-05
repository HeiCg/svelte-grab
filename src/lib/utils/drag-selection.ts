/**
 * Multi-element drag selection with point-sampling.
 *
 * When the user click-drags a selection rectangle, this module
 * identifies which DOM elements fall within that rectangle by
 * sampling a grid of points and testing element coverage.
 */

// ============================================================
// Types
// ============================================================

export interface DragRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

// ============================================================
// Constants
// ============================================================

/** Spacing between sample points in pixels */
export const SAMPLE_SPACING_PX = 20;

/** Minimum sample points along each axis */
export const MIN_SAMPLES_PER_AXIS = 3;

/** Maximum sample points along each axis */
export const MAX_SAMPLES_PER_AXIS = 30;

/** Hard cap on total number of sample points */
export const MAX_TOTAL_SAMPLES = 400;

/** Minimum coverage ratio (intersection / min(element, drag area)) to include an element */
export const COVERAGE_THRESHOLD = 0.3;

// ============================================================
// Main
// ============================================================

/**
 * Find all elements within a drag rectangle using point-sampling.
 *
 * @param dragRect - The selection rectangle in viewport coordinates
 * @param isValidElement - Optional filter predicate for candidate elements
 * @returns Array of matching elements sorted in document order
 */
export function getElementsInDragRect(
	dragRect: DragRect,
	isValidElement?: (el: Element) => boolean
): Element[] {
	if (dragRect.width <= 0 || dragRect.height <= 0) return [];

	// Generate sample points
	const points = generateSamplePoints(dragRect);

	// Collect unique elements from all sample points
	const candidateSet = new Set<Element>();

	for (const [px, py] of points) {
		try {
			const elements = document.elementsFromPoint(px, py);
			for (const el of elements) {
				candidateSet.add(el);
			}
		} catch {
			// elementsFromPoint can throw in edge cases — skip point
		}
	}

	// Filter candidates
	const filtered: Element[] = [];

	for (const el of candidateSet) {
		// Skip html and body
		const tag = el.tagName.toLowerCase();
		if (tag === 'html' || tag === 'body') continue;

		// Skip elements that don't pass the validity check
		if (isValidElement && !isValidElement(el)) continue;

		// Skip disconnected elements
		if (!el.isConnected) continue;

		// Check coverage threshold
		if (!meetsConverageThreshold(el, dragRect)) continue;

		filtered.push(el);
	}

	// Remove nested elements (if both parent and child are selected, keep parent)
	const deduped = removeNested(filtered);

	// Sort by document order
	deduped.sort((a, b) => {
		const pos = a.compareDocumentPosition(b);
		if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
		if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
		return 0;
	});

	return deduped;
}

// ============================================================
// Sampling
// ============================================================

/**
 * Generate a grid of sample points across the drag rectangle.
 * Always includes corners, center, and edge midpoints.
 */
function generateSamplePoints(rect: DragRect): Array<[number, number]> {
	const { x, y, width, height } = rect;

	// Calculate grid dimensions
	let xCount = Math.max(
		MIN_SAMPLES_PER_AXIS,
		Math.min(MAX_SAMPLES_PER_AXIS, Math.ceil(width / SAMPLE_SPACING_PX) + 1)
	);
	let yCount = Math.max(
		MIN_SAMPLES_PER_AXIS,
		Math.min(MAX_SAMPLES_PER_AXIS, Math.ceil(height / SAMPLE_SPACING_PX) + 1)
	);

	// Enforce total sample cap
	while (xCount * yCount > MAX_TOTAL_SAMPLES) {
		if (xCount > yCount) {
			xCount--;
		} else {
			yCount--;
		}
	}

	const points: Array<[number, number]> = [];
	const xStep = xCount > 1 ? width / (xCount - 1) : 0;
	const yStep = yCount > 1 ? height / (yCount - 1) : 0;

	for (let xi = 0; xi < xCount; xi++) {
		for (let yi = 0; yi < yCount; yi++) {
			const px = x + xi * xStep;
			const py = y + yi * yStep;
			points.push([px, py]);
		}
	}

	// Ensure center is included (may already be, but Set-dedup not worth it for coords)
	const cx = x + width / 2;
	const cy = y + height / 2;
	points.push([cx, cy]);

	return points;
}

// ============================================================
// Coverage
// ============================================================

/**
 * Check if the intersection between an element's bounding box
 * and the drag rect meets the coverage threshold.
 */
function meetsConverageThreshold(el: Element, dragRect: DragRect): boolean {
	let elRect: DOMRect;
	try {
		elRect = el.getBoundingClientRect();
	} catch {
		return false;
	}

	// Skip zero-size elements
	if (elRect.width <= 0 || elRect.height <= 0) return false;

	// Compute intersection rectangle
	const intLeft = Math.max(elRect.left, dragRect.x);
	const intTop = Math.max(elRect.top, dragRect.y);
	const intRight = Math.min(elRect.right, dragRect.x + dragRect.width);
	const intBottom = Math.min(elRect.bottom, dragRect.y + dragRect.height);

	if (intRight <= intLeft || intBottom <= intTop) return false;

	const intersectionArea = (intRight - intLeft) * (intBottom - intTop);
	const elementArea = elRect.width * elRect.height;
	const dragArea = dragRect.width * dragRect.height;
	const smallerArea = Math.min(elementArea, dragArea);

	if (smallerArea <= 0) return false;

	return intersectionArea / smallerArea >= COVERAGE_THRESHOLD;
}

// ============================================================
// Deduplication
// ============================================================

/**
 * Remove nested elements: if both a parent and child are in the list,
 * keep only the parent.
 */
function removeNested(elements: Element[]): Element[] {
	const result: Element[] = [];

	for (const el of elements) {
		let isNested = false;
		for (const other of elements) {
			if (other !== el && other.contains(el)) {
				isNested = true;
				break;
			}
		}
		if (!isNested) {
			result.push(el);
		}
	}

	return result;
}
