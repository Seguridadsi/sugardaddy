import { describe, expect, it } from 'vitest';
import { discoMasDebil, leerDiscoLatido } from './disco-latido.ts';

const sensor = (cifrado: unknown, tpm?: unknown) => ({
	'motor.aislamiento': { valor: 'runsc' },
	'disco.cifrado': { valor: cifrado },
	...(tpm === undefined ? {} : { 'disco.tpm': { valor: tpm, motivo: 'tpm.ausente' } })
});

describe('el disco de datos en el latido', () => {
	it('el más débil de los sensores que lo dicen', () => {
		expect(discoMasDebil([sensor(true, true)])).toEqual({ cifrado: true, tpm: true });
		expect(discoMasDebil([sensor(true, true), sensor(true, false)])).toEqual({
			cifrado: true,
			tpm: false
		});
		expect(discoMasDebil([sensor(true, true), sensor(false, false)])).toEqual({
			cifrado: false,
			tpm: false
		});
		/* Sin disco.tpm, no está sellado. */
		expect(discoMasDebil([sensor(true)])).toEqual({ cifrado: true, tpm: false });
	});

	it('los que no lo dicen no cuentan; si ninguno lo dice, no va', () => {
		expect(discoMasDebil([])).toBeUndefined();
		expect(discoMasDebil([undefined, null, {}, { 'motor.aislamiento': { valor: 'runsc' } }])).toBe(
			undefined
		);
		expect(discoMasDebil([sensor('si', true)])).toBeUndefined();
		expect(discoMasDebil([{}, sensor(true, true), undefined])).toEqual({
			cifrado: true,
			tpm: true
		});
	});

	it('el panel solo acepta los dos booleanos, sin TPM si no está cifrado', () => {
		expect(leerDiscoLatido({ cifrado: true, tpm: true })).toEqual({ cifrado: true, tpm: true });
		expect(leerDiscoLatido({ cifrado: true, tpm: false, motivo: 'x' })).toEqual({
			cifrado: true,
			tpm: false
		});
		expect(leerDiscoLatido({ cifrado: false, tpm: true })).toEqual({ cifrado: false, tpm: false });
		for (const mal of [null, undefined, 'si', { cifrado: 'si', tpm: true }, { cifrado: true }, []])
			expect(leerDiscoLatido(mal)).toBeUndefined();
	});
});
