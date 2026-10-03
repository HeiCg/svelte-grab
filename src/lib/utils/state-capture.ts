/**
 * Pure state capture + agent formatting for SvelteStateGrab.
 *
 * Extracted from SvelteStateGrab.svelte so the agent runtime (`ui_inspect`)
 * reuses the exact same logic. Component state (diff/snapshot history) is
 * passed in explicitly; the `inspectable()` registry is injectable so the
 * capture can be unit tested without the Svelte compiler.
 */
import type {
	ComponentStateInfo,
	InspectableStateInstance,
	StateDiff,
	StateSnapshot
} from '../types.js';
import type { SvelteElement } from './shared.js';
import { getSvelteLoc } from './component-stack.js';
import { shortenPath, extractComponentName } from './shared.js';
import { inlinePreview } from './serializer.js';
import { getInspectableInstances, getInspectableIds } from './inspectable.svelte.js';

/** Read access to the `inspectable()` registry. */
export interface InspectableLookup {
	getInstances(name: string): { label: string; instance: number; values: Record<string, unknown> }[];
	getIds(): string[];
}

/** The app-wide `inspectable()` registry. */
export const defaultInspectableLookup: InspectableLookup = {
	getInstances: getInspectableInstances,
	getIds: getInspectableIds
};

/**
 * `inspectable()` instances registered under `componentName` (exact first,
 * then case-insensitive). An element cannot be tied to a specific instance
 * reliably, so every live instance is returned. `undefined` when none.
 */
export function findInspectableInstances(
	componentName: string | null,
	lookup: InspectableLookup = defaultInspectableLookup
): InspectableStateInstance[] | undefined {
	if (!componentName) return undefined;
	let name: string | undefined = componentName;
	if (lookup.getInstances(name).length === 0) {
		const lower = componentName.toLowerCase();
		name = lookup.getIds().find(id => id.toLowerCase() === lower);
	}
	if (!name) return undefined;
	const found = lookup.getInstances(name).map(({ label, instance, values }) => ({
		label,
		instance,
		values
	}));
	return found.length > 0 ? found : undefined;
}

/**
 * Extract component state from an element
 */
export function extractComponentState(
	element: SvelteElement,
	lookup: InspectableLookup = defaultInspectableLookup
): ComponentStateInfo {
	const loc = getSvelteLoc(element);
	const file = loc?.file || 'unknown';
	const line = loc?.line || 0;
	const componentName = extractComponentName(file);
	const tag = element.tagName.toLowerCase();

	// Collect regular attributes
	const attributes: Record<string, string> = {};
	const dataAttributes: Record<string, string> = {};

	for (const attr of Array.from(element.attributes)) {
		if (attr.name.startsWith('data-')) {
			dataAttributes[attr.name] = attr.value;
		} else if (!attr.name.startsWith('__') && attr.name !== 'class' && attr.name !== 'style') {
			attributes[attr.name] = attr.value;
		}
	}

	// Try to extract props from Svelte component context
	const props: Record<string, unknown> = {};
	const boundValues: Record<string, unknown> = {};

	// Access class and style separately as they're common props
	if (element.className) {
		props['class'] = String(element.className);
	}
	if (element.style.cssText) {
		props['style'] = element.style.cssText;
	}

	// Try to access Svelte 5 component internals
	// In Svelte 5, component instances may expose state via $$
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const svelteInternals = (element as any).$$;
	if (svelteInternals) {
		// Try to read props
		if (svelteInternals.props) {
			try {
				const p = svelteInternals.props;
				if (typeof p === 'object' && p !== null) {
					for (const key of Object.keys(p)) {
						props[key] = p[key];
					}
				}
			} catch { /* props not accessible */ }
		}
		// Try to read context/state
		if (svelteInternals.ctx) {
			try {
				const ctx = svelteInternals.ctx;
				if (Array.isArray(ctx)) {
					ctx.forEach((val: unknown, idx: number) => {
						if (val !== undefined && val !== null && typeof val !== 'function') {
							boundValues[`ctx[${idx}]`] = val;
						}
					});
				}
			} catch { /* ctx not accessible */ }
		}
	}

	// Extract observable properties from common form elements
	if (element instanceof HTMLInputElement) {
		boundValues['value'] = element.value;
		boundValues['checked'] = element.checked;
		boundValues['type'] = element.type;
		if (element.name) boundValues['name'] = element.name;
	} else if (element instanceof HTMLSelectElement) {
		boundValues['value'] = element.value;
		boundValues['selectedIndex'] = element.selectedIndex;
	} else if (element instanceof HTMLTextAreaElement) {
		boundValues['value'] = element.value;
	}

	// Text content for leaf elements
	if (element.children.length === 0 && element.textContent?.trim()) {
		boundValues['textContent'] = element.textContent.trim().slice(0, 200);
	}

	// Collect child components with details
	const childMap = new Map<string, { name: string; file: string; count: number }>();
	element.querySelectorAll('*').forEach(child => {
		const childLoc = getSvelteLoc(child);
		if (childLoc) {
			const childFile = childLoc.file;
			if (childFile !== file) {
				const existing = childMap.get(childFile);
				if (existing) {
					existing.count++;
				} else {
					childMap.set(childFile, {
						name: extractComponentName(childFile) || 'unknown',
						file: shortenPath(childFile),
						count: 1
					});
				}
			}
		}
	});
	const childComponents = Array.from(childMap.values());
	const childComponentCount = childComponents.reduce((sum, c) => sum + c.count, 0);

	const inspectableInstances = findInspectableInstances(componentName, lookup);
	const inspectableState = inspectableInstances?.[0]?.values;

	return {
		componentName,
		file: shortenPath(file),
		line,
		props,
		attributes,
		dataAttributes,
		boundValues,
		inspectableState,
		inspectableInstances,
		childComponentCount,
		childComponents,
		elementTag: tag
	};
}

/**
 * Format state for LLM agent. `diffs` / `snapshots` are SvelteStateGrab's
 * capture history (pass `[]` when there is none).
 */
export function formatStateForAgent(
	info: ComponentStateInfo,
	diffs: StateDiff[] = [],
	snapshots: StateSnapshot[] = []
): string {
	const parts: string[] = [
		`=== Component State: ${info.componentName || info.elementTag} ===\n`
	];

	if (Object.keys(info.props).length > 0) {
		parts.push('\u{1F4E5} OBSERVABLE PROPS/ATTRIBUTES:');
		for (const [key, value] of Object.entries(info.props)) {
			parts.push(`  ${key}: ${inlinePreview(value)}`);
		}
		parts.push('');
	}

	if (Object.keys(info.attributes).length > 0) {
		parts.push('\u{1F3F7}️ HTML ATTRIBUTES:');
		for (const [key, value] of Object.entries(info.attributes)) {
			parts.push(`  ${key}: "${value}"`);
		}
		parts.push('');
	}

	if (Object.keys(info.dataAttributes).length > 0) {
		parts.push('\u{1F4CA} DATA ATTRIBUTES:');
		for (const [key, value] of Object.entries(info.dataAttributes)) {
			parts.push(`  ${key}: "${value}"`);
		}
		parts.push('');
	}

	if (Object.keys(info.boundValues).length > 0) {
		parts.push('\u{1F517} BOUND/OBSERVABLE VALUES:');
		for (const [key, value] of Object.entries(info.boundValues)) {
			parts.push(`  ${key}: ${inlinePreview(value)}`);
		}
		parts.push('');
	}

	const instances = info.inspectableInstances ?? [];
	if (instances.length === 1 && Object.keys(instances[0].values).length > 0) {
		parts.push('\u{1F50D} INSPECTABLE STATE ($state):');
		for (const [key, value] of Object.entries(instances[0].values)) {
			parts.push(`  ${key}: ${inlinePreview(value)}`);
		}
		parts.push('');
	} else if (instances.length > 1) {
		parts.push(`\u{1F50D} INSPECTABLE STATE ($state, ${instances.length} instances):`);
		for (const inst of instances) {
			parts.push(`  [${inst.label}]`);
			for (const [key, value] of Object.entries(inst.values)) {
				parts.push(`    ${key}: ${inlinePreview(value)}`);
			}
		}
		parts.push('');
	}

	if (info.childComponents.length > 0) {
		parts.push(`\u{1F333} CHILD COMPONENTS (${info.childComponentCount} total, ${info.childComponents.length} unique):`);
		for (const child of info.childComponents) {
			parts.push(`  <${child.name}> ${child.file}${child.count > 1 ? ` (x${child.count})` : ''}`);
		}
		parts.push('');
	}

	if (diffs.length > 0) {
		parts.push('\u{1F504} STATE CHANGES (since last capture):');
		for (const diff of diffs) {
			const oldStr = diff.oldValue === undefined ? '(new)' : inlinePreview(diff.oldValue);
			const newStr = diff.newValue === undefined ? '(removed)' : inlinePreview(diff.newValue);
			parts.push(`  ${diff.key}: ${oldStr} → ${newStr}`);
		}
		parts.push('');
	}

	if (snapshots.length > 1) {
		const componentSnapshots = snapshots.filter(s => s.file === info.file);
		if (componentSnapshots.length > 1) {
			parts.push(`\u{1F4F8} SNAPSHOT HISTORY (${componentSnapshots.length} captures for this component):`);
			for (const snap of componentSnapshots.slice(0, 5)) {
				parts.push(`  [${new Date(snap.timestamp).toLocaleTimeString()}] ${Object.keys(snap.state).length} values`);
			}
			parts.push('');
		}
	}

	parts.push(`\u{1F4CD} Location: ${info.file}:${info.line}`);

	return parts.join('\n');
}

/**
 * Collect all state values into a flat record for snapshot comparison
 */
export function collectStateValues(info: ComponentStateInfo): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(info.props)) values[`props.${k}`] = v;
	for (const [k, v] of Object.entries(info.boundValues)) values[`bound.${k}`] = v;
	const instances = info.inspectableInstances ?? [];
	for (const inst of instances) {
		const prefix = instances.length > 1 ? `state#${inst.instance}` : 'state';
		for (const [k, v] of Object.entries(inst.values)) values[`${prefix}.${k}`] = v;
	}
	return values;
}

/**
 * Compare two snapshots and return the diffs
 */
export function computeStateDiffs(prev: Record<string, unknown>, curr: Record<string, unknown>): StateDiff[] {
	const result: StateDiff[] = [];
	const allKeys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
	for (const key of allKeys) {
		const oldVal = prev[key];
		const newVal = curr[key];
		if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
			result.push({ key, oldValue: oldVal, newValue: newVal });
		}
	}
	return result;
}
