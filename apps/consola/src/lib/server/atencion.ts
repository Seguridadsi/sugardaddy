/*
 * Junta lo que necesita atención en el nodo (lib/atencion.ts) para el inicio:
 * sensores, honeypots y, donde las hay, salidas de avisos.
 */
import { armarAtencion, type Atencion } from '$lib/atencion';
import { salidasConProblemas } from './alcance-ficha';
import { trampasConEventos } from './consultas';
import { sensores } from './gestion';

export async function necesitaAtencion(): Promise<Atencion[]> {
	const [lista, trampas, salidas] = await Promise.all([
		sensores(),
		trampasConEventos(),
		salidasConProblemas()
	]);
	return armarAtencion({
		sensores: lista,
		trampas: trampas.map((t) => ({ estado: t.estado.estado })),
		salidas
	});
}
