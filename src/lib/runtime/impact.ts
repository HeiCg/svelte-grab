/**
 * `ui_component_impact` (docs/agent-runtime-spec.md, Phase 5): before editing
 * a shared component, how far does a change reach?
 *
 * - The component that owns the element's markup and its definition file.
 * - Its instances on this page (one per rendered instance, with refs), grouped
 *   by usage file and line.
 * - "Variants": instances grouped by their root element's class list (Svelte's
 *   `svelte-xxxx` scoping hashes ignored), a cheap proxy for prop variants.
 * - Importers of the definition file from Vite's module graph, when the
 *   `svelte-grab/vite` plugin serves `GET /__svelte-grab/importers`.
 * - A recommendation: edit the component, or prefer a prop/variant or a local
 *   class at the usage site.
 */
import { findMetaElement, getSvelteLoc } from '../utils/component-stack.js';
import { shortenPath } from '../utils/shared.js';
import { getVitePluginInfo, type VitePluginInfo } from '../utils/vite-plugin-info.js';
import { computeName, computeRole } from './aria.js';
import { isComponentRoot } from './find.js';
import {
	allPageElements,
	getClasses,
	getComponentInstance,
	getElementSource
} from './node-info.js';
import { computeStableKeys, refRegistry, type RefRegistry } from './refs.js';
import { roleOrTag } from './snapshot.js';
import type { RuntimeToolResult } from './types.js';

export const MAX_VARIANT_GROUPS = 5;
const MAX_INSTANCE_REFS = 50;
const MAX_IMPORTERS_LISTED = 30;
const IMPORTERS_TIMEOUT_MS = 3_000;

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ImpactOptions {
	registry?: RefRegistry;
	/** Plugin marker lookup (test seam). Defaults to `getVitePluginInfo`. */
	pluginInfo?: () => VitePluginInfo | null;
	/** Defaults to the global `fetch`. */
	fetch?: FetchFn;
}

export interface UsageLine {
	line: number;
	count: number;
	refs: string[];
}

export interface UsageFile {
	file: string;
	count: number;
	lines: UsageLine[];
}

export interface VariantGroup {
	/** Root element classes (sorted, svelte-* hashes removed); `''` for none. */
	classes: string;
	count: number;
	refs: string[];
}

export type ImportersStatus = 'ok' | 'unknown' | 'not-found' | 'error';

export interface ImportersInfo {
	status: ImportersStatus;
	files: string[];
	truncated: boolean;
	error?: string;
}

interface Instance {
	root: Element;
	ref: string;
	usedAt: { file: string; line: number; column: number } | null;
	isThis: boolean;
}

/** One entry per rendered instance of `componentName` (its first root element). */
function findInstances(doc: Document, componentName: string): Element[] {
	const roots = allPageElements(doc).filter((e) => isComponentRoot(e, componentName));
	const seen = new Set<unknown>();
	const out: Element[] = [];
	for (const r of roots) {
		const entry = getComponentInstance(r).entry;
		if (entry) {
			if (seen.has(entry)) continue;
			seen.add(entry);
		}
		out.push(r);
	}
	return out;
}

function groupByUsage(instances: Instance[]): UsageFile[] {
	const files = new Map<string, Map<number, UsageLine>>();
	for (const i of instances) {
		const file = i.usedAt?.file ?? '(root component)';
		const line = i.usedAt?.line ?? 0;
		let lines = files.get(file);
		if (!lines) files.set(file, (lines = new Map()));
		const entry = lines.get(line) ?? { line, count: 0, refs: [] };
		entry.count++;
		entry.refs.push(i.ref);
		lines.set(line, entry);
	}
	return [...files.entries()]
		.map(([file, lines]) => {
			const list = [...lines.values()].sort((a, b) => a.line - b.line);
			return { file, count: list.reduce((n, l) => n + l.count, 0), lines: list };
		})
		.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
}

/** Instances grouped by root classes, biggest group first, top {@link MAX_VARIANT_GROUPS}. */
export function groupVariants(instances: { root: Element; ref: string }[]): {
	groups: VariantGroup[];
	total: number;
} {
	const groups = new Map<string, VariantGroup>();
	for (const i of instances) {
		const classes = getClasses(i.root, 100).sort().join(' ');
		const g = groups.get(classes) ?? { classes, count: 0, refs: [] };
		g.count++;
		if (g.refs.length < MAX_INSTANCE_REFS) g.refs.push(i.ref);
		groups.set(classes, g);
	}
	const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
	return { groups: sorted.slice(0, MAX_VARIANT_GROUPS), total: sorted.length };
}

async function fetchImporters(file: string, options: ImpactOptions): Promise<ImportersInfo> {
	const info = (options.pluginInfo ?? getVitePluginInfo)();
	if (!info || !info.importersEndpoint) {
		return { status: 'unknown', files: [], truncated: false };
	}
	const doFetch: FetchFn | undefined =
		options.fetch ?? (typeof fetch === 'function' ? (i, init) => fetch(i, init) : undefined);
	if (!doFetch) return { status: 'unknown', files: [], truncated: false };

	const url = `${info.importersEndpoint}?file=${encodeURIComponent(file)}`;
	const controller = typeof AbortController === 'function' ? new AbortController() : null;
	const timer = setTimeout(() => controller?.abort(), IMPORTERS_TIMEOUT_MS);
	try {
		const res = await doFetch(url, { signal: controller?.signal });
		if (!res.ok)
			return { status: 'error', files: [], truncated: false, error: `HTTP ${res.status}` };
		const body = (await res.json()) as {
			found?: unknown;
			importers?: unknown;
			truncated?: unknown;
		};
		if (body.found === false) return { status: 'not-found', files: [], truncated: false };
		const files = Array.isArray(body.importers)
			? body.importers
					.map((i) =>
						i && typeof i === 'object' && typeof (i as { file?: unknown }).file === 'string'
							? (i as { file: string }).file
							: null
					)
					.filter((f): f is string => f !== null)
			: [];
		return { status: 'ok', files, truncated: body.truncated === true };
	} catch (err) {
		return {
			status: 'error',
			files: [],
			truncated: false,
			error: err instanceof Error ? err.message : String(err)
		};
	} finally {
		clearTimeout(timer);
	}
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The recommendation line (exported for tests). */
export function recommend(
	file: string,
	instanceCount: number,
	importers: ImportersInfo,
	usageSite: string | null
): string {
	const importerCount = importers.status === 'ok' ? importers.files.length : null;
	const shared = instanceCount > 1 || (importerCount !== null && importerCount > 1);
	if (!shared) {
		const caveat =
			importerCount === null
				? ' (importers unknown: other pages may use it too; install svelte-grab/vite to check)'
				: '';
		return `Single usage; editing the component is safe${caveat}.`;
	}
	const imp =
		importerCount === null
			? 'an unknown number of importing files'
			: `${importerCount}${importers.truncated ? '+' : ''} importing file${importerCount === 1 && !importers.truncated ? '' : 's'}`;
	const at = usageSite ? ` at the usage site ${usageSite}` : '';
	return `Changing ${file} affects ${plural(instanceCount, 'instance')} on this page and ${imp}; prefer a prop/variant or a local class${at} for a one-off change.`;
}

export async function uiComponentImpact(
	args: Record<string, unknown>,
	options: ImpactOptions = {}
): Promise<RuntimeToolResult> {
	const registry = options.registry ?? refRegistry;
	const refArg = args.ref;
	if (typeof refArg !== 'string' || refArg.trim() === '') {
		throw new Error(
			'ui_component_impact needs "ref": an eN ref or a ui:// stable key from ui_snapshot/ui_find'
		);
	}
	const resolved = registry.resolve(refArg);
	if (!resolved) {
		throw new Error(
			`Unknown ref "${refArg}": the element is gone or the ref is invalid. Run ui_find or ui_snapshot for fresh refs.`
		);
	}
	const el = resolved.element;
	const doc = el.ownerDocument;
	const src = getElementSource(el);
	const loc = src.loc ?? getSvelteLoc(findMetaElement(el));
	const componentName = src.component;
	if (!componentName || !loc) {
		throw new Error(
			`${resolved.ref} has no Svelte component metadata (not rendered by a .svelte component in dev), so there is no component to assess.`
		);
	}
	const definitionFile = loc.file;
	const shortFile = shortenPath(definitionFile);

	// This element's instance: the one whose usage site a one-off change should go to.
	const thisInstance = getComponentInstance(el);
	const thisEntry = thisInstance.name === componentName ? thisInstance.entry : null;

	const roots = findInstances(doc, componentName);
	const keys = computeStableKeys(roots.slice(0, MAX_INSTANCE_REFS * 4), doc);
	const instances: Instance[] = roots.map((root) => {
		const entry = getComponentInstance(root).entry;
		return {
			root,
			ref: registry.refFor(root, keys.get(root)),
			usedAt: entry ? { file: entry.file, line: entry.line, column: entry.column } : null,
			isThis: thisEntry !== null && entry === thisEntry
		};
	});
	const byFile = groupByUsage(instances);
	const variants = groupVariants(instances);
	const importers = await fetchImporters(definitionFile, options);

	const usageSite = thisEntry ? `${shortenPath(thisEntry.file)}:${thisEntry.line}` : null;
	const recommendation = recommend(shortFile, instances.length, importers, usageSite);

	const role = computeRole(el);
	const name = computeName(el, role);
	const lines: string[] = [];
	if (resolved.rebound) lines.push(`# ${resolved.previous} was stale; rebound to ${resolved.ref}`);
	lines.push(`<${componentName}> defined in ${shortFile}`);
	const head = [resolved.ref, roleOrTag(el, role)];
	if (name) head.push(JSON.stringify(name.length > 60 ? name.slice(0, 59) + '…' : name));
	lines.push(`${head.join(' ')}${usageSite ? ` (this instance is used at ${usageSite})` : ''}`);

	const thisRootRef = instances.find((i) => i.isThis)?.ref;
	const showRefs = (refs: string[]) =>
		refs
			.slice(0, 10)
			.map((r) => (r === thisRootRef ? `${r} (this)` : r))
			.join(', ') + (refs.length > 10 ? ', …' : '');

	lines.push('', `INSTANCES on this page: ${instances.length}`);
	for (const f of byFile) {
		const where = f.lines
			.map(
				(l) =>
					`${l.line ? `line ${l.line}` : 'root'}${l.count > 1 ? ` x${l.count}` : ''} -> ${showRefs(l.refs)}`
			)
			.join('; ');
		lines.push(`  ${shortenPath(f.file)} (${f.count}): ${where}`);
	}

	lines.push('', `VARIANTS (root element classes, svelte-* hashes ignored): ${variants.total}`);
	for (const v of variants.groups) {
		lines.push(`  ${v.classes || '(no class)'} x${v.count} -> ${showRefs(v.refs)}`);
	}
	if (variants.total > variants.groups.length) {
		lines.push(`  … ${variants.total - variants.groups.length} more groups`);
	}

	lines.push('');
	switch (importers.status) {
		case 'ok':
			lines.push(
				`IMPORTERS (Vite module graph): ${importers.files.length}${importers.truncated ? '+ (truncated)' : ''}`
			);
			for (const f of importers.files.slice(0, MAX_IMPORTERS_LISTED)) lines.push(`  ${f}`);
			if (importers.files.length > MAX_IMPORTERS_LISTED) {
				lines.push(`  … ${importers.files.length - MAX_IMPORTERS_LISTED} more`);
			}
			break;
		case 'not-found':
			lines.push(`importers: ${shortFile} is not in the Vite module graph`);
			break;
		case 'error':
			lines.push(`importers: unavailable (${importers.error})`);
			break;
		default:
			lines.push('importers: unknown (install svelte-grab/vite)');
	}

	lines.push('', `Recommendation: ${recommendation}`);

	return {
		text: lines.join('\n'),
		data: {
			ref: resolved.ref,
			stableKey: resolved.stableKey,
			component: componentName,
			definitionFile,
			usedAt: thisEntry
				? { file: thisEntry.file, line: thisEntry.line, column: thisEntry.column }
				: null,
			instances: {
				count: instances.length,
				refs: instances.slice(0, MAX_INSTANCE_REFS).map((i) => i.ref),
				byFile
			},
			variants: variants.groups,
			variantCount: variants.total,
			importers,
			recommendation,
			...(resolved.rebound ? { rebound: true, previous: resolved.previous } : {})
		}
	};
}
