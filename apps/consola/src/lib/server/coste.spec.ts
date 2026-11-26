import { describe, expect, it } from 'vitest';
import { compacto, costeDe, duracionLegible, textoCoste, tokensEstimados } from './coste';

describe('coste causado al atacante', () => {
	const campos = { tiempo: 'duration', bytes: 'bytes' };

	it('lee segundos, milisegundos y números', () => {
		expect(costeDe({ duration: '6.010' }, campos)).toEqual({
			retenidoMs: 6010,
			bytesEnviados: null
		});
		expect(costeDe({ duration: '450ms' }, campos).retenidoMs).toBe(450);
		expect(costeDe({ duration: 12, bytes: '2048' }, campos)).toEqual({
			retenidoMs: 12000,
			bytesEnviados: 2048
		});
		expect(costeDe({ duration: '3s' }, campos).retenidoMs).toBe(3000);
	});

	it('desconfía de lo que escribe el atacante', () => {
		for (const v of ['-1', 'NaN', '1e9', '12 horas', '', null, {}, [], '99999999999999999999'])
			expect(costeDe({ duration: v, bytes: v }, campos)).toEqual({
				retenidoMs: null,
				bytesEnviados: null
			});
		expect(costeDe({ duration: String(31 * 24 * 3600) }, campos).retenidoMs).toBeNull();
		expect(costeDe({ bytes: '10ms' }, campos).bytesEnviados).toBeNull();
	});

	it('sin campos declarados, nada', () => {
		expect(costeDe({ duration: '6' }, undefined)).toEqual({
			retenidoMs: null,
			bytesEnviados: null
		});
		expect(costeDe(undefined, campos)).toEqual({ retenidoMs: null, bytesEnviados: null });
	});

	it('lo dice para personas', () => {
		expect(duracionLegible(12_400)).toBe('12 s');
		expect(duracionLegible(185_000)).toBe('3 min 5 s');
		expect(duracionLegible((2 * 60 + 14) * 60_000)).toBe('2 h 14 min');
		expect(duracionLegible(50 * 3600_000)).toBe('2 d 2 h');
		expect(tokensEstimados(4000)).toBe(1000);
		/* Sin depender de los datos de idioma de la máquina (Intl compacto daba «3.2m»). */
		expect(compacto(3_200_000)).toBe('3.2M');
		expect(compacto(800_000)).toBe('800K');
		expect(compacto(999_960)).toBe('1M');
		expect(compacto(1_500)).toBe('1.5K');
		expect(compacto(12)).toBe('12');
		expect(textoCoste(0, 0)).toBeNull();
		expect(textoCoste(500, 100)).toBeNull();
		expect(textoCoste(8_040_000, 0)).toBe('Held the attacker for 2 h 14 min');
		expect(textoCoste(60_000, 3_200_000)).toBe(
			'Held the attacker for 1 min and sent it 3.2MB of decoy data (~800K tokens if an AI agent read it)'
		);
	});
});
