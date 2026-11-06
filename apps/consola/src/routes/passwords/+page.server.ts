import { contrasenas, palabras } from '$lib/server/credenciales';
import { nombresTrampas } from '$lib/server/consultas';

export const load = async ({ url }) => {
	const buscar = url.searchParams.get('buscar')?.trim().slice(0, 100) ?? '';
	return {
		ahora: Date.now(),
		buscar,
		filas: (await contrasenas(buscar)).map((f) => ({
			...f,
			primera: new Date(f.primera).toISOString(),
			ultima: new Date(f.ultima).toISOString()
		})),
		palabras: await palabras(),
		nombres: await nombresTrampas()
	};
};
