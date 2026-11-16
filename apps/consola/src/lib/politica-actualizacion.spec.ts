import { describe, expect, it } from 'vitest';
import {
	POLITICA_BANCA,
	RETARDO_MAXIMO_HORAS,
	datosDeRelease,
	esBanca,
	esperaDe,
	leerPolitica,
	politicaDelFormulario
} from './politica-actualizacion';

const H = 3_600_000;
const pub = Date.parse('2026-11-10T12:00:00Z');
const v = { version: '0.30.0', publicada: new Date(pub).toISOString(), urgente: false };
const aprobada = { version: '0.30.0', quien: 'ana@banco.es', cuando: '2026-11-10T13:00:00Z' };

describe('política de cambios', () => {
	it('lee lo guardado y cae en automática sin retardo con lo raro', () => {
		expect(leerPolitica(null)).toEqual({ modo: 'automatica', retardoHoras: 0 });
		expect(leerPolitica({ modo: 'manual', retardoHoras: 72 })).toEqual(POLITICA_BANCA);
		expect(leerPolitica({ modo: 'x', retardoHoras: -3 })).toEqual({
			modo: 'automatica',
			retardoHoras: 0
		});
		expect(leerPolitica({ modo: 'manual', retardoHoras: 99_999 }).retardoHoras).toBe(
			RETARDO_MAXIMO_HORAS
		);
	});

	it('el formulario solo acepta modos conocidos y horas entre 0 y 720', () => {
		expect(politicaDelFormulario('manual', '72')).toEqual(POLITICA_BANCA);
		expect(politicaDelFormulario('automatica', '')).toEqual({
			modo: 'automatica',
			retardoHoras: 0
		});
		expect(politicaDelFormulario('nunca', '0')).toBeNull();
		expect(politicaDelFormulario('manual', '721')).toBeNull();
		expect(politicaDelFormulario('manual', '-1')).toBeNull();
		expect(politicaDelFormulario('manual', '1.5')).toBeNull();
		expect(esBanca(POLITICA_BANCA)).toBe(true);
		expect(esBanca({ modo: 'manual', retardoHoras: 24 })).toBe(false);
	});

	it('cuenta igual que el actualizador (politica.go)', () => {
		expect(esperaDe(v, { modo: 'automatica', retardoHoras: 0 }, null, pub).motivo).toBeNull();
		expect(esperaDe(v, { modo: 'manual', retardoHoras: 0 }, null, pub).motivo).toBe('aprobacion');
		expect(
			esperaDe(v, { modo: 'manual', retardoHoras: 0 }, { ...aprobada, version: '0.29.0' }, pub)
				.motivo
		).toBe('aprobacion');
		expect(esperaDe(v, POLITICA_BANCA, aprobada, pub + 71 * H)).toEqual({
			motivo: 'retardo',
			hasta: new Date(pub + 72 * H).toISOString()
		});
		expect(esperaDe(v, POLITICA_BANCA, aprobada, pub + 72 * H).motivo).toBeNull();
		/* Urgente: sin retardo, pero con aprobación. */
		const u = { ...v, urgente: true };
		expect(esperaDe(u, POLITICA_BANCA, aprobada, pub).motivo).toBeNull();
		expect(esperaDe(u, POLITICA_BANCA, null, pub).motivo).toBe('aprobacion');
		/* Sin fecha legible: no hay desde dónde contar. */
		expect(esperaDe({ ...v, publicada: 'x' }, POLITICA_BANCA, aprobada, pub)).toEqual({
			motivo: 'retardo',
			hasta: null
		});
	});

	it('saca de la versión firmada su número, su fecha y si es urgente', () => {
		expect(
			datosDeRelease(JSON.stringify({ version: '1.0.0', publicada: 'p', urgente: true }))
		).toEqual({ version: '1.0.0', publicada: 'p', urgente: true });
		expect(datosDeRelease(JSON.stringify({ version: '1.0.0', urgente: 'si' }))?.urgente).toBe(
			false
		);
		expect(datosDeRelease('no es json')).toBeNull();
		expect(datosDeRelease(null)).toBeNull();
	});
});
