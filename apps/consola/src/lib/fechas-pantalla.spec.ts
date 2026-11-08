import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const fuentes = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((f) => {
		const ruta = join(dir, f.name);
		if (f.isDirectory()) return fuentes(ruta);
		return /\.(svelte|ts)$/.test(f.name) && !f.name.endsWith('.spec.ts') ? [ruta] : [];
	});

/*
 * Una fecha de pantalla que se formatee a mano sale en la hora del servidor o del
 * navegador, no en la que ha elegido quien mira, y nadie lo nota hasta que alguien
 * en otra zona lo lee mal. Los números (`n.toLocaleString`) sí pueden ir sueltos.
 */
const A_MANO = [
	/Intl\.DateTimeFormat/,
	/\.toLocale(Date|Time)String\(/,
	/new Date\([^;]{0,120}?\)\s*\.toLocaleString\(/
];

describe('las fechas de pantalla', () => {
	it('solo se formatean con $lib/fechas-pantalla o $lib/fechas', () => {
		const malas = ['src/routes', 'src/lib/components']
			.flatMap(fuentes)
			.filter((f) => A_MANO.some((re) => re.test(readFileSync(f, 'utf8'))));
		expect(malas).toEqual([]);
	});

	it('la comprobación caza lo que tiene que cazar', () => {
		for (const trozo of [
			"new Intl.DateTimeFormat('en-GB')",
			"x.toLocaleTimeString('en-GB')",
			"new Date(\n\tdata.hasta\n).toLocaleString('en-GB', {"
		])
			expect(A_MANO.some((re) => re.test(trozo))).toBe(true);
		expect(A_MANO.some((re) => re.test("const n = (x) => x.toLocaleString('en-GB');"))).toBe(false);
	});
});
