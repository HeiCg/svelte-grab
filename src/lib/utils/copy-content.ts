/**
 * Multi-format clipboard copy utility.
 *
 * Copies content to the clipboard in three formats simultaneously:
 * - text/plain — raw text
 * - text/html — wrapped in <pre><code>
 * - application/x-svelte-grab — JSON metadata for programmatic consumers
 *
 * Falls back to navigator.clipboard.writeText when execCommand is unavailable.
 */

export interface CopyEntry {
	tagName?: string;
	componentName?: string;
	content: string;
}

export interface CopyMetadata {
	version: string;
	content: string;
	entries: CopyEntry[];
	timestamp: number;
}

export const SVELTE_GRAB_MIME = 'application/x-svelte-grab';

/**
 * Escape HTML special characters for safe embedding in markup.
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Copy content to the clipboard in multiple formats.
 *
 * Sets text/plain, text/html (wrapped in pre>code), and the custom
 * application/x-svelte-grab MIME type with JSON metadata.
 *
 * @param content - The plain text content to copy
 * @param options - Optional entries for structured metadata
 * @returns `true` if the copy succeeded, `false` otherwise
 */
export function copyMultiFormat(
	content: string,
	options?: { entries?: CopyEntry[] }
): boolean {
	const entries: CopyEntry[] = options?.entries ?? [{ content }];

	const metadata: CopyMetadata = {
		version: '1.0.0',
		content,
		entries,
		timestamp: Date.now()
	};

	const htmlContent = `<pre><code>${escapeHtml(content)}</code></pre>`;
	const metadataJson = JSON.stringify(metadata);

	// Custom copy event handler that sets all three MIME types
	const copyHandler = (event: ClipboardEvent) => {
		event.preventDefault();
		event.clipboardData?.setData('text/plain', content);
		event.clipboardData?.setData('text/html', htmlContent);
		event.clipboardData?.setData(SVELTE_GRAB_MIME, metadataJson);
	};

	document.addEventListener('copy', copyHandler);

	// Create a temporary textarea, select its content, and trigger copy
	const textarea = document.createElement('textarea');
	textarea.value = content;
	textarea.style.position = 'fixed';
	textarea.style.left = '-9999px';
	textarea.style.top = '-9999px';
	textarea.style.opacity = '0';
	textarea.ariaHidden = 'true';
	document.body.appendChild(textarea);
	textarea.select();

	try {
		const success = document.execCommand('copy');
		if (success) {
			return true;
		}
	} catch {
		// execCommand not available — fall through to fallback
	} finally {
		document.removeEventListener('copy', copyHandler);
		textarea.remove();
	}

	// Fallback: navigator.clipboard.writeText (plain text only)
	try {
		navigator.clipboard.writeText(content);
		return true;
	} catch {
		return false;
	}
}
