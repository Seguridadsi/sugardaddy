import { error } from '@sveltejs/kit';
import { puertosPublicados, tipoEvento, validarParametros } from '@sugardaddy/contrato';
import type { CargaContenedor } from '@sugardaddy/contrato';
import { tipoDeServicio } from '@sugardaddy/estilo/pictogramas';
import { catalogoConSuscripcion, desplegable, fichaDe, viaContenedor } from '$lib/server/catalogo';

/*
 * La ficha de una trampa del catálogo, esté o no en la suscripción del
 * cliente. Lo que se ejecuta (imagen, puertos, aislamiento) es lo de su vía
 * contenedor@1. Se despliega desde aquí si tiene alguna vía que esta consola
 * sabe poner: en un sensor o con pasos a mano (paso 11).
 */
export const load = async ({ params }) => {
	const m = (await catalogoConSuscripcion()).find((x) => x.id === params.modulo);
	if (!m) error(404, 'Esa trampa no está en el catálogo');
	const c = viaContenedor(m)?.carga as CargaContenedor | undefined;
	const p = validarParametros(m.parametros, {});
	return {
		modulo: {
			id: m.id,
			nombre: m.nombre,
			descripcion: m.descripcion,
			tipo: tipoEvento(m),
			version: m.versionModulo,
			incluida: m.incluida,
			desplegable: desplegable(m),
			ficha: fichaDe(m) ?? null,
			procedencia: m.procedencia ?? null,
			pictograma: tipoDeServicio(m.id),
			aislamiento: c?.aislamiento ?? null,
			imagen: c?.contenedor.imagen ?? null,
			puertos: c
				? puertosPublicados(c, p.ok ? p.valor : {}).map((x) => `${x.puerto}/${x.protocolo}`)
				: [],
			ajustes: Object.values(m.parametros.properties)
				.map((c) => (c as { title?: string }).title)
				.filter(Boolean) as string[]
		}
	};
};
