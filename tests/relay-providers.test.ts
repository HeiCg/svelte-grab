import { describe, it, expect } from 'vitest';
import { ClaudeCodeProvider, type ClaudeAgentSDK, type ClaudeSdkMessage } from '../src/relay/providers/claude-code';
import {
	CodexProvider,
	type CodexClient,
	type CodexStreamEvent,
	type CodexThread
} from '../src/relay/providers/codex';

function recorder() {
	const status: string[] = [];
	const done: string[] = [];
	const errors: string[] = [];
	return {
		status,
		done,
		errors,
		callbacks: {
			onStatus: (m: string) => status.push(m),
			onDone: (r: string) => done.push(r),
			onError: (e: string) => errors.push(e)
		}
	};
}

const ctx = (prompt: string) => ({ content: ['<Button> src/Button.svelte:3'], prompt, selectedCount: 1 });

describe('ClaudeCodeProvider (async generator query API)', () => {
	function fakeSdk(runs: ClaudeSdkMessage[][]) {
		const calls: Parameters<ClaudeAgentSDK['query']>[0][] = [];
		const sdk: ClaudeAgentSDK = {
			query(params) {
				calls.push(params);
				const messages = runs[calls.length - 1] ?? [];
				return (async function* () {
					for (const m of messages) yield m;
				})();
			}
		};
		return { sdk, calls };
	}

	it('streams assistant text, finishes with the result and resumes the session', async () => {
		const { sdk, calls } = fakeSdk([
			[
				{ type: 'system', subtype: 'init', session_id: 'sess-1' },
				{ type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'text', text: 'Editing Button' }] } },
				{ type: 'result', subtype: 'success', session_id: 'sess-1', result: 'Made the button bigger' }
			],
			[{ type: 'result', subtype: 'success', session_id: 'sess-1', result: 'ok' }]
		]);
		const provider = new ClaudeCodeProvider(sdk);
		const r = recorder();

		await provider.handleRequest('s', ctx('make it bigger'), r.callbacks);

		expect(r.errors).toEqual([]);
		expect(r.done).toEqual(['Made the button bigger']);
		expect(r.status).toContain('Editing Button');
		expect(calls[0].prompt).toContain('make it bigger');
		expect(calls[0].prompt).toContain('src/Button.svelte:3');
		expect(calls[0].options?.abortController).toBeInstanceOf(AbortController);
		expect(calls[0].options?.permissionMode).toBe('acceptEdits');
		expect(calls[0].options?.resume).toBeUndefined();

		await provider.handleRequest('s', ctx('again'), r.callbacks);
		expect(calls[1].options?.resume).toBe('sess-1');
	});

	it('reports a non-success result as an error', async () => {
		const { sdk } = fakeSdk([[{ type: 'result', subtype: 'error_max_turns', errors: ['Reached max turns'] }]]);
		const r = recorder();
		await new ClaudeCodeProvider(sdk).handleRequest('s', ctx('x'), r.callbacks);
		expect(r.done).toEqual([]);
		expect(r.errors).toEqual(['Reached max turns']);
	});
});

describe('CodexProvider (Codex class + awaited runStreamed)', () => {
	function fakeClient(runs: CodexStreamEvent[][]) {
		const started: unknown[] = [];
		const resumed: string[] = [];
		let run = 0;
		const makeThread = (): CodexThread => ({
			id: null,
			async runStreamed() {
				const events = runs[run++] ?? [];
				return {
					events: (async function* () {
						for (const e of events) yield e;
					})()
				};
			}
		});
		const client: CodexClient = {
			startThread(options) {
				started.push(options);
				return makeThread();
			},
			resumeThread(id) {
				resumed.push(id);
				return makeThread();
			}
		};
		return { client, started, resumed };
	}

	it('takes the thread id from thread.started, returns the final agent message and resumes', async () => {
		const { client, started, resumed } = fakeClient([
			[
				{ type: 'thread.started', thread_id: 'th-1' },
				{ type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } },
				{ type: 'item.completed', item: { type: 'agent_message', text: 'Done: padding increased' } },
				{ type: 'turn.completed' }
			],
			[{ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }]
		]);
		const provider = new CodexProvider(client);
		const r = recorder();

		await provider.handleRequest('s', ctx('bigger'), r.callbacks);
		expect(r.errors).toEqual([]);
		expect(r.done).toEqual(['Done: padding increased']);
		expect(started[0]).toMatchObject({ sandboxMode: 'workspace-write' });

		await provider.handleRequest('s', ctx('again'), r.callbacks);
		expect(resumed).toEqual(['th-1']);
	});

	it('reports turn.failed as an error', async () => {
		const { client } = fakeClient([[{ type: 'turn.failed', error: { message: 'sandbox denied' } }]]);
		const r = recorder();
		await new CodexProvider(client).handleRequest('s', ctx('x'), r.callbacks);
		expect(r.done).toEqual([]);
		expect(r.errors).toEqual(['sandbox denied']);
	});
});
