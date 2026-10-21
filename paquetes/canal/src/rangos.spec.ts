import { describe, expect, it } from 'vitest';
import { aCidrs, contenidaEn, rango, restar } from './rangos.ts';

describe('contenidaEn', () => {
	it('IPv4 en IPs y redes', () => {
		expect(contenidaEn('10.1.1.1', ['10.0.0.0/8'])).toBe(true);
		expect(contenidaEn('11.1.1.1', ['10.0.0.0/8'])).toBe(false);
		expect(contenidaEn('10.1.1.1', ['10.1.1.1'])).toBe(true);
	});
	it('IPv6 en redes (antes solo comparaba IPs exactas)', () => {
		expect(contenidaEn('2001:db8:1::5', ['2001:db8::/32'])).toBe(true);
		expect(contenidaEn('2001:db9::1', ['2001:db8::/32'])).toBe(false);
	});
	it('una red solo está contenida si cabe entera', () => {
		expect(contenidaEn('10.1.0.0/16', ['10.0.0.0/8'])).toBe(true);
		expect(contenidaEn('10.0.0.0/8', ['10.1.0.0/16'])).toBe(false);
	});
	it('no mezcla familias', () => {
		expect(contenidaEn('::ffff:10.1.1.1', ['10.0.0.0/8'])).toBe(false);
	});
});

describe('restar la blanca de la negra', () => {
	it('el caso del controlador de dominio: la red se parte y la IP blanca no sale', () => {
		const r = restar('10.0.0.0/8', ['10.1.1.1']);
		expect(r).toHaveLength(24);
		expect(r.some((c) => contenidaEn('10.1.1.1', [c]))).toBe(false);
		expect(r.some((c) => contenidaEn('10.1.1.2', [c]))).toBe(true);
		expect(r.some((c) => contenidaEn('10.255.255.255', [c]))).toBe(true);
	});
	it('sin solape, la entrada tal cual', () => {
		expect(restar('192.0.2.0/24', ['10.1.1.1'])).toEqual(['192.0.2.0/24']);
		expect(restar('203.0.113.9', [])).toEqual(['203.0.113.9']);
	});
	it('si la blanca la cubre, no queda nada', () => {
		expect(restar('10.1.2.0/24', ['10.0.0.0/8'])).toEqual([]);
		expect(restar('10.1.1.1', ['10.1.1.1'])).toEqual([]);
	});
	it('IPv6', () => {
		const r = restar('2001:db8::/32', ['2001:db8:1::/48']);
		expect(r).toHaveLength(16);
		expect(r.some((c) => contenidaEn('2001:db8:1::1', [c]))).toBe(false);
		expect(r.some((c) => contenidaEn('2001:db8:2::1', [c]))).toBe(true);
	});
	it('entradas que no son IP ni red pasan sin tocar', () => {
		expect(restar('no-es-ip', ['10.0.0.0/8'])).toEqual(['no-es-ip']);
	});
});

describe('aCidrs', () => {
	it('cubre el rango exacto con el mínimo de redes', () => {
		expect(aCidrs(rango('10.0.0.0/8')!)).toEqual(['10.0.0.0/8']);
		expect(
			aCidrs({ familia: 4, desde: rango('10.0.0.1')!.desde, hasta: rango('10.0.0.6')!.desde })
		).toEqual(['10.0.0.1', '10.0.0.2/31', '10.0.0.4/31', '10.0.0.6']);
	});
	it('escribe IPv6 abreviada', () => {
		expect(aCidrs(rango('2001:db8::/32')!)).toEqual(['2001:db8::/32']);
		expect(aCidrs(rango('2001:db8:0:1::/64')!)).toEqual(['2001:db8:0:1::/64']);
		expect(aCidrs(rango('::1')!)).toEqual(['::1']);
		expect(aCidrs(rango('fe80::/10')!)).toEqual(['fe80::/10']);
		expect(aCidrs(rango('1:2:3:4:5:6:7:8')!)).toEqual(['1:2:3:4:5:6:7:8']);
	});
});

/*
 * Contra fuerza bruta: redes al azar dentro de 10.0.0.0/22 (1024 direcciones),
 * se comprueba dirección a dirección que lo que queda es exactamente
 * negra menos blanca, y sin redes que se pisen.
 */
describe('resta contra fuerza bruta', () => {
	let semilla = 12345;
	const azar = (n: number) => {
		semilla = (semilla * 1103515245 + 12345) % 2147483648;
		return semilla % n;
	};
	const red = () => {
		const bits = 22 + azar(11);
		const n = azar(1024);
		return `10.0.${Math.floor(n / 256)}.${n % 256}/${bits}`;
	};

	const dentro = (n: bigint, rs: { desde: bigint; hasta: bigint }[]) =>
		rs.filter((r) => r.desde <= n && n <= r.hasta).length;

	it('2.000 casos', () => {
		const base = rango('10.0.0.0')!.desde;
		for (let caso = 0; caso < 2000; caso++) {
			const negra = red();
			const blancas = Array.from({ length: 1 + azar(4) }, red);
			const rn = [rango(negra)!];
			const rb = blancas.map((b) => rango(b)!);
			const rq = restar(negra, blancas).map((c) => rango(c)!);
			for (let i = 0n; i < 1024n; i++) {
				const n = base + i;
				const esperado = dentro(n, rn) === 1 && dentro(n, rb) === 0 ? 1 : 0;
				if (dentro(n, rq) !== esperado)
					throw new Error(
						`${negra} - ${blancas.join(',')}: ${n - base} aparece ${dentro(n, rq)} veces`
					);
			}
		}
		expect(true).toBe(true);
	}, 60_000);
});
