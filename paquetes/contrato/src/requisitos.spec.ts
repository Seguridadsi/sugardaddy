import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
	OPERADORES,
	efectoRequisito,
	evaluarRequisito,
	validarHoneycosa,
	type EfectoRequisito,
	type Hechos,
	type Requisito,
	type ResultadoRequisito
} from './index.ts';

/*
 * Requisitos (docs/diseno/modulo-despliegue.md §3, paso 2): el comparador
 * contra los vectores compartidos con Go (sensor/internal/requisitos lee el
 * mismo fichero) y lo que los vectores no pueden decir.
 */

const raiz = join(import.meta.dirname, '../../..');
const fichero = join(raiz, 'paquetes/contrato/vectores/requisitos.jsonl');
const smb = readFileSync(join(raiz, 'paquetes/contrato/src/ejemplos/smb.v2.yaml'), 'utf8');

type Vector = {
	nombre: string;
	hechos: Hechos;
	requisito: Requisito;
	resultado: ResultadoRequisito;
	efecto: EfectoRequisito;
	/* El requisito no lo admitiría validarHoneycosa, pero el comparador no puede lanzar. */
	fueraDelLenguaje?: true;
};

const lineas = readFileSync(fichero, 'utf8').split('\n');
const vectores: Vector[] = lineas.filter((l) => l !== '').map((l) => JSON.parse(l));

function congelar<T>(x: T): T {
	if (typeof x === 'object' && x !== null) {
		Object.values(x).forEach(congelar);
		Object.freeze(x);
	}
	return x;
}

const operador = (r: Requisito) => OPERADORES.filter((o) => Object.hasOwn(r, o));

describe('vectores compartidos con Go', () => {
	it.each(vectores.map((v) => [v.nombre, v] as const))('%s', (_, v) => {
		const { hechos, requisito } = congelar(structuredClone(v));
		expect(evaluarRequisito(requisito, hechos)).toBe(v.resultado);
		expect(efectoRequisito(requisito, v.resultado)).toBe(v.efecto);
	});

	it('el fichero es una línea JSON por caso, sin líneas vacías y acabado en salto de línea', () => {
		expect(lineas.at(-1)).toBe('');
		expect(lineas.slice(0, -1).every((l) => l.startsWith('{') && l.endsWith('}'))).toBe(true);
	});

	it('cada caso tiene un nombre distinto y solo los campos que leen los dos lados', () => {
		expect(new Set(vectores.map((v) => v.nombre)).size).toBe(vectores.length);
		const campos = ['nombre', 'hechos', 'requisito', 'resultado', 'efecto', 'fueraDelLenguaje'];
		for (const v of vectores) {
			expect(
				Object.keys(v).every((k) => campos.includes(k)),
				v.nombre
			).toBe(true);
			expect(['cumple', 'no-cumple', 'sin-dato']).toContain(v.resultado);
			expect(['nada', 'avisa', 'descarta']).toContain(v.efecto);
		}
	});

	it('hay al menos 30 casos y cada operador sale con todos sus resultados', () => {
		expect(vectores.length).toBeGreaterThanOrEqual(30);
		const dentro = vectores.filter((v) => !v.fueraDelLenguaje);
		const vistos = (op: string) =>
			new Set(dentro.filter((v) => operador(v.requisito)[0] === op).map((v) => v.resultado));
		for (const op of ['igual', 'en', 'contiene', 'minimo'])
			expect([...vistos(op)].sort(), op).toEqual(['cumple', 'no-cumple', 'sin-dato']);
		/* «presente» nunca da sin dato (§3.1). */
		expect([...vistos('presente')].sort()).toEqual(['cumple', 'no-cumple']);
		expect(
			vectores.some((v) => operador(v.requisito)[0] === 'presente' && v.resultado === 'sin-dato')
		).toBe(false);
	});

	it('salen todas las filas de la tabla de §3.2', () => {
		const filas = new Set(
			vectores
				.filter((v) => !v.fueraDelLenguaje)
				.map((v) => `${v.requisito.nivel ?? 'exige'} ${v.resultado} ${v.requisito.siFalta ?? '-'}`)
		);
		for (const fila of [
			'exige cumple -',
			'exige no-cumple -',
			'exige sin-dato -',
			'exige sin-dato descarta',
			'exige sin-dato avisa',
			'exige sin-dato ignora',
			'avisa cumple -',
			'avisa no-cumple -',
			'avisa sin-dato -',
			'avisa sin-dato avisa'
		])
			expect(filas, fila).toContain(fila);
	});

	/*
	 * Los vectores no se inventan el lenguaje: cada requisito marcado como dentro
	 * lo admite validarHoneycosa en una vía de verdad, y cada uno marcado fuera
	 * lo rechaza.
	 */
	it.each(vectores.map((v) => [v.nombre, v] as const))(
		'validarHoneycosa está de acuerdo con la marca: %s',
		(_, v) => {
			const m = parse(smb);
			m.vias[0].requisitos = [v.requisito];
			const r = validarHoneycosa(m);
			expect(r.ok, r.ok ? '' : r.errores.join('\n')).toBe(!v.fueraDelLenguaje);
		}
	);
});

describe('comparador', () => {
	const hechos = (valor: unknown) => ({ 'x.y': { valor } }) as Hechos;
	const r = (op: string, x: unknown) => ({ hecho: 'x.y', motivo: 'm', [op]: x }) as Requisito;

	it('compara versiones parte a parte como números', () => {
		expect(evaluarRequisito(r('minimo', '0.13.9'), hechos('0.13.10'))).toBe('cumple');
		expect(evaluarRequisito(r('minimo', '10.0.14393'), hechos('10.0.17763'))).toBe('cumple');
		expect(evaluarRequisito(r('minimo', '0.13.10'), hechos('0.13.9'))).toBe('no-cumple');
	});

	/* Valores de cualquier tipo, en el hecho y en el operador: nunca lanza. */
	const raros: unknown[] = [
		undefined,
		null,
		true,
		false,
		0,
		-1,
		0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		'',
		'5.1',
		'x',
		'1.2.3-rc',
		'.1',
		'1..2',
		'9'.repeat(400),
		[],
		[null],
		[[]],
		['a', 1, true, null, {}],
		{},
		{ valor: 1 },
		Object.create(null),
		() => 1,
		Symbol('s'),
		10n
	];

	it.each([...OPERADORES])('%s no lanza con ningún tipo y da cumple o no-cumple con dato', (op) => {
		for (const valor of raros)
			for (const x of raros) {
				const res = evaluarRequisito(r(op, x), hechos(valor));
				const hay = valor !== undefined && valor !== null;
				if (op === 'presente' || hay) expect(['cumple', 'no-cumple']).toContain(res);
				else expect(res).toBe('sin-dato');
			}
	});

	it('no lanza con hechos o requisitos que no tienen la forma', () => {
		const malos = [
			{},
			{ 'x.y': null },
			{ 'x.y': 'rootful' },
			{ 'x.y': [] },
			JSON.parse('{"__proto__": {"valor": "rootful"}}')
		] as unknown as Hechos[];
		for (const h of malos) {
			expect(evaluarRequisito(r('igual', 'rootful'), h)).toBe('sin-dato');
			expect(evaluarRequisito(r('presente', false), h)).toBe('cumple');
		}
		expect(evaluarRequisito({ hecho: 7, igual: 1, motivo: 'm' } as unknown as Requisito, {})).toBe(
			'sin-dato'
		);
		expect(
			evaluarRequisito({ hecho: '__proto__', presente: true, motivo: 'm' } as Requisito, {})
		).toBe('no-cumple');
	});

	it('no busca el hecho ni el operador en el prototipo', () => {
		const heredado = Object.create({ 'x.y': { valor: 'rootful' } }) as Hechos;
		expect(evaluarRequisito(r('igual', 'rootful'), heredado)).toBe('sin-dato');
		const req = Object.create({ igual: 'rootful' });
		Object.assign(req, { hecho: 'x.y', motivo: 'm' });
		expect(evaluarRequisito(req, hechos('rootful'))).toBe('no-cumple');
	});

	it('el mismo requisito con los mismos hechos da siempre lo mismo', () => {
		for (const v of vectores)
			expect(evaluarRequisito(v.requisito, v.hechos)).toBe(
				evaluarRequisito(structuredClone(v.requisito), structuredClone(v.hechos))
			);
	});
});
