import { describe, expect, it } from 'vitest';
import {
	ZONA_DOCUMENTOS,
	ZONA_POR_DEFECTO,
	formatearFecha,
	nombreZona,
	zonaValida,
	zonasConocidas
} from './fechas';

/* Viernes 6 de noviembre de 2026, 13:05:09 UTC: invierno en Madrid (UTC+1). */
const INSTANTE = '2026-11-06T13:05:09Z';

describe('el formateador de fechas', () => {
	it('el mismo instante se lee distinto en cada zona', () => {
		expect(formatearFecha(INSTANTE, 'hora', 'Europe/Madrid')).toBe('14:05');
		expect(formatearFecha(INSTANTE, 'hora', 'Atlantic/Canary')).toBe('13:05');
		expect(formatearFecha(INSTANTE, 'hora', 'America/Mexico_City')).toBe('07:05');
		expect(formatearFecha(INSTANTE, 'hora', 'UTC')).toBe('13:05');
	});

	it('la zona también decide el día, no solo la hora', () => {
		const madrugada = '2026-11-06T23:30:00Z';
		expect(formatearFecha(madrugada, 'dia', 'Europe/Madrid')).toBe('7 Nov');
		expect(formatearFecha(madrugada, 'dia', 'America/New_York')).toBe('6 Nov');
	});

	it('respeta el cambio de hora', () => {
		expect(formatearFecha('2026-07-01T12:00:00Z', 'hora', 'Europe/Madrid')).toBe('14:00');
		expect(formatearFecha('2026-12-01T12:00:00Z', 'hora', 'Europe/Madrid')).toBe('13:00');
	});

	it('cada estilo, con el formato de la casa y en 24 horas', () => {
		const zona = 'Europe/Madrid';
		expect(formatearFecha(INSTANTE, 'horaSegundos', zona)).toBe('14:05:09');
		expect(formatearFecha(INSTANTE, 'dia', zona)).toBe('6 Nov');
		expect(formatearFecha(INSTANTE, 'diaLargo', zona)).toBe('6 November');
		expect(formatearFecha(INSTANTE, 'fecha', zona)).toBe('6 Nov 2026');
		expect(formatearFecha(INSTANTE, 'fechaLarga', zona)).toBe('6 November 2026');
		expect(formatearFecha(INSTANTE, 'fechaHora', zona)).toBe('6 Nov 2026, 14:05');
		expect(formatearFecha(INSTANTE, 'fechaHoraLarga', zona)).toBe('6 November 2026 at 14:05');
		expect(formatearFecha(INSTANTE, 'diaHora', zona)).toBe('6 November at 14:05');
		expect(formatearFecha(INSTANTE, 'semanaHora', zona)).toBe('Fri 6 Nov, 14:05');
		expect(formatearFecha(INSTANTE, 'semanaHoraLarga', zona)).toBe('Friday 6 November at 14:05');
		expect(formatearFecha(INSTANTE, 'mes', zona)).toBe('November 2026');
		expect(formatearFecha('2026-11-06T00:05:00+01:00', 'hora', zona)).toBe('00:05');
	});

	it('vale con texto, con número y con Date', () => {
		const d = new Date(INSTANTE);
		expect(formatearFecha(d, 'hora', 'UTC')).toBe('13:05');
		expect(formatearFecha(d.getTime(), 'hora', 'UTC')).toBe('13:05');
	});

	it('una fecha que no lo es no tira la página', () => {
		expect(formatearFecha('no es una fecha', 'hora', 'UTC')).toBe('');
	});

	it('una zona que este sistema no conoce cae en la de por defecto, no en un error', () => {
		expect(formatearFecha(INSTANTE, 'hora', 'Marte/Olimpo')).toBe(
			formatearFecha(INSTANTE, 'hora', ZONA_POR_DEFECTO)
		);
	});
});

describe('qué zona se admite', () => {
	it('los nombres de la base de zonas', () => {
		for (const z of ['Europe/Madrid', 'Atlantic/Canary', 'America/New_York', 'UTC', 'Etc/GMT+1'])
			expect(zonaValida(z)).toBe(true);
	});

	it('nada más, aunque Intl lo tragara', () => {
		for (const z of [
			'',
			'Marte/Olimpo',
			'+01:00',
			'<b>',
			'Europe/Madrid; drop',
			null,
			3,
			undefined
		])
			expect(zonaValida(z)).toBe(false);
		expect(zonaValida('A'.repeat(65))).toBe(false);
	});

	it('todo lo que ofrece el selector se puede guardar, con UTC la primera', () => {
		const zonas = zonasConocidas();
		expect(zonas[0]).toBe('UTC');
		expect(zonas).toContain(ZONA_POR_DEFECTO);
		expect(new Set(zonas).size).toBe(zonas.length);
		expect(zonas.filter((z) => !zonaValida(z))).toEqual([]);
	});

	it('el nombre que se enseña lleva espacios', () => {
		expect(nombreZona('America/New_York')).toBe('America/New York');
		expect(zonaValida(ZONA_DOCUMENTOS)).toBe(true);
	});
});
