import { error } from '@sveltejs/kit';
import { SEVERIDADES, auditar, eventosPlanos, nombresTrampas } from '$lib/server/consultas';

/*
 * Descarga de los eventos en CSV, con los mismos filtros que la página de
 * Eventos. Pensado para la edición community («saca tus datos tú mismo»), pero
 * útil en cualquier edición. Lo puede hacer cualquier usuario con sesión (ver
 * los eventos no pide un permiso aparte); queda en la auditoría con quién y
 * cuántos, nunca el contenido.
 */

/* Escapa un campo de CSV: comillas dobladas y entrecomillado si hay coma, salto
 * o comilla. Previene además la inyección de fórmulas en hojas de cálculo. */
function csvCampo(v: unknown): string {
	let t = v === null || v === undefined ? '' : String(v);
	if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
	return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

export const GET = async ({ url, locals }) => {
	const u = locals.usuario;
	if (!u) error(401, 'Hay que entrar primero.');

	const pedida = url.searchParams.get('desde');
	const desde = SEVERIDADES.find((x) => x === pedida) ?? 'baja';
	const trampa = url.searchParams.get('trampa') || undefined;
	const origen = url.searchParams.get('origen')?.trim() || undefined;

	const nombres = await nombresTrampas();
	const filas = await eventosPlanos({ desde, trampa, origen });

	const cabecera = [
		'cuando',
		'severidad',
		'sensor',
		'trampa',
		'modulo',
		'tipo',
		'accion',
		'ip',
		'usuario',
		'contrasena',
		'conexion_establecida',
		'alerta',
		'prueba'
	];
	const lineas = [cabecera.join(',')];
	for (const f of filas) {
		lineas.push(
			[
				f.cuando.toISOString(),
				f.severidad,
				f.sensor,
				nombres[f.trampa] ?? f.trampa,
				f.modulo,
				f.tipo,
				f.accion,
				f.ip ?? '',
				f.usuario ?? '',
				f.contrasena ?? '',
				f.conexionEstablecida ? 'sí' : 'no',
				f.alerta ?? '',
				f.prueba ? 'sí' : 'no'
			]
				.map(csvCampo)
				.join(',')
		);
	}
	/* BOM para que Excel abra el UTF-8 bien; CRLF por costumbre de CSV. */
	const csv = '﻿' + lineas.join('\r\n') + '\r\n';
	const fecha = new Date().toISOString().slice(0, 10);

	await auditar(u.correo, 'eventos exportados a CSV', {
		eventos: filas.length,
		filtro: { desde, trampa: trampa ?? null, origen: origen ?? null }
	});

	return new Response(csv, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="sugardaddy-eventos-${fecha}.csv"`,
			'cache-control': 'no-store'
		}
	});
};
