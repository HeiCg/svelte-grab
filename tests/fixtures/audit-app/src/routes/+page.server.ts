import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';

export const load = async ({ params }) => {
	const user = await db.user.findUnique({ where: { id: params.id } });
	return { user };
};

export const actions = {
	update: async ({ request }) => {
		const form = await request.formData();
		await db.query('UPDATE users SET name = $1', [form.get('name')]);
	},
	remove: async ({ locals }) => {
		if (!locals.user) return fail(401);
		await db.query('DELETE FROM users WHERE id = $1', [locals.user.id]);
	}
};
