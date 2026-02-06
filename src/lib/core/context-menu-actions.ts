import type { ContextMenuAction } from '../types.js';

/**
 * Default context menu actions for SvelteGrab.
 * These are used when showContextMenu is enabled.
 *
 * Action handlers receive callbacks that the SvelteGrab component provides.
 */
export function createDefaultActions(callbacks: {
	copyForAgent: () => void;
	copyHtml: () => void;
	copyPaths: () => void;
	openInEditor: () => void;
	captureScreenshot: () => void;
	sendToAgent: () => void;
	hasEditor: boolean;
	hasScreenshot: boolean;
	hasAgentRelay: boolean;
}): ContextMenuAction[] {
	const actions: ContextMenuAction[] = [
		{
			id: 'copy-agent',
			label: 'Copy for Agent',
			icon: '📋',
			shortcut: 'Cmd+C',
			onAction: () => callbacks.copyForAgent()
		},
		{
			id: 'copy-html',
			label: 'Copy HTML',
			icon: '<>',
			onAction: () => callbacks.copyHtml()
		},
		{
			id: 'copy-paths',
			label: 'Copy Paths',
			icon: '📁',
			onAction: () => callbacks.copyPaths()
		},
		{
			id: 'divider-1',
			label: '',
			divider: true,
			onAction: () => {}
		}
	];

	if (callbacks.hasEditor) {
		actions.push({
			id: 'open-editor',
			label: 'Open in Editor',
			icon: '↗',
			shortcut: 'O',
			onAction: () => callbacks.openInEditor()
		});
	}

	if (callbacks.hasScreenshot) {
		actions.push({
			id: 'screenshot',
			label: 'Screenshot',
			icon: '📸',
			shortcut: 'S',
			onAction: () => callbacks.captureScreenshot()
		});
	}

	if (callbacks.hasEditor || callbacks.hasScreenshot) {
		actions.push({
			id: 'divider-2',
			label: '',
			divider: true,
			onAction: () => {}
		});
	}

	if (callbacks.hasAgentRelay) {
		actions.push({
			id: 'send-agent',
			label: 'Send to Agent',
			icon: '🤖',
			shortcut: 'Tab',
			onAction: () => callbacks.sendToAgent()
		});
	}

	return actions;
}
