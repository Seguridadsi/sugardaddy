import { describe, expect, it } from 'vitest';
import { estadoMadurez, leerMadurez } from './madurez.ts';

const buena = {
	cowrie: { version: '0.2.4', hecha: true, probada: '2026-11-18', banco: 'probar-trampa' },
	'fichero-word': { version: '0.1.0', hecha: true, probada: null, banco: null }
};

describe('leerMadurez', () => {
	it('acepta la forma que firma inventario.ts', () => {
		expect(leerMadurez(buena)).toEqual(buena);
	});

	it('con una entrada rara no enseña nada a medias', () => {
		for (const mala of [
			null,
			[],
			'x',
			{ Cowrie: buena.cowrie },
			{ cowrie: { ...buena.cowrie, hecha: 'sí' } },
			{ cowrie: { ...buena.cowrie, probada: '18/11/2026' } },
			{ cowrie: { ...buena.cowrie, version: '' } },
			{ cowrie: { ...buena.cowrie, banco: 'Banco raro' } },
			{ cowrie: { version: '1' } }
		])
			expect(leerMadurez(mala)).toBeNull();
	});

	it('no se deja colar claves del prototipo', () => {
		expect(leerMadurez(JSON.parse('{"__proto__": {"version":"1","hecha":true}}'))).toBeNull();
	});
});

describe('estadoMadurez', () => {
	const m = leerMadurez(buena)!;

	it('soportada: hecha, probada, publicada y con el mismo manifiesto', () => {
		expect(estadoMadurez(m, '0.32.2', 'cowrie', '0.2.4')).toMatchObject({
			nivel: 'soportada',
			hecha: true,
			probada: true,
			publicada: true,
			soportada: true,
			versionNodo: '0.32.2',
			probadaEl: '2026-11-18',
			banco: 'probar-trampa'
		});
	});

	it('con otro manifiesto en el nodo, probada pero no soportada', () => {
		expect(estadoMadurez(m, '0.32.2', 'cowrie', '0.2.5')).toMatchObject({
			nivel: 'probada',
			soportada: false
		});
	});

	it('publicada sin banco: sale sin probar', () => {
		expect(estadoMadurez(m, '0.32.2', 'fichero-word', '0.1.0')).toMatchObject({
			nivel: 'publicada',
			publicada: true,
			probada: false,
			banco: null
		});
	});

	it('lo que no va en la versión no está publicado', () => {
		expect(estadoMadurez(m, '0.32.2', 'nueva', '0.1.0')).toMatchObject({
			nivel: 'sin-publicar',
			publicada: false,
			versionModulo: null
		});
		expect(estadoMadurez(m, '0.32.2', 'constructor', '0.1.0').nivel).toBe('sin-publicar');
	});
});
