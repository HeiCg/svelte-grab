// Server-only ($lib/server): a hardcoded key here is not a client exposure.
export const awsKeyId = '__FAKE_AWS__';

export const db = {
	user: {
		findUnique: async (_args: unknown) => ({ id: 1, email: 'a@b.c', passwordHash: 'x' })
	},
	query: async (_sql: string, _params: unknown[]) => ({ id: 1 })
};
