import { error, json } from '@sveltejs/kit';
import { visita } from '$lib/server/consultas';

/* La visita a la que pertenece un evento, para desplegarla en la lista. */
export const GET = async ({ params }) => {
	if (!/^[0-9a-f-]{36}$/.test(params.id)) error(404);
	const v = await visita(params.id);
	if (!v) error(404, 'Ese evento no existe.');
	return json(v);
};
