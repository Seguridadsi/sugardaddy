import { error } from '@sveltejs/kit';
import {
	ESTADOS_TRIAJE,
	SEVERIDADES,
	auditar,
	eventosPlanos,
	nombresTrampas,
	type FiltroEscaner,
	type FiltroTriaje
} from '$lib/server/consultas';
import { geo, type Geo } from '$lib/server/geo';
import { ipsTor } from '$lib/server/tor';
import { construirCsvEventos } from '$lib/server/csv-eventos';

/*
 * Descarga de los eventos en CSV, con los mismos filtros que la página de
 * Eventos. Pensado para la edición community («saca tus datos tú mismo»), pero
 * útil en cualquier edición. Lo puede hacer cualquier usuario con sesión (ver
 * los eventos no pide un permiso aparte); queda en la auditoría con quién y
 * cuántos, nunca el contenido. El CSV (y su escapado anti-fórmula) se arma en
 * csv-eventos.ts; aquí solo se resuelve la geo local por IP.
 */

export const GET = async ({ url, locals }) => {
	const u = locals.usuario;
	if (!u) error(401, 'Sign in first.');

	const pedida = url.searchParams.get('desde');
	const desde = SEVERIDADES.find((x) => x === pedida) ?? 'baja';
	const trampa = url.searchParams.get('trampa') || undefined;
	const origen = url.searchParams.get('origen')?.trim() || undefined;
	/* Usuario EXACTO (sin trim: se guarda verbatim), como en la página de Eventos. */
	const usuario = url.searchParams.get('usuario') || undefined;
	const q = url.searchParams.get('q')?.trim() || undefined;
	const pedidoT = url.searchParams.get('triaje');
	const triaje: FiltroTriaje | undefined =
		pedidoT === 'sin' || (ESTADOS_TRIAJE as readonly string[]).includes(pedidoT ?? '')
			? (pedidoT as FiltroTriaje)
			: undefined;

	const nombres = await nombresTrampas();
	const pedidoE = url.searchParams.get('escaner');
	const escaner = pedidoE === 'solo' || pedidoE === 'sin' ? (pedidoE as FiltroEscaner) : undefined;
	const filas = await eventosPlanos({ desde, trampa, origen, usuario, q, triaje, escaner });

	/* La misma geo que ya se ve en pantalla, de las bases locales: la IP no sale
	 * del nodo. Una por IP (se reúsa entre eventos del mismo origen). */
	const tor = await ipsTor();
	const geos: Record<string, Geo> = {};
	for (const f of filas) {
		if (f.ip && !(f.ip in geos)) {
			const g = geo(f.ip);
			if (g) geos[f.ip] = g;
		}
	}
	const csv = construirCsvEventos(filas, nombres, geos, tor);
	const fecha = new Date().toISOString().slice(0, 10);

	await auditar(u.correo, 'events exported to CSV', {
		eventos: filas.length,
		filtro: {
			desde,
			trampa: trampa ?? null,
			origen: origen ?? null,
			usuario: usuario ?? null,
			q: q ?? null,
			triaje: triaje ?? null,
			escaner: escaner ?? null
		}
	});

	return new Response(csv, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="sugardaddy-events-${fecha}.csv"`,
			'cache-control': 'no-store'
		}
	});
};
