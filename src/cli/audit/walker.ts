/**
 * File walker for `svelte-grab audit`: source files (`.svelte`, JS/TS) and
 * `.env*` files under the root, skipping the default build/dependency
 * directories and whatever `.gitignore` files (root and nested) exclude.
 *
 * `.gitignore` support is the common subset: blank lines and `#` comments,
 * `!` negation, trailing `/` (directories only), leading or inner `/`
 * (anchored to the .gitignore's directory), `*`, `?`, `**`, `[...]`.
 *
 * `.env*` files are scanned even when gitignored: `PUBLIC_` / `VITE_` values
 * end up in the client bundle whether or not the file is committed.
 * Symlinks are not followed.
 */
import { lstatSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { isCodeFile, isEnvFile } from './source.js';

export const DEFAULT_IGNORES = ['node_modules', 'dist', 'build', '.svelte-kit', '.git', 'coverage', '.vercel', '.netlify', '.output'];
export const DEFAULT_MAX_FILE_SIZE = 1024 * 1024;

interface IgnoreRule {
	/** Directory (relative to the root, '' for the root) of the .gitignore. */
	base: string;
	regex: RegExp;
	negate: boolean;
	dirOnly: boolean;
}

/** Glob (gitignore flavour) to a regex source, without anchors. */
function globToRegex(glob: string): string {
	let re = '';
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === '*') {
			if (glob[i + 1] === '*') {
				// `**/` matches zero or more directories, trailing `**` everything.
				if (glob[i + 2] === '/') {
					re += '(?:.*/)?';
					i += 2;
				} else {
					re += '.*';
					i += 1;
				}
			} else re += '[^/]*';
		} else if (ch === '?') re += '[^/]';
		else if (ch === '[') {
			const end = glob.indexOf(']', i + 1);
			if (end === -1) re += '\\[';
			else {
				re += '[' + glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
				i = end;
			}
		} else if (ch === '\\' && i + 1 < glob.length) {
			re += '\\' + glob[++i];
		} else re += ch.replace(/[.+^${}()|\\]/g, '\\$&');
	}
	return re;
}

/** Parse a .gitignore body located in directory `base` (relative). */
export function parseGitignore(body: string, base = ''): IgnoreRule[] {
	const rules: IgnoreRule[] = [];
	for (const raw of body.split(/\r?\n/)) {
		let line = raw.replace(/(?<!\\)\s+$/, '');
		if (!line || line.startsWith('#')) continue;
		let negate = false;
		if (line.startsWith('!')) {
			negate = true;
			line = line.slice(1);
		}
		if (line.startsWith('\\')) line = line.slice(1);
		let dirOnly = false;
		if (line.endsWith('/')) {
			dirOnly = true;
			line = line.slice(0, -1);
		}
		if (!line) continue;
		const anchored = line.includes('/');
		if (line.startsWith('/')) line = line.slice(1);
		const body = globToRegex(line);
		const regex = new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`);
		rules.push({ base, regex, negate, dirOnly });
	}
	return rules;
}

/** Whether `rel` (relative to the root) is ignored; the last matching rule wins. */
export function isIgnored(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
	let ignored = false;
	for (const rule of rules) {
		if (rule.dirOnly && !isDir) continue;
		let path = rel;
		if (rule.base) {
			if (!rel.startsWith(rule.base + '/')) continue;
			path = rel.slice(rule.base.length + 1);
		}
		if (rule.regex.test(path)) ignored = !rule.negate;
	}
	return ignored;
}

export interface WalkResult {
	/** Relative paths (`/` separators) of the files to scan, sorted. */
	files: string[];
	/** Relative paths skipped for size. */
	skipped: string[];
}

/** Collect the files to scan under `root`. */
export function walkFiles(root: string, maxFileSize = DEFAULT_MAX_FILE_SIZE): WalkResult {
	const files: string[] = [];
	const skipped: string[] = [];

	const visit = (dirRel: string, inherited: IgnoreRule[]): void => {
		const dirAbs = dirRel ? join(root, dirRel) : root;
		let rules = inherited;
		try {
			const gitignore = readFileSync(join(dirAbs, '.gitignore'), 'utf-8');
			rules = [...inherited, ...parseGitignore(gitignore, dirRel)];
		} catch {
			// no .gitignore here
		}
		let entries: string[];
		try {
			entries = readdirSync(dirAbs).sort();
		} catch {
			return;
		}
		for (const name of entries) {
			const rel = dirRel ? `${dirRel}/${name}` : name;
			let stat;
			try {
				stat = lstatSync(join(root, rel));
			} catch {
				continue;
			}
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) {
				if (DEFAULT_IGNORES.includes(name) || isIgnored(rules, rel, true)) continue;
				visit(rel, rules);
				continue;
			}
			if (!stat.isFile()) continue;
			const env = isEnvFile(rel);
			if (!env && !isCodeFile(rel)) continue;
			if (!env && isIgnored(rules, rel, false)) continue;
			if (stat.size > maxFileSize) {
				skipped.push(rel);
				continue;
			}
			files.push(rel);
		}
	};

	visit('', []);
	return { files, skipped };
}
