import type { ParsedStackFrame, CapturedError } from '../types.js';

/**
 * Parse a stack trace string into structured frames.
 * Handles Chrome, Firefox, and Safari formats.
 */
export function parseStackTrace(stack: string): ParsedStackFrame[] {
	if (!stack) return [];

	const frames: ParsedStackFrame[] = [];
	const lines = stack.split('\n');

	for (const line of lines) {
		const frame = parseStackFrame(line.trim());
		if (frame) frames.push(frame);
	}

	return frames;
}

/**
 * Parse a single stack frame line
 */
function parseStackFrame(line: string): ParsedStackFrame | null {
	// Chrome/Edge: "    at functionName (file:line:column)"
	const chromeMatch = line.match(/^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
	if (chromeMatch) {
		return {
			functionName: chromeMatch[1] || '(anonymous)',
			file: chromeMatch[2],
			line: parseInt(chromeMatch[3]),
			column: parseInt(chromeMatch[4])
		};
	}

	// Firefox: "functionName@file:line:column"
	const firefoxMatch = line.match(/^(.+?)@(.+?):(\d+):(\d+)$/);
	if (firefoxMatch) {
		return {
			functionName: firefoxMatch[1] || '(anonymous)',
			file: firefoxMatch[2],
			line: parseInt(firefoxMatch[3]),
			column: parseInt(firefoxMatch[4])
		};
	}

	// Safari: "functionName@file:line:column" or "file:line:column"
	const safariMatch = line.match(/^(?:(.+?)@)?(.+?):(\d+):(\d+)$/);
	if (safariMatch && !line.startsWith('at ')) {
		return {
			functionName: safariMatch[1] || '(anonymous)',
			file: safariMatch[2],
			line: parseInt(safariMatch[3]),
			column: parseInt(safariMatch[4])
		};
	}

	return null;
}

/**
 * Filter stack frames to remove node_modules and internal frames
 */
export function filterFrames(frames: ParsedStackFrame[], filterNodeModules = true): ParsedStackFrame[] {
	return frames.filter(frame => {
		if (filterNodeModules && frame.file.includes('node_modules/')) return false;
		if (frame.file.includes('__vite')) return false;
		if (frame.file.startsWith('chrome-extension://')) return false;
		if (frame.file === '<anonymous>') return false;
		return true;
	});
}

/**
 * Find the first Svelte file in the stack
 */
export function findSvelteFrame(frames: ParsedStackFrame[]): ParsedStackFrame | null {
	return frames.find(f => f.file.endsWith('.svelte') || f.file.includes('.svelte?')) || null;
}

/**
 * Extract component name from a file path in a stack frame
 */
export function extractComponentFromFrame(frame: ParsedStackFrame): string | null {
	const match = frame.file.match(/\/([^/]+)\.svelte/);
	return match ? match[1] : null;
}

/**
 * Shorten a file path from a stack frame (may include query params from Vite)
 */
export function shortenFramePath(file: string): string {
	// Remove Vite query params
	const clean = file.replace(/\?.*$/, '');

	const srcMatch = clean.match(/\/src\/(.*)/);
	if (srcMatch) return `src/${srcMatch[1]}`;

	const libMatch = clean.match(/\/lib\/(.*)/);
	if (libMatch) return `lib/${libMatch[1]}`;

	// Remove protocol + host for local dev server
	const localMatch = clean.match(/https?:\/\/[^/]+(\/.*)/);
	if (localMatch) return localMatch[1].slice(1);

	return clean;
}

/**
 * Generate a unique ID for an error for deduplication
 */
export function errorId(message: string, frames: ParsedStackFrame[]): string {
	const firstFrame = frames[0];
	const loc = firstFrame ? `${firstFrame.file}:${firstFrame.line}` : 'unknown';
	return `${message}|${loc}`;
}

/**
 * Detect common error patterns and provide suggestions
 */
export function detectErrorPattern(error: CapturedError): { cause: string; suggestion: string } | null {
	const msg = error.message;

	// Cannot read properties of undefined/null
	const undefinedProp = msg.match(/Cannot read propert(?:y|ies) of (undefined|null) \(reading '(.+?)'\)/);
	if (undefinedProp) {
		const obj = undefinedProp[1];
		const prop = undefinedProp[2];
		return {
			cause: `Tentando acessar '${prop}' de um valor ${obj}`,
			suggestion: `Usar optional chaining: objeto?.${prop}\nOu verificar antes: if (objeto) { ... }`
		};
	}

	// X is not a function
	const notFunc = msg.match(/(.+?) is not a function/);
	if (notFunc) {
		return {
			cause: `'${notFunc[1]}' n\u00E3o \u00E9 uma fun\u00E7\u00E3o`,
			suggestion: `Verificar se o valor est\u00E1 definido e \u00E9 do tipo correto.\nPode ser um problema de import ou prop n\u00E3o passada.`
		};
	}

	// X is not defined
	const notDefined = msg.match(/(.+?) is not defined/);
	if (notDefined) {
		return {
			cause: `Vari\u00E1vel '${notDefined[1]}' n\u00E3o est\u00E1 definida no escopo`,
			suggestion: `Verificar import ou declara\u00E7\u00E3o da vari\u00E1vel.`
		};
	}

	// Assignment to constant
	if (msg.includes('Assignment to constant variable')) {
		return {
			cause: `Tentativa de reatribuir uma vari\u00E1vel const`,
			suggestion: `Usar 'let' ao inv\u00E9s de 'const' se o valor precisa mudar.\nEm Svelte 5, usar $state() para estado reativo.`
		};
	}

	// Maximum call stack
	if (msg.includes('Maximum call stack size exceeded')) {
		return {
			cause: `Recurs\u00E3o infinita detectada`,
			suggestion: `Verificar se h\u00E1 $effect ou $derived criando loop infinito.\nGarantir que updates de estado n\u00E3o triggeram re-execu\u00E7\u00E3o c\u00EDclica.`
		};
	}

	// Failed to fetch
	if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
		return {
			cause: `Falha de rede ao fazer requisi\u00E7\u00E3o`,
			suggestion: `Verificar se a API est\u00E1 rodando.\nAdicionar tratamento de erro com try/catch.\nVerificar CORS se a API est\u00E1 em outro dom\u00EDnio.`
		};
	}

	return null;
}

/**
 * Format captured errors as text for LLM
 */
export function formatErrorsForAgent(errors: CapturedError[], minutesWindow: number): string {
	if (errors.length === 0) return `=== Nenhum erro capturado (últimos ${minutesWindow}min) ===`;

	const parts: string[] = [`=== Erros Capturados (\u00FAltimos ${minutesWindow}min) ===\n`];

	for (const error of errors) {
		const icon = error.type === 'error' || error.type === 'unhandled-rejection' ? '\u{1F534}' : '\u{1F7E1}';
		const typeLabel = error.type === 'error' ? 'ERROR' : error.type === 'warning' ? 'WARNING' : 'UNHANDLED REJECTION';
		const time = new Date(error.timestamp).toLocaleTimeString();

		parts.push(`${icon} ${typeLabel} [${time}]${error.count > 1 ? ` (${error.count}x)` : ''}\n`);
		parts.push(`  ${error.message}\n`);

		if (error.svelteFile) {
			parts.push(`  \u{1F4CD} LOCALIZA\u00C7\u00C3O:`);
			parts.push(`     ${error.svelteFile}${error.svelteLine ? ':' + error.svelteLine : ''}`);
			if (error.componentName) parts.push(`     Componente: <${error.componentName}>`);
			parts.push('');
		}

		if (error.stack.length > 0) {
			parts.push(`  \u{1F4DD} STACK:`);
			for (const frame of error.stack.slice(0, 5)) {
				parts.push(`     ${frame.functionName} \u2192 ${shortenFramePath(frame.file)}:${frame.line}`);
			}
			parts.push('');
		}

		const pattern = detectErrorPattern(error);
		if (pattern) {
			parts.push(`  \u{1F4A1} CAUSA PROV\u00C1VEL:`);
			parts.push(`     ${pattern.cause}\n`);
			parts.push(`  \u2705 SUGEST\u00C3O:`);
			pattern.suggestion.split('\n').forEach(s => parts.push(`     ${s}`));
			parts.push('');
		}

		parts.push('\u2500'.repeat(40) + '\n');
	}

	return parts.join('\n');
}
