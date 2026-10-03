import { db } from '$lib/server/db';

export const load = async ({ params }) => {
	const user = await db.user.findUnique({ where: { id: params.id }, select: { id: true, name: true } });
	return { user };
};
