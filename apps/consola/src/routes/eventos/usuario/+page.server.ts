import { error } from '@sveltejs/kit';
import { etiquetasModulos, nombresTrampas, perfilDeUsuario } from '$lib/server/consultas';

/*
 * El perfil va por query (?u=…), no por segmento de ruta: un usuario lo escribe
 * el atacante y puede traer barras u otros caracteres que no caben en un
 * segmento. SvelteKit ya entrega el valor decodificado.
 */
export const load = async ({ url }) => {
	/* Sin trim: el usuario se guarda verbatim (puede llevar espacios); trim solo
	 * para descartar el vacío. El eq exacto en perfilDeUsuario usa el valor crudo. */
	const usuario = url.searchParams.get('u') ?? '';
	if (!usuario.trim()) error(404, 'Falta el usuario.');
	const perfil = await perfilDeUsuario(usuario);
	if (!perfil) error(404, 'No hay eventos de ese usuario.');
	return {
		ahora: Date.now(),
		usuario,
		...perfil,
		nombres: await nombresTrampas(),
		modulos: etiquetasModulos()
	};
};
