/**
 * Pure planner for installing the agent skills (`skills/` in the package) into
 * a project. Shared by `svelte-grab init` / `svelte-grab skills install`
 * (src/cli/skills.ts, which reads and writes the files) and the `sv` add-on
 * (src/sv/plan.ts, which reads the packaged skill files and writes through sv).
 *
 * No file system access here: callers pass the skill files and a reader for
 * the project, then apply `plan.writes` and `plan.removes`.
 */

/** One file of a packaged skill, e.g. `{ skill: 'svelte-grab-audit', path: 'svelte-grab-audit/CHECKLIST.md' }`. */
export interface SkillFile {
	/** Skill (folder) name. */
	skill: string;
	/** Path relative to the skills root, `/`-separated, starting with the skill folder. */
	path: string;
	content: string;
}

/** Default install location (Claude Code project skills). */
export const DEFAULT_SKILLS_DIR = '.claude/skills';

/** Suffix of the copy written next to a user-modified file. */
export const CONFLICT_SUFFIX = '.new';

/**
 * Install record kept in `<skillsDir>/.svelte-grab-skills.json`: the
 * svelte-grab version that last installed the skills and the SHA-256 of each
 * file as it was written. A file whose hash still matches was not edited by
 * the user, so a newer packaged version may replace it in place.
 */
export const SKILLS_MANIFEST_FILE = '.svelte-grab-skills.json';

export interface SkillsManifest {
	/** svelte-grab version that wrote the manifest. */
	version: string;
	/** Skill path (relative to the skills dir, e.g. `svelte-grab/SKILL.md`) -> SHA-256 hex of the installed content. */
	files: Record<string, string>;
}

export type SkillFileAction =
	/** Did not exist: written. */
	| 'create'
	/** Same content already there: nothing to do. */
	| 'unchanged'
	/** Not edited since the last install (hash matches the manifest), new packaged version: replaced in place. */
	| 'updated'
	/** Different content, `force`: overwritten. */
	| 'overwrite'
	/** Edited by the user (or no install record): new version written to `<path>.new`. */
	| 'conflict'
	/** No longer shipped and not edited since the last install: deleted. */
	| 'removed'
	/** No longer shipped but edited by the user: left in place (and dropped from the manifest). */
	| 'orphaned'
	/** No longer shipped, not edited, but the caller cannot delete (`removeObsolete: false`): left in place, kept in the manifest. */
	| 'obsolete';

export interface SkillFilePlan {
	/** Project-relative target path (`<skillsDir>/<skill path>`). */
	path: string;
	action: SkillFileAction;
	/** File actually written for this entry (path, `<path>.new`), or null when nothing is written. */
	writePath: string | null;
}

export interface SkillsPlan {
	files: SkillFilePlan[];
	/** What to write: the list both init and the sv add-on apply. Ends with the manifest when it changed. */
	writes: { path: string; content: string }[];
	/** Project-relative files to delete (shipped by an older version, never edited). */
	removes: string[];
	/** Skill names covered by the plan, in order. */
	skills: string[];
	/** Project-relative path of the install manifest. */
	manifestPath: string;
	/** Manifest once the plan is applied (also in `writes` when it changed). */
	manifest: SkillsManifest;
}

export interface SkillsPlanOptions {
	/** Project-relative directory the skill folders go into (default `.claude/skills`). */
	skillsDir?: string;
	/** Overwrite files whose content differs instead of writing `<file>.new`. */
	force?: boolean;
	/** svelte-grab version recorded in the manifest (default `unknown`). */
	version?: string;
	/**
	 * Delete unedited files an older version shipped and this one does not
	 * (default true). The sv add-on passes false: sv's file API cannot delete,
	 * so those files are reported as `obsolete` and stay in the manifest.
	 */
	removeObsolete?: boolean;
}

/** Normalize a project-relative directory: `/` separators, no leading `./`, no trailing `/`. */
export function normalizeSkillsDir(dir: string | undefined): string {
	const normalized = (dir ?? DEFAULT_SKILLS_DIR)
		.replace(/\\/g, '/')
		.replace(/^(\.\/)+/, '')
		.replace(/\/+$/, '');
	return normalized === '' || normalized === '.' ? DEFAULT_SKILLS_DIR : normalized;
}

/** Project-relative path of the install manifest for `skillsDir`. */
export function skillsManifestPath(skillsDir: string | undefined): string {
	return `${normalizeSkillsDir(skillsDir)}/${SKILLS_MANIFEST_FILE}`;
}

/**
 * Parse a manifest file. Returns null for a missing or malformed one (the
 * planner then compares content only, as before manifests existed). Entries
 * that are not `string -> 64-char hex` are dropped.
 */
export function parseSkillsManifest(raw: string | null): SkillsManifest | null {
	if (raw === null || raw.trim() === '') return null;
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
	const record = data as { version?: unknown; files?: unknown };
	if (!record.files || typeof record.files !== 'object' || Array.isArray(record.files)) return null;
	const files: Record<string, string> = {};
	for (const [path, hash] of Object.entries(record.files as Record<string, unknown>)) {
		if (typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)) files[path] = hash;
	}
	return { version: typeof record.version === 'string' ? record.version : 'unknown', files };
}

/** Manifest file content: tab-indented JSON with a trailing newline. */
export function serializeSkillsManifest(manifest: SkillsManifest): string {
	return `${JSON.stringify({ version: manifest.version, files: manifest.files }, null, '\t')}\n`;
}

/**
 * Whether a manifest entry may be deleted once it is no longer shipped: a
 * plain relative path (no `.`/`..`/empty segment, no backslash) inside a
 * skill folder svelte-grab owns (`svelte-grab*`, or a skill shipped now).
 * Guards against a hand-edited manifest pointing anywhere else.
 */
function isOwnedSkillPath(path: string, shippedSkills: ReadonlySet<string>): boolean {
	if (path.includes('\\') || path.startsWith('/')) return false;
	const segments = path.split('/');
	if (segments.length < 2 || segments.some((s) => s === '' || s === '.' || s === '..'))
		return false;
	return /^svelte-grab(-[a-z0-9]+)*$/.test(segments[0]) || shippedSkills.has(segments[0]);
}

/**
 * Plan the install of `files` under `skillsDir`. `readExisting(path)` returns
 * the current content of a project-relative file, or null when it does not
 * exist. The install manifest (`<skillsDir>/.svelte-grab-skills.json`) is read
 * through it too, so the planner never touches the file system.
 *
 * Per shipped file:
 * - missing: `create`
 * - same content: `unchanged`
 * - differs and its hash matches the manifest (not edited since the last
 *   install): `updated` in place
 * - differs otherwise (edited, or no manifest entry): `conflict`, the new
 *   version goes to `<file>.new` (skipped when that already holds it); with
 *   `force`, `overwrite` instead
 *
 * Per manifest entry this version no longer ships, if the file still exists:
 * unedited is `removed` (`obsolete` with `removeObsolete: false`), edited is
 * `orphaned` (left alone). Edited files are never deleted, even with `force`.
 *
 * The manifest write (when its content changed) is the last entry of
 * `writes`. Idempotent: a second run with the same files and version plans
 * no writes.
 */
export function planSkillsInstall(
	files: readonly SkillFile[],
	readExisting: (path: string) => string | null,
	options: SkillsPlanOptions = {}
): SkillsPlan {
	const dir = normalizeSkillsDir(options.skillsDir);
	const manifestPath = skillsManifestPath(dir);
	const manifestRaw = readExisting(manifestPath);
	const previous = parseSkillsManifest(manifestRaw);
	const next: SkillsManifest = { version: options.version ?? 'unknown', files: {} };
	const plan: SkillsPlan = {
		files: [],
		writes: [],
		removes: [],
		skills: [],
		manifestPath,
		manifest: next
	};

	for (const file of files) {
		if (!plan.skills.includes(file.skill)) plan.skills.push(file.skill);
		const path = `${dir}/${file.path}`;
		const existing = readExisting(path);
		const shippedHash = sha256Hex(file.content);
		const recorded = previous?.files[file.path];

		if (existing === null) {
			plan.files.push({ path, action: 'create', writePath: path });
			plan.writes.push({ path, content: file.content });
			next.files[file.path] = shippedHash;
		} else if (existing === file.content) {
			plan.files.push({ path, action: 'unchanged', writePath: null });
			next.files[file.path] = shippedHash;
		} else if (recorded !== undefined && sha256Hex(existing) === recorded) {
			plan.files.push({ path, action: 'updated', writePath: path });
			plan.writes.push({ path, content: file.content });
			next.files[file.path] = shippedHash;
		} else if (options.force) {
			plan.files.push({ path, action: 'overwrite', writePath: path });
			plan.writes.push({ path, content: file.content });
			next.files[file.path] = shippedHash;
		} else {
			const newPath = `${path}${CONFLICT_SUFFIX}`;
			const pending = readExisting(newPath) === file.content;
			plan.files.push({ path, action: 'conflict', writePath: pending ? null : newPath });
			if (!pending) plan.writes.push({ path: newPath, content: file.content });
			// Keep the hash of what was last installed there (if known): the file stays "edited".
			if (recorded !== undefined) next.files[file.path] = recorded;
		}
	}

	// Files an older version installed that this one no longer ships.
	const shippedPaths = new Set(files.map((f) => f.path));
	const shippedSkills = new Set(plan.skills);
	for (const [rel, hash] of Object.entries(previous?.files ?? {})) {
		if (shippedPaths.has(rel) || !isOwnedSkillPath(rel, shippedSkills)) continue;
		const path = `${dir}/${rel}`;
		const existing = readExisting(path);
		if (existing === null) continue;
		if (sha256Hex(existing) !== hash) {
			plan.files.push({ path, action: 'orphaned', writePath: null });
		} else if (options.removeObsolete === false) {
			plan.files.push({ path, action: 'obsolete', writePath: null });
			next.files[rel] = hash;
		} else {
			plan.files.push({ path, action: 'removed', writePath: null });
			plan.removes.push(path);
		}
	}

	const manifestContent = serializeSkillsManifest(next);
	if (manifestContent !== manifestRaw)
		plan.writes.push({ path: manifestPath, content: manifestContent });

	return plan;
}

// ============================================================
// SHA-256 (no node:crypto: this module is bundled into the sv add-on, whose
// tsconfig has no Node types)
// ============================================================

const SHA256_K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** SHA-256 of the UTF-8 encoding of `text`, as lowercase hex. */
export function sha256Hex(text: string): string {
	const bytes = new TextEncoder().encode(text);
	const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
	padded.set(bytes);
	padded[bytes.length] = 0x80;
	const view = new DataView(padded.buffer);
	const bits = bytes.length * 8;
	view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
	view.setUint32(padded.length - 4, bits >>> 0);

	const h = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
	]);
	const w = new Uint32Array(64);
	for (let offset = 0; offset < padded.length; offset += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
			const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
			w[i] = w[i - 16] + s0 + w[i - 7] + s1;
		}
		let [a, b, c, d, e, f, g, k] = h;
		for (let i = 0; i < 64; i++) {
			const t1 =
				(k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) |
				0;
			const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
			k = g;
			g = f;
			f = e;
			e = (d + t1) | 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) | 0;
		}
		h[0] += a;
		h[1] += b;
		h[2] += c;
		h[3] += d;
		h[4] += e;
		h[5] += f;
		h[6] += g;
		h[7] += k;
	}
	return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}

// ============================================================
// AGENTS.md pointer
// ============================================================

/** Marker that makes the AGENTS.md pointer idempotent. */
export const AGENTS_MD_MARKER = '<!-- svelte-grab-skills -->';

/** One-line purpose of each shipped skill, for the AGENTS.md pointer. */
const SKILL_SUMMARIES: Record<string, string> = {
	'svelte-grab': 'inspect, edit and verify the live UI with the svelte-grab `ui_*` MCP tools',
	'svelte-grab-audit':
		'per-screen security and performance audit (requests, credential leaks, hot components, memory)'
};

/**
 * Append a short "svelte-grab skills" section to an existing AGENTS.md, once
 * (the marker comment makes it idempotent). Returns `changed: false` when the
 * marker is already there.
 */
export function appendAgentsMdPointer(
	existing: string,
	skillsDir: string | undefined,
	skills: readonly string[]
): { content: string; changed: boolean } {
	if (existing.includes(AGENTS_MD_MARKER)) return { content: existing, changed: false };
	const dir = normalizeSkillsDir(skillsDir);
	const lines = [
		AGENTS_MD_MARKER,
		'## svelte-grab skills',
		'',
		`Agent skills installed by svelte-grab live in \`${dir}/\`. Read the SKILL.md before using the svelte-grab MCP tools:`,
		'',
		...skills.map(
			(name) =>
				`- \`${dir}/${name}/SKILL.md\`${SKILL_SUMMARIES[name] ? `: ${SKILL_SUMMARIES[name]}` : ''}`
		),
		''
	];
	const separator =
		existing === '' || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
	return { content: `${existing}${separator}${lines.join('\n')}`, changed: true };
}

// ============================================================
// SKILL.md frontmatter
// ============================================================

/**
 * Minimal YAML frontmatter reader for SKILL.md (`---` block with `key: value`
 * lines; values may be quoted). Returns null when there is no frontmatter.
 */
export function parseSkillFrontmatter(
	content: string
): { data: Record<string, string>; body: string } | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return null;
	const data: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
		if (!kv) continue;
		let value = kv[2].trim();
		if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
		data[kv[1]] = value;
	}
	return { data, body: content.slice(match[0].length) };
}
