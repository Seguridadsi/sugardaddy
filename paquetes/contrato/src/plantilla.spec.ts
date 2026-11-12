import { describe, expect, it } from 'vitest';
import {
	MAX_PIEZAS,
	claveLibre,
	esPropia,
	leerPlantilla,
	nombreLibre,
	validarPlantilla
} from './plantilla.ts';

const buena = {
	id: 'oficina',
	nombre: 'Branch office',
	descripcion: 'A file server and a remote desktop host.',
	piezas: [
		{ clave: 'smb', modulo: 'smb', nombre: 'File server' },
		{ clave: 'smb-2', modulo: 'smb', nombre: 'Archive', parametros: { puertoSmb: 4450 } }
	]
};

describe('el formato de una plantilla', () => {
	it('acepta una buena y la devuelve solo con los campos del formato', () => {
		const r = validarPlantilla({ ...buena, sobra: 1, piezas: [{ ...buena.piezas[0], sobra: 2 }] });
		expect(r).toEqual({
			ok: true,
			valor: {
				id: 'oficina',
				nombre: 'Branch office',
				descripcion: 'A file server and a remote desktop host.',
				piezas: [{ clave: 'smb', modulo: 'smb', nombre: 'File server' }]
			}
		});
	});

	it('guarda los ajustes que fija una pieza', () => {
		const r = validarPlantilla(buena);
		expect(r.ok && r.valor.piezas[1].parametros).toEqual({ puertoSmb: 4450 });
	});

	it.each([
		['sin piezas', { ...buena, piezas: [] }, 'at least one honeypot'],
		['sin nombre', { ...buena, nombre: ' ' }, 'Name: required'],
		['con un id con mayúsculas', { ...buena, id: 'Oficina' }, 'Identifier'],
		[
			'con dos piezas con la misma clave',
			{ ...buena, piezas: [buena.piezas[0], buena.piezas[0]] },
			'repeated key'
		],
		[
			'con una pieza sin módulo',
			{ ...buena, piezas: [{ clave: 'a', nombre: 'A' }] },
			'choose a module'
		],
		[
			'con un ajuste que no es un valor suelto',
			{ ...buena, piezas: [{ ...buena.piezas[0], parametros: { lista: ['a'] } }] },
			'setting "lista"'
		],
		[
			'con demasiadas piezas',
			{
				...buena,
				piezas: Array.from({ length: MAX_PIEZAS + 1 }, (_, i) => ({
					clave: `p${i}`,
					modulo: 'smb',
					nombre: `P ${i}`
				}))
			},
			'per template at most'
		]
	])('rechaza una %s', (_caso, plantilla, texto) => {
		const r = validarPlantilla(plantilla);
		expect(r.ok).toBe(false);
		expect(!r.ok && r.errores.join(' | ')).toContain(texto);
	});

	it('lee el YAML del catálogo y exige la versión 1', () => {
		const yaml = `version: 1\nid: oficina\nnombre: Branch office\ndescripcion: Two decoys.\npiezas:\n  - { clave: smb, modulo: smb, nombre: File server }\n`;
		expect(leerPlantilla(yaml).ok).toBe(true);
		expect(leerPlantilla(yaml.replace('version: 1', 'version: 2')).ok).toBe(false);
		expect(leerPlantilla('{').ok).toBe(false);
	});

	it('propone nombres y claves que no chocan', () => {
		const usados = new Set(['File server', 'File server 2']);
		expect(nombreLibre('File server', (n) => usados.has(n))).toBe('File server 3');
		expect(nombreLibre('Archive', (n) => usados.has(n))).toBe('Archive');
		expect(claveLibre('smb', ['smb', 'smb-2'])).toBe('smb-3');
		expect(esPropia('custom-oficina')).toBe(true);
		expect(esPropia('linux-servers')).toBe(false);
	});
});

describe('plantilla: una dirección por equipo', () => {
	const base = {
		id: 'varias',
		nombre: 'Varias',
		descripcion: 'Una máquina con varias direcciones.',
		piezas: [
			{ clave: 'a', modulo: 'scada', nombre: 'A', equipo: 'automata' },
			{ clave: 'b', modulo: 'plc-s7', nombre: 'B', equipo: 'automata' },
			{ clave: 'c', modulo: 'cowrie', nombre: 'C' }
		]
	};

	it('conserva unaPorDireccion y el equipo de cada pieza', () => {
		const r = validarPlantilla({ ...base, unaPorDireccion: true });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.valor.unaPorDireccion).toBe(true);
		expect(r.valor.piezas.map((p) => p.equipo)).toEqual(['automata', 'automata', undefined]);
	});

	it('sin el campo, la plantilla no lo lleva', () => {
		const r = validarPlantilla(base);
		expect(r.ok && 'unaPorDireccion' in r.valor).toBe(false);
	});

	it('un equipo que no es una clave no vale', () => {
		const r = validarPlantilla({
			...base,
			piezas: [{ clave: 'a', modulo: 'scada', nombre: 'A', equipo: 'Con Espacios' }]
		});
		expect(r.ok).toBe(false);
	});
});
