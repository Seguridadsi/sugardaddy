import { error } from '@sveltejs/kit';
import { puertosPublicados, tipoEvento, validarParametros } from '@sugardaddy/contrato';
import type { CargaContenedor } from '@sugardaddy/contrato';
import { tipoDeServicio } from '@sugardaddy/estilo/pictogramas';
import {
	catalogoConSuscripcion,
	desplegable,
	esDePago,
	fichaDe,
	porQueNo,
	viaContenedor
} from '$lib/server/catalogo';
import { contarTrampasDe, usoDeModulos } from '$lib/server/consultas';
import { madurezDelNodo, vistaDeMadurez } from '$lib/server/madurez';

/*
 * La ficha de una trampa del catálogo, esté o no disponible para el cliente
 * (en su suscripción y, si es de pago, en su licencia). Lo que se ejecuta (imagen, puertos, aislamiento) es lo de su vía
 * contenedor@1. Se despliega desde aquí si tiene alguna vía que esta consola
 * sabe poner: en un sensor o con pasos a mano (paso 11).
 */
export const load = async ({ params }) => {
	const m = (await catalogoConSuscripcion()).find((x) => x.id === params.modulo);
	if (!m) error(404, 'That honeypot is not in the catalog');
	const c = viaContenedor(m)?.carga as CargaContenedor | undefined;
	const p = validarParametros(m.parametros, {});
	const [instaladas, uso, madurez] = await Promise.all([
		contarTrampasDe(m.id),
		usoDeModulos(),
		madurezDelNodo()
	]);
	return {
		modulo: {
			id: m.id,
			nombre: m.nombre,
			descripcion: m.descripcion,
			tipo: tipoEvento(m),
			version: m.versionModulo,
			disponible: m.disponible,
			instaladas,
			/* Activas y recibiendo su señal (D11). */
			enMarcha: uso.get(m.id)?.enMarcha ?? 0,
			/* Lo que toca al cliente: en su plan y, si es de pago, en su licencia. */
			incluida: m.incluida,
			dePago: esDePago(m.id),
			licenciaCubierta: m.licencia === 'cubierta',
			/* Hecha, probada, publicada y soportada, de la versión firmada del nodo (D11). */
			madurez: vistaDeMadurez(madurez, m),
			porQueNo: porQueNo(m),
			activarConRegistro: !m.disponible && m.conRegistro,
			registroCaducado: m.licencia === 'registro.caducado',
			desplegable: desplegable(m),
			ficha: fichaDe(m) ?? null,
			procedencia: m.procedencia ?? null,
			dePartner: m.dePartner,
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
