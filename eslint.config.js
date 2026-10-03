import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';
import globals from 'globals';

/**
 * Flat-config ESLint 9 setup for svelte-grab.
 *
 * - typescript-eslint for the TS sources (browser lib + Node relay/cli/mcp)
 * - eslint-plugin-svelte + svelte-eslint-parser for .svelte components
 * - no-floating-promises enabled as a warning (relevant to async relay code)
 *   without blocking the build.
 */
export default tseslint.config(
	{
		// Ignore build output, deps, generated dirs, and any cloned scratch repos.
		ignores: [
			'dist/',
			'node_modules/',
			'.svelte-kit/',
			'coverage/',
			'**/*.cjs',
			'package-lock.json',
			// Scratch repos cloned during dev/testing
			'tmp/',
			'scratch/',
			'**/cloned-*/',
			// Agent worktrees; demo app has its own Svelte/async compiler config
			'.claude/',
			'examples/',
			// Deliberately insecure sample projects scanned by `svelte-grab audit` tests
			'tests/fixtures/',
			// Standalone packages (sv add-on): build output and their own demo/deps
			'packages/*/dist/',
			'packages/*/node_modules/',
			'packages/*/demo/'
		]
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	// Type-aware linting for the project's TS sources.
	//
	// The repo splits its sources across two tsconfigs (tsconfig.json covers
	// src/lib, tsconfig.server.json covers relay/cli/mcp/utils). We point the
	// type-aware parser at BOTH so async relay code gets the type info that
	// no-floating-promises needs — without editing the tsconfig files.
	{
		files: ['src/**/*.ts'],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				project: ['./tsconfig.json', './tsconfig.server.json'],
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.svelte']
			},
			globals: {
				...globals.browser,
				...globals.node
			}
		},
		rules: {
			'@typescript-eslint/no-floating-promises': 'warn',
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			],
			'@typescript-eslint/no-explicit-any': 'warn'
		}
	},
	// Test files: linted without type information (they are in no tsconfig).
	{
		files: ['tests/**/*.ts'],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				tsconfigRootDir: import.meta.dirname
			},
			globals: {
				...globals.browser,
				...globals.node
			}
		},
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			],
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-non-null-assertion': 'off'
		}
	},
	// Svelte component files.
	...svelte.configs['flat/recommended'],
	{
		files: ['**/*.svelte'],
		languageOptions: {
			parser: svelteParser,
			parserOptions: {
				parser: tseslint.parser,
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.svelte']
			},
			globals: {
				...globals.browser
			}
		},
		rules: {
			// In components, destructured-but-unused `$props()` members are a normal
			// public-API pattern (e.g. `secondaryModifier` on tools that don't use a
			// secondary modifier), and an occasional `any` is unavoidable when reaching
			// into undocumented Svelte 5 internals. Treat both as warnings here, while
			// keeping them strict in plain .ts where they signal real dead code.
			'@typescript-eslint/no-unused-vars': 'warn',
			'@typescript-eslint/no-explicit-any': 'warn'
		}
	}
);
