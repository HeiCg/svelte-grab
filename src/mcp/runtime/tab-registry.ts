/**
 * Registry of browser tabs connected to the agent runtime channel.
 *
 * Wire contract v1 (docs/agent-runtime-spec.md): the page POSTs
 * `/runtime/hello {tabId, url, title, focused}` on SSE connect, on
 * focus/blur/visibilitychange and every 15s as heartbeat. Tabs not seen for
 * 45s are forgotten. Active tab = most recent `focused: true` hello, else the
 * most recently seen tab.
 */

/** Tabs not seen for this long are forgotten. */
export const TAB_EXPIRY_MS = 45_000;
/** Cap on tracked tabs (bounds memory); the least recently seen is evicted. */
export const MAX_TABS = 50;

export interface TabHello {
	tabId: string;
	url: string;
	title: string;
	focused: boolean;
}

export interface TabEntry extends TabHello {
	/** Epoch ms of the last hello from this tab. */
	lastSeen: number;
	/** Monotonic order of the last hello (breaks same-millisecond ties). */
	seenSeq: number;
	/** Monotonic order of the last `focused: true` hello, or 0 if never focused. */
	focusSeq: number;
}

/** Public view of a tab, as listed by `ui_tabs`. */
export interface TabSummary {
	tabId: string;
	url: string;
	title: string;
	focused: boolean;
	lastSeen: number;
	active: boolean;
}

export interface TabRegistryOptions {
	now?: () => number;
	expiryMs?: number;
	maxTabs?: number;
}

export class TabRegistry {
	private readonly tabs = new Map<string, TabEntry>();
	private readonly now: () => number;
	private readonly expiryMs: number;
	private readonly maxTabs: number;
	private seq = 0;

	constructor(options: TabRegistryOptions = {}) {
		this.now = options.now ?? (() => Date.now());
		this.expiryMs = options.expiryMs ?? TAB_EXPIRY_MS;
		this.maxTabs = options.maxTabs ?? MAX_TABS;
	}

	/** Record a hello/heartbeat from a tab. */
	hello(hello: TabHello): TabEntry {
		this.prune();
		const seq = ++this.seq;
		const existing = this.tabs.get(hello.tabId);

		if (!existing && this.tabs.size >= this.maxTabs) {
			this.evictLeastRecentlySeen();
		}

		const entry: TabEntry = {
			tabId: hello.tabId,
			url: hello.url,
			title: hello.title,
			focused: hello.focused,
			lastSeen: this.now(),
			seenSeq: seq,
			focusSeq: hello.focused ? seq : (existing?.focusSeq ?? 0)
		};
		this.tabs.set(hello.tabId, entry);
		return entry;
	}

	/** Forget tabs not seen within the expiry window. */
	prune(): void {
		const cutoff = this.now() - this.expiryMs;
		for (const [id, tab] of this.tabs) {
			if (tab.lastSeen < cutoff) this.tabs.delete(id);
		}
	}

	get(tabId: string): TabEntry | undefined {
		this.prune();
		return this.tabs.get(tabId);
	}

	/** Live tabs, most recently seen first. */
	list(): TabEntry[] {
		this.prune();
		return [...this.tabs.values()].sort((a, b) => b.seenSeq - a.seenSeq);
	}

	/**
	 * Active tab: the most recent `focused: true` hello among live tabs (even if
	 * that tab later blurred — the user may be in the editor), else the most
	 * recently seen tab.
	 */
	active(): TabEntry | undefined {
		const tabs = this.list();
		let best: TabEntry | undefined;
		for (const tab of tabs) {
			if (tab.focusSeq > 0 && (!best || tab.focusSeq > best.focusSeq)) best = tab;
		}
		return best ?? tabs[0];
	}

	summaries(): TabSummary[] {
		const active = this.active();
		return this.list().map((tab) => ({
			tabId: tab.tabId,
			url: tab.url,
			title: tab.title,
			focused: tab.focused,
			lastSeen: tab.lastSeen,
			active: tab.tabId === active?.tabId
		}));
	}

	get size(): number {
		this.prune();
		return this.tabs.size;
	}

	private evictLeastRecentlySeen(): void {
		let oldest: TabEntry | undefined;
		for (const tab of this.tabs.values()) {
			if (!oldest || tab.seenSeq < oldest.seenSeq) oldest = tab;
		}
		if (oldest) this.tabs.delete(oldest.tabId);
	}
}
