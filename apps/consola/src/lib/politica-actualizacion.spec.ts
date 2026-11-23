import { describe, expect, it } from 'vitest';
import {
	POLITICA_BANCA,
	RETARDO_MAXIMO_HORAS,
	combinar,
	datosDeRelease,
	describirVentana,
	esBanca,
	esperaDe,
	leerPlantilla,
	leerPolitica,
	leerVentanas,
	lineasEnv,
	plantillaDe,
	politicaDelEntorno,
	politicaDelFormulario,
	sueloActivo,
	textoVentanas,
	ventanaAbierta,
	ventanaDelFormulario
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

describe('ventana horaria (como ventana.go)', () => {
	const laborables = {
		dias: [1, 2, 3, 4, 5],
		desde: '02:00',
		hasta: '05:00',
		zona: 'Europe/Madrid'
	};
	/* Miércoles 18 de noviembre de 2026; Madrid está en UTC+1. */
	const madrid = (d: number, h: number, m = 0) => Date.UTC(2026, 10, d, h - 1, m);

	it('abre y cierra en su zona, cruza la medianoche y dura 24 h con desde = hasta', () => {
		expect(ventanaAbierta(laborables, madrid(18, 2))).toBe(true);
		expect(ventanaAbierta(laborables, madrid(18, 4, 59))).toBe(true);
		expect(ventanaAbierta(laborables, madrid(18, 5))).toBe(false);
		expect(ventanaAbierta(laborables, madrid(21, 3))).toBe(false);
		expect(ventanaAbierta({ dias: [3], desde: '02:00', hasta: '03:00' }, madrid(18, 3, 30))).toBe(
			true
		);
		const viernes = { dias: [5], desde: '22:00', hasta: '02:00', zona: 'Europe/Madrid' };
		expect(ventanaAbierta(viernes, madrid(20, 23))).toBe(true);
		expect(ventanaAbierta(viernes, madrid(21, 1, 30))).toBe(true);
		expect(ventanaAbierta(viernes, madrid(20, 1, 30))).toBe(false);
		const domingo = { dias: [7], desde: '00:00', hasta: '00:00', zona: 'Europe/Madrid' };
		expect(ventanaAbierta(domingo, madrid(22, 23, 59))).toBe(true);
		expect(ventanaAbierta(domingo, madrid(23, 0))).toBe(false);
		expect(ventanaAbierta({ dias: [], desde: '', hasta: '' }, madrid(18, 3))).toBe(false);
	});

	it('lee ACTUALIZACION_VENTANA como Go y rechaza lo mismo', () => {
		const v = leerVentanas('1-5 02:00-05:00 Europe/Madrid; 6,7 00:00-00:00');
		expect(v).toHaveLength(2);
		expect(textoVentanas(v!)).toBe('1,2,3,4,5 02:00-05:00 Europe/Madrid; 6,7 00:00-00:00');
		expect(leerVentanas('')).toEqual([]);
		for (const malo of [
			'1-5',
			'0 02:00-03:00',
			'1-8 02:00-03:00',
			'5-1 02:00-03:00',
			'1 2:00-03:00',
			'1 24:00-03:00',
			'1 02:00-03:00 Marte/Olimpo',
			'1 02:00-03:00 ../../etc/passwd',
			'1 02:00 03:00 x y'
		])
			expect(leerVentanas(malo), malo).toBeNull();
	});

	it('cuenta la ventana como el actualizador: urgente no se la salta y el .env no se ensancha', () => {
		const noche = [{ dias: [1, 2, 3, 4, 5, 6, 7], desde: '02:00', hasta: '04:00' }];
		const mediodia = Date.parse('2026-11-18T12:00:00Z');
		expect(
			esperaDe(v, { modo: 'automatica', retardoHoras: 0, ventanas: noche }, null, mediodia)
		).toEqual({ motivo: 'ventana', hasta: '2026-11-19T02:00:00.000Z' });
		expect(
			esperaDe(
				{ ...v, urgente: true },
				{ modo: 'automatica', retardoHoras: 720, ventanas: noche },
				null,
				mediodia
			).motivo
		).toBe('ventana');
		const suelo = politicaDelEntorno((k) => ({ ACTUALIZACION_VENTANA: '1-7 02:00-04:00' })[k]);
		const todoElDia = {
			modo: 'automatica' as const,
			retardoHoras: 0,
			ventanas: [{ dias: [1, 2, 3, 4, 5, 6, 7], desde: '00:00', hasta: '00:00' }]
		};
		expect(esperaDe(v, combinar(suelo, todoElDia), null, mediodia).motivo).toBe('ventana');
		const tarde = {
			...todoElDia,
			ventanas: [{ ...todoElDia.ventanas[0], desde: '03:00', hasta: '05:00' }]
		};
		expect(esperaDe(v, combinar(suelo, tarde), null, Date.parse('2026-11-19T02:30:00Z'))).toEqual({
			motivo: 'ventana',
			hasta: '2026-11-19T03:00:00.000Z'
		});
		const mala = politicaDelEntorno((k) => ({ ACTUALIZACION_VENTANA: 'laborables' })[k]);
		expect(mala.ventanaIlegible).toBe(true);
		expect(esperaDe(v, mala, null, mediodia)).toEqual({ motivo: 'ventana', hasta: null });
	});

	it('el suelo del .env: lo que no se entiende es lo más estricto', () => {
		const de = (e: Record<string, string>) => politicaDelEntorno((k) => e[k]);
		expect(de({})).toMatchObject({ modo: 'automatica', retardoHoras: 0 });
		expect(de({ ACTUALIZACION_POLITICA: 'manul' }).modo).toBe('manual');
		expect(de({ ACTUALIZACION_RETARDO_HORAS: 'x' }).retardoHoras).toBe(RETARDO_MAXIMO_HORAS);
		expect(de({ ACTUALIZACION_RETARDO_HORAS: '-5' }).retardoHoras).toBe(0);
		expect(sueloActivo(de({}))).toBe(false);
		expect(sueloActivo(de({ ACTUALIZACION_RETARDO_HORAS: '1' }))).toBe(true);
	});

	it('formulario, plantilla y líneas del .env', () => {
		expect(ventanaDelFormulario(false, [], '', '', '')).toEqual({ ventanas: [] });
		expect(ventanaDelFormulario(true, ['5', '1', '1'], '02:00', '05:00', 'UTC')).toEqual({
			ventanas: [{ dias: [1, 5], desde: '02:00', hasta: '05:00' }]
		});
		expect(ventanaDelFormulario(true, [], '02:00', '05:00', '')).toHaveProperty('error');
		expect(ventanaDelFormulario(true, ['1'], '02:00', '05:00', 'Marte/Olimpo')).toHaveProperty(
			'error'
		);
		const p = { modo: 'manual' as const, retardoHoras: 72, ventanas: [laborables] };
		expect(leerPlantilla(JSON.parse(JSON.stringify(plantillaDe(p))))).toEqual(p);
		expect(leerPlantilla({ ...plantillaDe(p), formato: 'otra' })).toBeNull();
		expect(leerPlantilla({ ...plantillaDe(p), retardoHoras: 9999 })).toBeNull();
		expect(leerPlantilla({ ...plantillaDe(p), ventanas: [{ dias: [9] }] })).toBeNull();
		expect(lineasEnv(p)).toEqual([
			'ACTUALIZACION_POLITICA=manual',
			'ACTUALIZACION_RETARDO_HORAS=72',
			'ACTUALIZACION_VENTANA="1,2,3,4,5 02:00-05:00 Europe/Madrid"'
		]);
		expect(describirVentana(laborables)).toBe('Monday to Friday, 02:00–05:00 (Europe/Madrid)');
		/* Lo guardado que no vale se queda como ventana que nunca abre. */
		expect(leerPolitica({ modo: 'automatica', ventanas: [{ dias: [9] }] }).ventanas).toEqual([
			{ dias: [], desde: '', hasta: '' }
		]);
	});
});
