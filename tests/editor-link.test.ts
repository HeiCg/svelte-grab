// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
	buildViteOpenInEditorUrl,
	detectProjectRoot,
	detectViteProjectRoot,
	openInEditor,
	resolveFileForVite,
	_resetViteProjectRootCache
} from '../src/lib/utils/editor-link.js';
import { VITE_PLUGIN_GLOBAL, getVitePluginInfo } from '../src/lib/utils/vite-plugin-info.js';

const ROOT = '/Users/me/app';

function installPlugin(root = ROOT): void {
	(window as unknown as Record<string, unknown>)[VITE_PLUGIN_GLOBAL] = {
		version: '1.4.2',
		root,
		hmrBridge: true,
		importersEndpoint: '/__svelte-grab/importers'
	};
}

const flush = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

afterEach(() => {
	delete (window as unknown as Record<string, unknown>)[VITE_PLUGIN_GLOBAL];
	_resetViteProjectRootCache();
	document.head.innerHTML = '';
});

describe('svelte-grab/vite marker', () => {
	it('reads the plugin marker, ignoring malformed values', () => {
		expect(getVitePluginInfo()).toBeNull();
		(window as unknown as Record<string, unknown>)[VITE_PLUGIN_GLOBAL] = { version: 1 };
		expect(getVitePluginInfo()).toBeNull();
		installPlugin();
		expect(getVitePluginInfo()).toEqual({
			version: '1.4.2',
			root: ROOT,
			hmrBridge: true,
			importersEndpoint: '/__svelte-grab/importers'
		});
	});

	it('the plugin root wins over the /@fs/ heuristic', () => {
		const script = document.createElement('script');
		script.setAttribute('src', '/@fs/Users/guess/proj/node_modules/.vite/deps/x.js');
		document.head.append(script);
		expect(detectViteProjectRoot()).toBe('/Users/guess/proj');
		installPlugin();
		expect(detectViteProjectRoot()).toBe(ROOT);
		expect(detectProjectRoot('src/App.svelte')).toBe(ROOT);
	});
});

describe('resolveFileForVite', () => {
	it('joins root-relative paths to the root and keeps absolute ones', () => {
		expect(resolveFileForVite('src/App.svelte', ROOT)).toBe(`${ROOT}/src/App.svelte`);
		expect(resolveFileForVite('./src/App.svelte', `${ROOT}/`)).toBe(`${ROOT}/src/App.svelte`);
		expect(resolveFileForVite('/src/App.svelte', ROOT)).toBe(`${ROOT}/src/App.svelte`);
		expect(resolveFileForVite(`${ROOT}/src/App.svelte`, ROOT)).toBe(`${ROOT}/src/App.svelte`);
		expect(resolveFileForVite('/opt/shared/Button.svelte', ROOT)).toBe('/opt/shared/Button.svelte');
		expect(resolveFileForVite('C:\\app\\src\\App.svelte', ROOT)).toBe('C:/app/src/App.svelte');
		expect(resolveFileForVite('src/App.svelte', null)).toBe('src/App.svelte');
	});
});

describe('openInEditor', () => {
	it('without the plugin follows the editor deep link', () => {
		const fetch = vi.fn();
		const openUrl = vi.fn();
		openInEditor('src/App.svelte', 12, 'cursor', ROOT, { fetch, openUrl });
		expect(fetch).not.toHaveBeenCalled();
		expect(openUrl).toHaveBeenCalledWith(`cursor://file${ROOT}/src/App.svelte:12`);
	});

	it('with the plugin asks Vite /__open-in-editor with an absolute file:line:col', async () => {
		installPlugin();
		expect(buildViteOpenInEditorUrl('src/App.svelte', 12)).toBe(
			`/__open-in-editor?file=${encodeURIComponent(`${ROOT}/src/App.svelte:12:1`)}`
		);
		const fetch = vi.fn().mockResolvedValue({ ok: true });
		const openUrl = vi.fn();
		openInEditor('src/App.svelte', 12, 'vscode', null, { fetch, openUrl });
		await flush();
		expect(fetch).toHaveBeenCalledWith(`/__open-in-editor?file=${encodeURIComponent(`${ROOT}/src/App.svelte:12:1`)}`);
		expect(openUrl).not.toHaveBeenCalled();
	});

	it('falls back to the deep link when the Vite request fails', async () => {
		installPlugin();
		const openUrl = vi.fn();
		openInEditor('src/App.svelte', 3, 'vscode', null, { fetch: vi.fn().mockResolvedValue({ ok: false }), openUrl });
		await flush();
		expect(openUrl).toHaveBeenCalledWith(`vscode://file${ROOT}/src/App.svelte:3`);

		openUrl.mockClear();
		openInEditor('src/App.svelte', 4, 'zed', null, { fetch: vi.fn().mockRejectedValue(new Error('down')), openUrl });
		await flush();
		expect(openUrl).toHaveBeenCalledWith(`zed://file${ROOT}/src/App.svelte:4`);
	});

	it('editor "none" opens nothing', async () => {
		installPlugin();
		const fetch = vi.fn().mockResolvedValue({ ok: true });
		const openUrl = vi.fn();
		openInEditor('src/App.svelte', 1, 'none', ROOT, { fetch, openUrl });
		await flush();
		expect(fetch).not.toHaveBeenCalled();
		expect(openUrl).not.toHaveBeenCalled();
	});
});
