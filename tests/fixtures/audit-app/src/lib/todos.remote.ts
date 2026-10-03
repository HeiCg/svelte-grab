import { command, query, getRequestEvent } from '$app/server';
import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';

export const addTodo = command('unchecked', async (text: string) => {
	await db.query('INSERT INTO todos (text) VALUES ($1)', [text]);
});

export const deleteTodo = command('unchecked', async (id: string) => {
	const { locals } = getRequestEvent();
	if (!locals.user) error(401);
	await db.query('DELETE FROM todos WHERE id = $1', [id]);
});

export const getTodos = query(async () => db.query('SELECT id, text FROM todos', []));
