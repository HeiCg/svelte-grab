import type { SvelteGrabPlugin, ContextMenuAction, PluginHooks } from '../types.js';

/**
 * Registry for managing SvelteGrab plugins.
 * Handles registration, lifecycle, and hook execution.
 */
export class PluginRegistry {
	private plugins: Map<string, SvelteGrabPlugin> = new Map();

	/**
	 * Register a plugin. Calls setup() if provided.
	 */
	register(plugin: SvelteGrabPlugin, api?: unknown): void {
		if (this.plugins.has(plugin.name)) {
			console.warn(`[SvelteGrab] Plugin "${plugin.name}" already registered, replacing.`);
			this.unregister(plugin.name);
		}

		this.plugins.set(plugin.name, plugin);

		if (plugin.setup && api) {
			try {
				plugin.setup(api as import('../types.js').SvelteGrabAPI);
			} catch (err) {
				console.error(`[SvelteGrab] Plugin "${plugin.name}" setup error:`, err);
			}
		}
	}

	/**
	 * Unregister a plugin. Calls teardown() if provided.
	 */
	unregister(name: string): void {
		const plugin = this.plugins.get(name);
		if (plugin) {
			if (plugin.teardown) {
				try {
					plugin.teardown();
				} catch (err) {
					console.error(`[SvelteGrab] Plugin "${name}" teardown error:`, err);
				}
			}
			this.plugins.delete(name);
		}
	}

	/**
	 * Get all registered plugins.
	 */
	getAll(): SvelteGrabPlugin[] {
		return [...this.plugins.values()];
	}

	/**
	 * Execute a hook on all plugins that have it.
	 * Errors are caught and logged silently.
	 */
	async executeHook<K extends keyof PluginHooks>(
		hookName: K,
		...args: Parameters<NonNullable<PluginHooks[K]>>
	): Promise<void> {
		for (const plugin of this.plugins.values()) {
			const hook = plugin.hooks?.[hookName];
			if (hook) {
				try {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					await (hook as (...a: any[]) => any)(...args);
				} catch (err) {
					console.error(`[SvelteGrab] Plugin "${plugin.name}" hook "${hookName}" error:`, err);
				}
			}
		}
	}

	/**
	 * Collect context menu actions from all plugins.
	 */
	getContextMenuActions(): ContextMenuAction[] {
		const actions: ContextMenuAction[] = [];
		for (const plugin of this.plugins.values()) {
			if (plugin.actions) {
				actions.push(...plugin.actions);
			}
		}
		return actions;
	}

	/**
	 * Run a transform hook, piping content through each plugin.
	 * Returns the final transformed value, or the original if no transforms.
	 */
	transformContent<T>(hookName: keyof PluginHooks, content: T, context: unknown): T {
		let result = content;
		for (const plugin of this.plugins.values()) {
			const hook = plugin.hooks?.[hookName];
			if (hook) {
				try {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const transformed = (hook as (...a: any[]) => any)(result, context);
					if (transformed !== undefined) {
						result = transformed;
					}
				} catch (err) {
					console.error(`[SvelteGrab] Plugin "${plugin.name}" transform "${hookName}" error:`, err);
				}
			}
		}
		return result;
	}

	/**
	 * Unregister all plugins.
	 */
	clear(): void {
		for (const name of [...this.plugins.keys()]) {
			this.unregister(name);
		}
	}
}
