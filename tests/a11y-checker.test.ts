// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { contrastRatio, analyzeA11y } from '../src/lib/utils/a11y-checker.js';

/**
 * The well-known WCAG extremes: black-on-white is 21:1.
 */
describe('contrastRatio - opaque colors (non-regression)', () => {
	it('black on white is 21:1', () => {
		expect(contrastRatio('rgb(0,0,0)', 'rgb(255,255,255)')).toBeCloseTo(21, 1);
	});

	it('white on black is also 21:1 (order independent)', () => {
		expect(contrastRatio('rgb(255,255,255)', 'rgb(0,0,0)')).toBeCloseTo(21, 1);
	});

	it('identical colors are 1:1', () => {
		expect(contrastRatio('rgb(120,120,120)', 'rgb(120,120,120)')).toBeCloseTo(1, 5);
	});

	it('parses hex colors', () => {
		expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
	});

	it('parses 3-digit hex colors', () => {
		expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 1);
	});

	it('returns null for unparseable colors', () => {
		expect(contrastRatio('not-a-color', 'rgb(255,255,255)')).toBeNull();
		expect(contrastRatio('rgb(0,0,0)', 'definitely-not-a-color')).toBeNull();
	});
});

describe('contrastRatio - translucent foreground is composited (bug fix)', () => {
	it('rgba(0,0,0,0.6) on white is NOT treated as pure black (21:1)', () => {
		// The bug: alpha was dropped, so muted text reported the full 21:1.
		const ratio = contrastRatio('rgba(0,0,0,0.6)', 'rgb(255,255,255)');
		expect(ratio).not.toBeNull();
		// 60% black over white ≈ rgb(102,102,102), contrast ≈ 5.7:1, well under 21.
		expect(ratio!).toBeLessThan(8);
		expect(ratio!).toBeGreaterThan(4);
	});

	it('matches the contrast of the equivalent composited opaque color', () => {
		// rgba(0,0,0,0.6) over white === rgb(102,102,102) (0.6*0 + 0.4*255 = 102).
		const translucent = contrastRatio('rgba(0,0,0,0.6)', 'rgb(255,255,255)');
		const composited = contrastRatio('rgb(102,102,102)', 'rgb(255,255,255)');
		expect(translucent).toBeCloseTo(composited!, 2);
	});

	it('a low-alpha foreground produces a low (failing) ratio', () => {
		// rgba(0,0,0,0.1) over white ≈ rgb(230,230,230): barely any contrast.
		const ratio = contrastRatio('rgba(0,0,0,0.1)', 'rgb(255,255,255)');
		expect(ratio).not.toBeNull();
		expect(ratio!).toBeLessThan(1.5);
	});

	it('handles 8-digit hex foreground alpha', () => {
		// #00000099 = black at 0x99/0xff ≈ 0.6 alpha, same as rgba(0,0,0,0.6).
		const hexAlpha = contrastRatio('#00000099', '#ffffff');
		const rgbaAlpha = contrastRatio('rgba(0,0,0,0.6)', 'rgb(255,255,255)');
		expect(hexAlpha).not.toBeNull();
		expect(hexAlpha!).toBeCloseTo(rgbaAlpha!, 1);
	});

	it('fully opaque alpha (a=1) behaves like the opaque color', () => {
		expect(contrastRatio('rgba(0,0,0,1)', 'rgb(255,255,255)')).toBeCloseTo(21, 1);
	});
});

describe('contrastRatio - indeterminate translucent background (bug fix)', () => {
	it('returns null when the background itself is non-opaque', () => {
		// We do not know what is behind a translucent background, so reporting any
		// ratio would be a false positive. Indeterminate => null.
		expect(contrastRatio('rgb(0,0,0)', 'rgba(255,255,255,0.5)')).toBeNull();
	});

	it('returns null for a fully transparent background', () => {
		expect(contrastRatio('rgb(0,0,0)', 'rgba(0,0,0,0)')).toBeNull();
		expect(contrastRatio('rgb(0,0,0)', 'transparent')).toBeNull();
	});

	it('an opaque (a=1) background is fine', () => {
		expect(contrastRatio('rgb(0,0,0)', 'rgba(255,255,255,1)')).toBeCloseTo(21, 1);
	});
});

/**
 * Integration tests that exercise getEffectiveBackground (via analyzeA11y's
 * subtree contrast check). jsdom's getComputedStyle only resolves inline styles,
 * which is exactly what we set here.
 */
describe('analyzeA11y - effective background compositing (bug fix)', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	function contrastIssues(root: HTMLElement) {
		const report = analyzeA11y(root, true);
		return [...report.critical, ...report.warnings].filter(i => i.rule === 'contrast');
	}

	it('flags muted (translucent) text that fails once composited', () => {
		// rgba(0,0,0,0.35) text over white ≈ rgb(166,166,166): fails AA (< 4.5:1).
		// Pre-fix this was treated as pure black (21:1) and silently passed.
		const p = document.createElement('p');
		p.style.color = 'rgba(0, 0, 0, 0.35)';
		p.style.backgroundColor = 'rgb(255, 255, 255)';
		p.textContent = 'Subtle muted text';
		document.body.appendChild(p);

		expect(contrastIssues(document.body).length).toBeGreaterThan(0);
	});

	it('does NOT flag solid black text on white (good contrast)', () => {
		const p = document.createElement('p');
		p.style.color = 'rgb(0, 0, 0)';
		p.style.backgroundColor = 'rgb(255, 255, 255)';
		p.textContent = 'Solid readable text';
		document.body.appendChild(p);

		expect(contrastIssues(document.body)).toHaveLength(0);
	});

	it('composites a translucent background over its ancestor before judging', () => {
		// White text on a translucent-dark panel over a dark page should still be
		// readable; the translucent layer must blend onto the dark ancestor, not
		// onto the default white fallback (which would wrongly flag white-on-white).
		const page = document.createElement('div');
		page.style.backgroundColor = 'rgb(0, 0, 0)';
		const panel = document.createElement('div');
		panel.style.backgroundColor = 'rgba(0, 0, 0, 0.5)'; // translucent over black -> still dark
		const text = document.createElement('span');
		text.style.color = 'rgb(255, 255, 255)';
		text.textContent = 'Readable white text on dark panel';
		panel.appendChild(text);
		page.appendChild(panel);
		document.body.appendChild(page);

		expect(contrastIssues(document.body)).toHaveLength(0);
	});
});

describe('analyzeA11y - contrast dedup', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	it('reports a failing fg/bg pair once even across many elements', () => {
		// Three identical muted paragraphs share one fg|bg|font key; the dedup must
		// collapse them into a single contrast issue.
		for (let i = 0; i < 3; i++) {
			const p = document.createElement('p');
			p.style.color = 'rgba(0, 0, 0, 0.3)';
			p.style.backgroundColor = 'rgb(255, 255, 255)';
			p.textContent = `Muted paragraph ${i}`;
			document.body.appendChild(p);
		}

		const report = analyzeA11y(document.body, true);
		const issues = [...report.critical, ...report.warnings].filter(i => i.rule === 'contrast');
		expect(issues).toHaveLength(1);
	});
});
