import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	digestDeImagen,
	firmanteDePrivada,
	firmarCon,
	generarClaves,
	leerConfianza,
	textoRetiradas,
	verificarRetiradas,
	type Retiradas
} from './index.ts';

const cloud = generarClaves();
const otra = generarClaves();
const D1 = 'sha256:' + '1'.repeat(64);
const lista = (cambios: Partial<Retiradas> = {}): Retiradas => ({
	tipo: 'retiradas',
	version: 1,
	edicion: 'cloud',
	digests: [D1],
	emitida: '2026-11-15T10:00:00.000Z',
	...cambios
});
const firmar = (r: Retiradas | Record<string, unknown>, con = cloud) => {
	const t = JSON.stringify(r);
	return { retiradas: t, ...firmarCon(t, firmanteDePrivada(con.privada)) };
};
const c = leerConfianza(`cloud:${cloud.publica}`, '');

describe('imágenes retiradas', () => {
	it('firmada con la clave de cloud, vale para cloud', () => {
		expect(verificarRetiradas(c, firmar(lista()), 'cloud')).toEqual({
			ok: true,
			retiradas: lista()
		});
	});

	it('con otra clave, o la de otro uso, no vale', () => {
		expect(verificarRetiradas(c, firmar(lista(), otra), 'cloud').ok).toBe(false);
		const otros = leerConfianza(`community:${cloud.publica},delegaciones:${cloud.publica}`, '');
		expect(verificarRetiradas(otros, firmar(lista()), 'cloud').ok).toBe(false);
	});

	it('una de cloud no vale en un nodo community, aunque la clave sea la misma', () => {
		const ambas = leerConfianza(`cloud:${cloud.publica},community:${cloud.publica}`, '');
		expect(verificarRetiradas(ambas, firmar(lista()), 'community').ok).toBe(false);
	});

	it('quitar un digest del texto firmado la invalida', () => {
		const f = firmar(lista({ digests: [D1, 'sha256:' + '2'.repeat(64)] }));
		const tocada = { ...f, retiradas: f.retiradas.replace(`,"sha256:${'2'.repeat(64)}"`, '') };
		expect(verificarRetiradas(c, tocada, 'cloud').ok).toBe(false);
	});

	it.each([
		['un digest sin prefijo', { digests: ['1'.repeat(64)] }],
		['un digest repetido', { digests: [D1, D1] }],
		['una edición desconocida', { edicion: 'msp' }],
		['una fecha mala', { emitida: 'ayer' }]
	])('%s no vale aunque venga firmada', (_, x) => {
		expect(verificarRetiradas(c, firmar({ ...lista(), ...x }), 'cloud').ok).toBe(false);
	});

	it('el digest de una imagen fijada', () => {
		expect(digestDeImagen(`r.azurecr.io/x:1@${D1}`)).toBe(D1);
		expect(digestDeImagen('r.azurecr.io/x:1')).toBeNull();
		expect(textoRetiradas(lista())).toBe(JSON.stringify(lista()));
	});

	/* El mismo vector que comprueba sensor/internal/actualizador (TestVectorRetiradas). */
	it('vector compartido con el Go', () => {
		const v = JSON.parse(
			readFileSync(new URL('./vectores/retiradas.json', import.meta.url), 'utf8')
		);
		const r = verificarRetiradas(v.clavePublicacion, v.firmada, 'cloud');
		expect(r).toEqual({ ok: true, retiradas: v.retiradas });
	});
});
