import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	rmSync,
	readdirSync,
	statSync
} from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { init, parseInitArgs } from '../src/cli/init.js';
import {
	codexDeclaredServers,
	codexServerTable,
	mergeCodexConfigToml,
	CODEX_ADDED_COMMENT
} from '../src/cli/transforms.js';
import {
	AGENTS_MD_MARKER,
	CLAUDE_MD_MARKER,
	agentsMdSection,
	appendClaudeMdPointer,
	claudeMdImportsAgentsMd,
	parseAgentsFlags,
	resolveAgents,
	skillsDirsFor,
	upsertAgentsMd
} from '../src/cli/agents.js';

const DEFAULT_TOML = `${CODEX_ADDED_COMMENT}
[mcp_servers.svelte-grab]
command = "npx"
args = ["svelte-grab-mcp", "--stdio"]

${CODEX_ADDED_COMMENT}
[mcp_servers.svelte]
command = "npx"
args = ["-y", "@sveltejs/mcp"]
startup_timeout_sec = 30
`;

// ============================================================
// Pure helpers
// ============================================================

describe('mergeCodexConfigToml', () => {
	it('writes svelte-grab + svelte into a missing or empty file', () => {
		for (const existing of [null, '', '\n']) {
			const merged = mergeCodexConfigToml(existing, { svelteMcp: true, playwrightMcp: false });
			expect(merged).toEqual({
				content: DEFAULT_TOML,
				changed: true,
				added: ['svelte-grab', 'svelte'],
				kept: []
			});
		}
	});

	it('appends only missing tables, never edits existing ones, and is idempotent', () => {
		const existing =
			'model = "gpt-5"\n\n[mcp_servers.svelte]\ncommand = "node"\nargs = ["local.js"]\n\n[mcp_servers.svelte.env]\nX = "1"';
		const merged = mergeCodexConfigToml(existing, { svelteMcp: true, playwrightMcp: true });
		expect(merged.added).toEqual(['svelte-grab', 'playwright']);
		expect(merged.kept).toEqual(['svelte']);
		expect(merged.content.startsWith(`${existing}\n\n${CODEX_ADDED_COMMENT}\n`)).toBe(true);
		expect(merged.content).toContain(codexServerTable('playwright'));
		expect(merged.content).toContain('args = ["-y", "@playwright/mcp@latest"]');
		const again = mergeCodexConfigToml(merged.content, { svelteMcp: true, playwrightMcp: true });
		expect(again).toEqual({
			content: merged.content,
			changed: false,
			added: [],
			kept: ['svelte-grab', 'svelte', 'playwright']
		});
	});

	it('svelteMcp: false adds svelte-grab only', () => {
		const merged = mergeCodexConfigToml(null, { svelteMcp: false, playwrightMcp: false });
		expect(merged.added).toEqual(['svelte-grab']);
		expect(merged.content).not.toContain('@sveltejs/mcp');
	});
});

describe('codexDeclaredServers', () => {
	it('finds tables, quoted names, sub-tables, dotted keys and inline tables', () => {
		const toml = [
			'mcp_servers.a.command = "x"',
			'[mcp_servers."svelte-grab"]',
			'command = "node"',
			"[ mcp_servers . 'b' . env ]",
			'K = "v"',
			'[mcp_servers]',
			'c = { command = "y" }',
			'd.command = "z"',
			'[other]',
			'mcp_servers = "not a server"',
			'[[profiles]]',
			'name = "p"'
		].join('\n');
		expect([...codexDeclaredServers(toml)].sort()).toEqual(['a', 'b', 'c', 'd', 'svelte-grab']);
	});

	it('ignores headers and keys inside multi-line strings and comments', () => {
		const toml = [
			'instructions = """',
			'[mcp_servers.fake]',
			'command = "no"',
			'"""',
			'# [mcp_servers.commented]',
			'[profiles.x] # [mcp_servers.trailing]'
		].join('\n');
		expect([...codexDeclaredServers(toml)]).toEqual([]);
	});
});

describe('agents', () => {
	it('parses --agents and --no-codex', () => {
		expect(parseAgentsFlags([]).agents).toEqual(['claude', 'codex']);
		expect(parseAgentsFlags(['--agents', 'Codex']).agents).toEqual(['codex']);
		expect(parseAgentsFlags(['--agents=claude,codex,claude']).agents).toEqual([
			'claude',
			'codex',
			'claude'
		]);
		expect(parseAgentsFlags(['--no-codex']).agents).toEqual(['claude']);
		expect(resolveAgents(['codex', 'claude', 'codex', 'cursor'])).toEqual({
			agents: ['claude', 'codex'],
			unknown: ['cursor']
		});
	});

	it('skills dirs: one per agent, or the explicit one', () => {
		expect(skillsDirsFor(['claude', 'codex'])).toEqual(['.claude/skills', '.agents/skills']);
		expect(skillsDirsFor(['codex'])).toEqual(['.agents/skills']);
		expect(skillsDirsFor(['claude', 'codex'], './x/skills/')).toEqual(['x/skills']);
	});

	it('AGENTS.md: created only when asked, appended once, loop in five lines', () => {
		const opts = { skillsDirs: ['.agents/skills', '.claude/skills'], skills: ['svelte-grab'] };
		expect(upsertAgentsMd(null, { ...opts, create: false })).toEqual({
			content: '',
			action: 'absent'
		});
		const created = upsertAgentsMd(null, { ...opts, create: true });
		expect(created.action).toBe('created');
		expect(created.content.startsWith(`# AGENTS.md\n\n${AGENTS_MD_MARKER}\n## svelte-grab\n`)).toBe(
			true
		);
		expect(created.content).toContain('`.agents/skills/svelte-grab/SKILL.md`');
		expect(created.content).toMatch(/\n1\. .*\n2\. .*\n3\. .*\n4\. .*\n5\. .*ui_tabs/);

		const appended = upsertAgentsMd('# Rules', { ...opts, create: false });
		expect(appended.action).toBe('appended');
		expect(appended.content.startsWith(`# Rules\n\n${AGENTS_MD_MARKER}`)).toBe(true);
		expect(upsertAgentsMd(appended.content, { ...opts, create: true })).toEqual({
			content: appended.content,
			action: 'already-present'
		});
	});

	it('AGENTS.md without skills points at the MCP prompt', () => {
		expect(agentsMdSection([], [])).toContain('`svelte-grab-loop` prompt');
	});

	it('CLAUDE.md pointer: appended once, skipped when CLAUDE.md imports AGENTS.md or is missing', () => {
		expect(appendClaudeMdPointer(null, '.claude/skills').action).toBe('absent');
		const first = appendClaudeMdPointer('# Me\n', '.claude/skills');
		expect(first.action).toBe('appended');
		expect(first.content).toBe(
			`# Me\n\n${CLAUDE_MD_MARKER} svelte-grab: for UI work in the running app use the svelte-grab MCP \`ui_*\` tools; ` +
				'see the svelte-grab section of `AGENTS.md` and `.claude/skills/svelte-grab/SKILL.md`.\n'
		);
		expect(appendClaudeMdPointer(first.content, '.claude/skills').action).toBe('already-present');
		expect(appendClaudeMdPointer('See @AGENTS.md\n', null).action).toBe('imports-agents-md');
		expect(claudeMdImportsAgentsMd('@./AGENTS.md')).toBe(true);
		expect(claudeMdImportsAgentsMd('use `@AGENTS.md` syntax')).toBe(false);
		expect(claudeMdImportsAgentsMd('```\n@AGENTS.md\n```')).toBe(false);
		expect(claudeMdImportsAgentsMd('mail me@AGENTS.md')).toBe(false);
	});
});

// ============================================================
// init (temp project)
// ============================================================

let dir: string;

function write(rel: string, content: string) {
	const path = join(dir, rel);
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, content, 'utf-8');
}

const read = (rel: string) => readFileSync(join(dir, rel), 'utf-8');
const exists = (rel: string) => existsSync(join(dir, rel));

function tree(): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			if (statSync(p).isDirectory()) walk(p);
			else out[relative(dir, p)] = readFileSync(p, 'utf-8');
		}
	};
	walk(dir);
	return out;
}

function kitProject() {
	write(
		'package.json',
		JSON.stringify({ devDependencies: { '@sveltejs/kit': '^2.20.0', svelte: '^5.40.0' } })
	);
	write(
		'vite.config.ts',
		"import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit()] };\n"
	);
}

const logged = () =>
	vi
		.mocked(console.log)
		.mock.calls.map((c) => c.join(' '))
		.join('\n');

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'sg-init-agents-'));
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

describe('init: Claude Code + Codex (default)', () => {
	it('fresh project: .mcp.json, .codex/config.toml, both skills dirs, AGENTS.md', () => {
		kitProject();
		const result = init(dir, parseInitArgs([]));
		expect(result.ok).toBe(true);
		expect(result.agents).toEqual(['claude', 'codex']);
		expect(result.mcpServersAdded).toEqual(['svelte-grab', 'svelte']);
		expect(result.codexServersAdded).toEqual(['svelte-grab', 'svelte']);
		expect(result.enableMcp).toBe(true);
		expect(result.agentsMd).toBe('created');
		expect(result.claudeMd).toBe('absent');

		expect(read('.codex/config.toml')).toBe(DEFAULT_TOML);
		expect(JSON.parse(read('.mcp.json')).mcpServers['svelte-grab'].command).toBe('npx');
		for (const skillsDir of ['.claude/skills', '.agents/skills']) {
			expect(exists(`${skillsDir}/svelte-grab/SKILL.md`)).toBe(true);
			expect(exists(`${skillsDir}/svelte-grab-audit/CHECKLIST.md`)).toBe(true);
			expect(exists(`${skillsDir}/.svelte-grab-skills.json`)).toBe(true);
		}
		const agents = read('AGENTS.md');
		expect(agents).toContain(AGENTS_MD_MARKER);
		expect(agents).toContain('`.agents/skills/svelte-grab/SKILL.md`');
		expect(agents).toContain('`.claude/skills/`');
		expect(exists('CLAUDE.md')).toBe(false);
		expect(read('src/routes/+layout.svelte')).toContain('<SvelteDevKit enableMcp />');

		const out = logged();
		expect(out).toContain('Writing .codex/config.toml (adds svelte-grab, svelte)');
		expect(out).toContain('trusted projects');
		expect(out).toContain('codex mcp add svelte-grab -- npx svelte-grab-mcp --stdio');
	});

	it('is idempotent: a second run writes nothing', () => {
		kitProject();
		init(dir, parseInitArgs([]));
		const before = tree();
		const second = init(dir, parseInitArgs([]));
		expect(second.written).toEqual([]);
		expect(second.codexServersAdded).toEqual([]);
		expect(second.agentsMd).toBe('already-present');
		expect(tree()).toEqual(before);
	});

	it('preserves an existing config.toml with other servers and settings', () => {
		kitProject();
		const existing =
			'model = "gpt-5-codex"\n\n[mcp_servers.github]\ncommand = "gh-mcp"\n\n[mcp_servers."svelte"]\nurl = "https://mcp.svelte.dev/mcp"\n';
		write('.codex/config.toml', existing);
		const result = init(dir);
		expect(result.codexServersAdded).toEqual(['svelte-grab']);
		const toml = read('.codex/config.toml');
		expect(toml.startsWith(existing)).toBe(true);
		expect(toml.slice(existing.length)).toBe(`\n${codexServerTable('svelte-grab')}\n`);
		expect(logged()).toContain('.codex/config.toml already declares: svelte (left unchanged)');
	});

	it('appends to an existing AGENTS.md once', () => {
		kitProject();
		write('AGENTS.md', '# Rules\n\nBe nice.\n');
		expect(init(dir).agentsMd).toBe('appended');
		const agents = read('AGENTS.md');
		expect(agents.startsWith('# Rules\n\nBe nice.\n\n' + AGENTS_MD_MARKER)).toBe(true);
		expect(init(dir).agentsMd).toBe('already-present');
		expect(read('AGENTS.md')).toBe(agents);
	});

	it('adds the CLAUDE.md pointer once; leaves a CLAUDE.md that imports AGENTS.md alone', () => {
		kitProject();
		write('CLAUDE.md', '# Claude rules\n');
		expect(init(dir).claudeMd).toBe('appended');
		const claude = read('CLAUDE.md');
		expect(claude.split(CLAUDE_MD_MARKER)).toHaveLength(2);
		expect(init(dir).claudeMd).toBe('already-present');
		expect(read('CLAUDE.md')).toBe(claude);

		write('CLAUDE.md', '@AGENTS.md\n\n# More\n');
		expect(init(dir).claudeMd).toBe('imports-agents-md');
		expect(read('CLAUDE.md')).toBe('@AGENTS.md\n\n# More\n');
	});

	it('--dry-run writes nothing and shows the config.toml diff', () => {
		kitProject();
		write('CLAUDE.md', '# Claude rules\n');
		const before = tree();
		const result = init(dir, parseInitArgs(['--dry-run']));
		expect(tree()).toEqual(before);
		expect(result.written).toEqual([]);
		expect(result.codexServersAdded).toEqual(['svelte-grab', 'svelte']);
		expect(result.agentsMd).toBe('created');
		expect(result.claudeMd).toBe('appended');
		const out = logged();
		expect(out).toContain('Would write .codex/config.toml');
		expect(out).toContain('+ [mcp_servers.svelte-grab]');
		expect(out).toContain('Would create AGENTS.md');
		expect(out).toContain('Would add a one-line svelte-grab pointer to CLAUDE.md');
	});

	it('--no-agents-md leaves AGENTS.md and CLAUDE.md alone', () => {
		kitProject();
		write('CLAUDE.md', '# Claude rules\n');
		const result = init(dir, parseInitArgs(['--no-agents-md']));
		expect(result.agentsMd).toBe('skipped');
		expect(result.claudeMd).toBe('skipped');
		expect(exists('AGENTS.md')).toBe(false);
		expect(read('CLAUDE.md')).toBe('# Claude rules\n');
	});

	it('--no-skills still writes the AGENTS.md section, pointing at the MCP prompt', () => {
		kitProject();
		init(dir, parseInitArgs(['--no-skills']));
		expect(exists('.claude')).toBe(false);
		expect(exists('.agents')).toBe(false);
		expect(read('AGENTS.md')).toContain('`svelte-grab-loop` prompt');
	});
});

describe('init: agent selection', () => {
	const codexFiles = () =>
		Object.keys(tree()).filter(
			(p) => p.startsWith('.codex/') || p.startsWith('.agents/') || p === 'AGENTS.md'
		);

	it('--agents claude: no Codex file', () => {
		kitProject();
		const result = init(dir, parseInitArgs(['--agents', 'claude']));
		expect(result.agents).toEqual(['claude']);
		expect(result.codexServersAdded).toEqual([]);
		expect(codexFiles()).toEqual([]);
		expect(exists('.mcp.json')).toBe(true);
		expect(exists('.claude/skills/svelte-grab/SKILL.md')).toBe(true);
		expect(logged()).not.toContain('codex mcp add');
	});

	it('--no-codex: same as --agents claude', () => {
		kitProject();
		const result = init(dir, parseInitArgs(['--no-codex']));
		expect(result.agents).toEqual(['claude']);
		expect(codexFiles()).toEqual([]);
	});

	it('--agents codex: Codex files only, MCP enabled through config.toml', () => {
		kitProject();
		write('CLAUDE.md', '# Claude rules\n');
		const result = init(dir, parseInitArgs(['--agents=codex']));
		expect(result.agents).toEqual(['codex']);
		expect(exists('.mcp.json')).toBe(false);
		expect(exists('.claude')).toBe(false);
		expect(read('.codex/config.toml')).toBe(DEFAULT_TOML);
		expect(exists('.agents/skills/svelte-grab/SKILL.md')).toBe(true);
		expect(result.enableMcp).toBe(true);
		expect(read('src/routes/+layout.svelte')).toContain('<SvelteDevKit enableMcp />');
		// CLAUDE.md is Claude Code's: untouched without it.
		expect(result.claudeMd).toBe('skipped');
		expect(read('CLAUDE.md')).toBe('# Claude rules\n');
		expect(read('AGENTS.md')).not.toContain('.claude/skills');
	});

	it('fails on unknown agents or an empty selection, writing nothing', () => {
		kitProject();
		const before = tree();
		expect(init(dir, parseInitArgs(['--agents', 'cursor'])).ok).toBe(false);
		expect(init(dir, parseInitArgs(['--agents', 'codex', '--no-codex'])).ok).toBe(false);
		expect(tree()).toEqual(before);
		expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
			'Unknown agent(s): cursor'
		);
	});

	it('prints a Cursor hint when the project has .cursor/', () => {
		kitProject();
		mkdirSync(join(dir, '.cursor'));
		init(dir);
		expect(logged()).toContain('.cursor/mcp.json');
	});
});
