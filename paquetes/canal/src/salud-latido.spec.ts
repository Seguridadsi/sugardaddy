/* La salud de las máquinas en el latido (docs/diseno/salud.md): lo que el panel acepta. */
import { describe, expect, it } from 'vitest';
import { leerSaludLatido } from './index';

describe('leerSaludLatido', () => {
	const buena = {
		sensores: 2,
		disco: 0.876543,
		memoria: null,
		cpu: 0.2,
		trampasParadas: 1,
		avisos: 3
	};
	it('acepta la buena y redondea las fracciones', () => {
		expect(leerSaludLatido(buena)).toEqual({ ...buena, disco: 0.877 });
	});
	it('ignora la mal formada', () => {
		expect(leerSaludLatido(null)).toBeUndefined();
		expect(leerSaludLatido({ ...buena, disco: 1.5 })).toBeUndefined();
		expect(leerSaludLatido({ ...buena, cpu: '0.2' })).toBeUndefined();
		expect(leerSaludLatido({ ...buena, avisos: -1 })).toBeUndefined();
		expect(leerSaludLatido({ ...buena, sensores: 1.5 })).toBeUndefined();
	});
});
