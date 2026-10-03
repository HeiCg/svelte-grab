import { db } from '$lib/server/db';

export async function load({ locals }) {
	const row = await db.query('SELECT * FROM users WHERE id = $1', [locals.userId]);
	return { ...row };
}
