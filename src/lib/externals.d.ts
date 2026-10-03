/**
 * Ambient type declarations for optional peer dependencies used via dynamic
 * `import()` in client components. Mirrors src/relay/externals.d.ts and
 * src/mcp/externals.d.ts so `svelte-check` / `tsc` don't error when the optional
 * package isn't installed.
 */

declare module 'html-to-image' {
	export interface Options {
		backgroundColor?: string;
		skipFonts?: boolean;
		[key: string]: unknown;
	}
	export function toPng(node: HTMLElement, options?: Options): Promise<string>;
	export function toSvg(node: HTMLElement, options?: Options): Promise<string>;
	export function toBlob(node: HTMLElement, options?: Options): Promise<Blob | null>;
}
