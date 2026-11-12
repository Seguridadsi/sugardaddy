/*
 * El CSV de la descarga de eventos (routes/events/csv), aparte para probarlo
 * sin base de datos ni red. Lleva las mismas columnas que la tabla de Eventos
 * y, además, la geolocalización que ya se ve en pantalla (país, operador, ASN y
 * Tor): quien exporta a una hoja de cálculo no pierde ese dato. La geo la
 * resuelve el servidor con las bases locales (geo()/ipsTor()); aquí solo se
 * arma el texto.
 */
import type { Geo } from './geo';
import type { eventosPlanos } from './consultas';

/* Una fila tal cual la da eventosPlanos (sin repetir su forma a mano). */
export type FilaEvento = Awaited<ReturnType<typeof eventosPlanos>>[number];

/*
 * Escapa un campo de CSV: comillas dobladas y entrecomillado si hay coma, salto
 * o comilla. Previene además la inyección de fórmulas en hojas de cálculo.
 */
export function csvCampo(v: unknown): string {
	let t = v === null || v === undefined ? '' : String(v);
	if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
	/*
	 * También con punto y coma o tabulador: un Excel en español abre el CSV con «;» de
	 * separador, y un «;=1+1;» sin comillas acababa en una celda con la fórmula =1+1.
	 */
	return /[",;\t\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

export const CABECERA_CSV_EVENTOS = [
	'when',
	'severity',
	'sensor',
	'honeypot',
	'module',
	'type',
	'action',
	'ip',
	'country',
	'organization',
	'asn',
	'tor',
	'username',
	'password',
	'connection_established',
	'alert',
	'test',
	'scanner',
	'triage'
] as const;

/*
 * El CSV entero: cabecera + una línea por evento, con BOM (para que Excel lea
 * bien el UTF-8) y CRLF. `geos` es por IP (lo que devuelve geo()) y `tor` el
 * conjunto de IPs que son nodo de salida de Tor; una IP sin geo deja esas
 * celdas vacías.
 */
export function construirCsvEventos(
	filas: FilaEvento[],
	nombres: Record<string, string>,
	geos: Record<string, Geo>,
	tor: Set<string>
): string {
	const lineas = [CABECERA_CSV_EVENTOS.join(',')];
	for (const f of filas) {
		const g = f.ip ? geos[f.ip] : undefined;
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
				g?.pais ?? '',
				g?.organizacion ?? '',
				g?.asn ?? '',
				f.ip && tor.has(f.ip) ? 'yes' : 'no',
				f.usuario ?? '',
				f.contrasena ?? '',
				f.conexionEstablecida ? 'yes' : 'no',
				f.alerta ?? '',
				f.prueba ? 'yes' : 'no',
				f.escaner ?? '',
				f.triaje ?? ''
			]
				.map(csvCampo)
				.join(',')
		);
	}
	/* BOM para que Excel abra el UTF-8 bien; CRLF por costumbre de CSV. */
	return '﻿' + lineas.join('\r\n') + '\r\n';
}
