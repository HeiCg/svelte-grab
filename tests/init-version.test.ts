import { describe, it, expect } from 'vitest';
import { checkSvelteVersion, parseSvelteVersion } from '../src/cli/init.js';

describe('parseSvelteVersion', () => {
	it('parses ranges and partial versions', () => {
		expect(parseSvelteVersion('^5.35.1')).toEqual([5, 35, 1]);
		expect(parseSvelteVersion('~5.2')).toEqual([5, 2, 0]);
		expect(parseSvelteVersion('>= 4')).toEqual([4, 0, 0]);
		expect(parseSvelteVersion('workspace:^5.40.0')).toEqual([5, 40, 0]);
		expect(parseSvelteVersion('latest')).toBe(null);
	});
});

describe('checkSvelteVersion', () => {
	it('errors below Svelte 5', () => {
		expect(checkSvelteVersion('^4.2.0')).toBe('error');
		expect(checkSvelteVersion('3.59.2')).toBe('error');
	});

	it('warns for 5.x below 5.35.1', () => {
		expect(checkSvelteVersion('^5.0.0')).toBe('warn');
		expect(checkSvelteVersion('5.35.0')).toBe('warn');
		expect(checkSvelteVersion('~5.34.9')).toBe('warn');
	});

	it('accepts 5.35.1 and above', () => {
		expect(checkSvelteVersion('^5.35.1')).toBe('ok');
		expect(checkSvelteVersion('5.36.0')).toBe('ok');
		expect(checkSvelteVersion('^5.53.7')).toBe('ok');
		expect(checkSvelteVersion('6.0.0')).toBe('ok');
	});

	it('skips unparseable specs', () => {
		expect(checkSvelteVersion('latest')).toBe('ok');
		expect(checkSvelteVersion('workspace:*')).toBe('ok');
	});
});
