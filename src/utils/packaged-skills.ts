/**
 * Locate and read the agent skills shipped in the package (`skills/` at the
 * package root, listed in package.json `files`). Used by the CLI
 * (`svelte-grab init`, `svelte-grab skills`) and the MCP prompts.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SkillFile } from '../cli/skills-plan.js';

/**
 * Absolute path of the packaged `skills/` directory, or null if it is missing.
 * This module is `src/utils/packaged-skills.ts` in the repo and
 * `dist/utils/packaged-skills.js` in the published package: the package root
 * is two levels up in both.
 */
export function packagedSkillsDir(): string | null {
	const dir = fileURLToPath(new URL('../../skills/', import.meta.url));
	return existsSync(join(dir, 'svelte-grab', 'SKILL.md')) ? dir : null;
}

/**
 * Version of the installed svelte-grab package (recorded in the skills
 * manifest), or null when package.json cannot be read. Same two-levels-up
 * layout as packagedSkillsDir().
 */
export function packageVersion(): string | null {
	try {
		const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8'));
		return pkg?.name === 'svelte-grab' && typeof pkg.version === 'string' ? pkg.version : null;
	} catch {
		return null;
	}
}

/**
 * Every file of every skill under `dir` (one folder per skill with a
 * SKILL.md), sorted by path so plans and listings are stable.
 */
export function readSkillFiles(dir: string): SkillFile[] {
	const out: SkillFile[] = [];
	const skills = readdirSync(dir)
		.filter((name) => statSync(join(dir, name)).isDirectory() && existsSync(join(dir, name, 'SKILL.md')))
		.sort();
	for (const skill of skills) {
		const walk = (rel: string) => {
			for (const name of readdirSync(join(dir, rel)).sort()) {
				if (name.startsWith('.')) continue;
				const childRel = `${rel}/${name}`;
				if (statSync(join(dir, childRel)).isDirectory()) walk(childRel);
				else out.push({ skill, path: childRel, content: readFileSync(join(dir, childRel), 'utf-8') });
			}
		};
		walk(skill);
	}
	return out;
}

/** Read one packaged skill file (`<skill>/<file>`), or null when unavailable. */
export function readPackagedSkillFile(relPath: string): string | null {
	const dir = packagedSkillsDir();
	if (!dir) return null;
	try {
		return readFileSync(join(dir, relPath), 'utf-8');
	} catch {
		return null;
	}
}
