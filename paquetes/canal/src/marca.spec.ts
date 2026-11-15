import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	firmanteDePrivada,
	firmarCon,
	generarClaves,
	leerConfianza,
	masNueva,
	renovarMarca,
	verificarMarca,
	type Marca
} from './index.ts';

const marcas = generarClaves();
const cloud = generarClaves();
const licencias = generarClaves();
const fm = firmanteDePrivada(marcas.privada, marcas.publica);
const AHORA = Date.parse('2026-11-15T00:00:00Z');

const marca = (extra: Partial<Marca> = {}): Marca => ({
	tipo: 'marca',
	version: 1,
	emitida: '2026-11-14T00:00:00.000Z',
	caduca: '2026-11-19T00:00:00.000Z',
	plazoHoras: 168,
	ultimas: { cloud: { version: '0.30.0', publicada: '2026-11-01T00:00:00.000Z' } },
	...extra
});
const firmar = (m: Marca, f = fm) => {
	const texto = JSON.stringify(m);
	return { marca: texto, ...firmarCon(texto, f) };
};
const sinClaves = leerConfianza('', '');

describe('marca de tiempo', () => {
	it('vale con la clave de las marcas y dice si ha caducado', () => {
		const v = verificarMarca(sinClaves, [marcas.publica], firmar(marca()), AHORA);
		expect(v.ok && v.caducada).toBe(false);
		const tarde = verificarMarca(
			sinClaves,
			[marcas.publica],
			firmar(marca()),
			Date.parse('2026-11-20T00:00:00Z')
		);
		expect(tarde.ok && tarde.caducada).toBe(true);
	});

	it('la de la edición del nodo vale; la de licencias o la de otra edición, no', () => {
		const c = leerConfianza(`cloud:${cloud.publica},licencias:${licencias.publica}`, '');
		const deCloud = firmar(marca(), firmanteDePrivada(cloud.privada, cloud.publica));
		expect(verificarMarca(c, [], deCloud, AHORA, 'cloud').ok).toBe(true);
		expect(verificarMarca(c, [], deCloud, AHORA, 'community').ok).toBe(false);
		const deLicencias = firmar(marca(), firmanteDePrivada(licencias.privada, licencias.publica));
		expect(verificarMarca(c, [], deLicencias, AHORA).ok).toBe(false);
	});

	it('no vale tocada, eterna, del futuro ni con una edición rara', () => {
		const f = firmar(marca());
		expect(
			verificarMarca(
				sinClaves,
				[marcas.publica],
				{ ...f, marca: f.marca.replace('0.30.0', '0.30.1') },
				AHORA
			).ok
		).toBe(false);
		expect(
			verificarMarca(
				sinClaves,
				[marcas.publica],
				firmar(marca({ caduca: '2027-01-01T00:00:00Z' })),
				AHORA
			)
		).toMatchObject({ ok: false, motivo: 'the timestamp lasts too long' });
		expect(
			verificarMarca(
				sinClaves,
				[marcas.publica],
				firmar(marca({ emitida: '2026-11-16T00:00:00Z', caduca: '2026-11-18T00:00:00Z' })),
				AHORA
			)
		).toMatchObject({ ok: false, motivo: 'the timestamp comes from the future' });
		const rara = {
			...marca(),
			ultimas: { msp: { version: '1.0.0', publicada: '2026-11-01T00:00:00Z' } }
		};
		expect(verificarMarca(sinClaves, [marcas.publica], firmar(rara as Marca), AHORA).ok).toBe(
			false
		);
	});

	it('renovar cambia solo las fechas; la más nueva gana', () => {
		const r = renovarMarca(marca(), AHORA, 5);
		expect(r.ultimas).toEqual(marca().ultimas);
		expect(r.emitida).toBe('2026-11-15T00:00:00.000Z');
		expect(() => renovarMarca(marca(), AHORA, 30)).toThrow();
		const a = { marca: marca() };
		const b = { marca: r };
		expect(masNueva([a, null, b])).toBe(b);
	});

	it('el vector común con Go (vectores/marca.json)', () => {
		const v = JSON.parse(readFileSync(new URL('./vectores/marca.json', import.meta.url), 'utf8'));
		const ahora = Date.parse(v.ahora);
		const r = verificarMarca(sinClaves, [v.marcas], v.conMarcas, ahora);
		expect(r.ok && r.marca.ultimas.cloud?.version).toBe('0.30.0');
		expect(verificarMarca(leerConfianza('', v.legado), [], v.conLegado, ahora).ok).toBe(true);
		expect(verificarMarca(sinClaves, [v.marcas], v.conLegado, ahora).ok).toBe(true);
		expect(verificarMarca(sinClaves, [], v.conMarcas, ahora).ok).toBe(false);
	});
});
