/*
 * El CSV de la descarga de eventos, sin base de datos ni bases de geo: se le
 * pasan las filas, la geo por IP y el conjunto Tor como datos.
 */
import { describe, expect, it } from 'vitest';
import {
	CABECERA_CSV_EVENTOS,
	construirCsvEventos,
	csvCampo,
	type FilaEvento
} from './csv-eventos';

const fila = (f: Partial<FilaEvento>): FilaEvento =>
	({
		cuando: new Date('2026-11-01T10:00:00.000Z'),
		severidad: 'alta',
		sensor: 'S1',
		trampa: 'ssh',
		modulo: 'cowrie',
		tipo: 'contenedor',
		accion: 'autenticacion',
		ip: null,
		usuario: null,
		contrasena: null,
		conexionEstablecida: true,
		alerta: null,
		prueba: false,
		triaje: null,
		...f
	}) as unknown as FilaEvento;

const nombres = { ssh: 'SSH de RRHH' };

describe('construirCsvEventos', () => {
	it('la cabecera lleva geo (pais, organizacion, asn, tor) justo tras ip', () => {
		const cols = CABECERA_CSV_EVENTOS;
		const i = cols.indexOf('ip');
		expect(cols.slice(i, i + 5)).toEqual(['ip', 'pais', 'organizacion', 'asn', 'tor']);
		const csv = construirCsvEventos([], nombres, {}, new Set());
		expect(csv.startsWith('﻿')).toBe(true);
		expect(csv.split('\r\n')[0]).toBe('﻿' + cols.join(','));
	});

	it('rellena país/operador/ASN/Tor por IP', () => {
		const geos = {
			'8.8.8.8': { pais: 'US', asn: 15169, organizacion: 'Google LLC', region: null }
		};
		const csv = construirCsvEventos(
			[fila({ ip: '8.8.8.8', usuario: 'root' })],
			nombres,
			geos,
			new Set(['8.8.8.8'])
		);
		const campos = csv.trim().split('\r\n')[1].split(',');
		const c = CABECERA_CSV_EVENTOS;
		expect(campos[c.indexOf('ip')]).toBe('8.8.8.8');
		expect(campos[c.indexOf('pais')]).toBe('US');
		expect(campos[c.indexOf('organizacion')]).toBe('Google LLC');
		expect(campos[c.indexOf('asn')]).toBe('15169');
		expect(campos[c.indexOf('tor')]).toBe('sí');
		expect(campos[c.indexOf('trampa')]).toBe('SSH de RRHH');
	});

	it('una IP sin geo deja esas celdas vacías y tor en no', () => {
		const csv = construirCsvEventos([fila({ ip: '203.0.113.9' })], nombres, {}, new Set());
		const c = CABECERA_CSV_EVENTOS;
		const campos = csv.trim().split('\r\n')[1].split(',');
		expect(campos[c.indexOf('pais')]).toBe('');
		expect(campos[c.indexOf('organizacion')]).toBe('');
		expect(campos[c.indexOf('asn')]).toBe('');
		expect(campos[c.indexOf('tor')]).toBe('no');
	});

	it('sigue escapando la inyección de fórmulas en el operador', () => {
		const geos = {
			'1.2.3.4': { pais: 'ZZ', asn: 1, organizacion: '=HYPERLINK("http://x")', region: null }
		};
		const csv = construirCsvEventos([fila({ ip: '1.2.3.4' })], nombres, geos, new Set());
		expect(csv).toContain('"\'=HYPERLINK(""http://x"")"');
	});

	it('csvCampo antepone comilla a lo que empieza por =,+,-,@ (y solo entrecomilla si hace falta)', () => {
		expect(csvCampo('=1+1')).toBe("'=1+1");
		expect(csvCampo('=1,2')).toBe('"\'=1,2"');
		expect(csvCampo('normal')).toBe('normal');
	});
});
