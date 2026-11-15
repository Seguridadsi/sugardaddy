import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	firmanteDePrivada,
	firmarRaiz,
	generarClaves,
	leerRaizDeConfianza,
	verificarRaiz,
	type Raiz
} from './index.ts';

const llaveA = generarClaves();
const llaveB = generarClaves();
const llaveC = generarClaves();
const trabajo = generarClaves();
const f = (k: { privada: string; publica: string }) => firmanteDePrivada(k.privada, k.publica);

const AHORA = Date.parse('2026-11-14T00:00:00Z');
const raiz = (extra: Partial<Raiz> = {}): Raiz => ({
	tipo: 'raiz',
	version: 1,
	emitida: '2026-11-14T00:00:00Z',
	caduca: '2027-11-14T00:00:00Z',
	raiz: { claves: [llaveA.publica, llaveB.publica], umbral: 2 },
	claves: `cloud:${trabajo.publica}`,
	marcas: trabajo.publica,
	...extra
});
const confianza = leerRaizDeConfianza(`2:${llaveA.publica},${llaveB.publica}`)!;

describe('raíz fuera de línea (formato TUF, sin usar aún)', () => {
	it('vale con las dos llaves y dice las claves de trabajo', () => {
		const v = verificarRaiz(confianza, firmarRaiz(raiz(), [f(llaveA), f(llaveB)]), AHORA);
		expect(v.ok && v.raiz.claves).toBe(`cloud:${trabajo.publica}`);
		expect(v.ok && v.confianza.version).toBe(1);
	});

	it('con una sola llave, la misma dos veces o una ajena, no vale', () => {
		expect(verificarRaiz(confianza, firmarRaiz(raiz(), [f(llaveA)]), AHORA).ok).toBe(false);
		const dosVeces = firmarRaiz(raiz(), [f(llaveA)]);
		dosVeces.firmas.push(dosVeces.firmas[0]);
		expect(verificarRaiz(confianza, dosVeces, AHORA).ok).toBe(false);
		expect(verificarRaiz(confianza, firmarRaiz(raiz(), [f(llaveA), f(llaveC)]), AHORA).ok).toBe(
			false
		);
	});

	it('caducada, tocada o más vieja que la conocida, no vale', () => {
		const firmada = firmarRaiz(raiz(), [f(llaveA), f(llaveB)]);
		expect(verificarRaiz(confianza, firmada, Date.parse('2028-01-01T00:00:00Z'))).toMatchObject({
			ok: false,
			motivo: 'the root has expired'
		});
		const tocada = { ...firmada, raiz: firmada.raiz.replace('cloud:', 'licencias:') };
		expect(verificarRaiz(confianza, tocada, AHORA).ok).toBe(false);
		expect(verificarRaiz({ ...confianza, version: 2 }, firmada, AHORA).ok).toBe(false);
	});

	it('rotar la raíz pide las llaves viejas y las nuevas', () => {
		const nueva = raiz({
			version: 2,
			raiz: { claves: [llaveB.publica, llaveC.publica], umbral: 2 }
		});
		expect(verificarRaiz(confianza, firmarRaiz(nueva, [f(llaveA), f(llaveB)]), AHORA).ok).toBe(
			false
		);
		const v = verificarRaiz(confianza, firmarRaiz(nueva, [f(llaveA), f(llaveB), f(llaveC)]), AHORA);
		expect(v.ok && v.confianza).toEqual({
			claves: [llaveB.publica, llaveC.publica],
			umbral: 2,
			version: 2
		});
	});

	it('PUBLICACION_RAIZ con un umbral que no cuadra no se lee', () => {
		expect(leerRaizDeConfianza(`3:${llaveA.publica},${llaveB.publica}`)).toBeNull();
		expect(leerRaizDeConfianza(`0:${llaveA.publica}`)).toBeNull();
		expect(leerRaizDeConfianza('')).toBeNull();
	});

	it('el vector común con Go (vectores/raiz.json)', () => {
		const v = JSON.parse(readFileSync(new URL('./vectores/raiz.json', import.meta.url), 'utf8'));
		const c = leerRaizDeConfianza(v.confianza)!;
		const r = verificarRaiz(c, v.firmada, Date.parse(v.ahora));
		expect(r.ok && r.raiz.claves).toBe(v.claves);
		expect(verificarRaiz(c, v.firmada, Date.parse('2030-01-01T00:00:00Z')).ok).toBe(false);
	});
});
