import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * El instalador del sensor remoto escribe un .env y luego le añade líneas. La
 * última línea del .env es la credencial del registro: si el fichero no acaba en
 * salto de línea, o lo añadido no empieza por uno, la variable nueva se pega a la
 * credencial y el sensor deja de poder descargar trampas (401). Pasó con
 * SENSOR_PROPAGACION en la 0.25 y la 0.26.0.
 */
const fuente = readFileSync(join(import.meta.dirname, 'sensores-remotos.ts'), 'utf8');

describe('instalador del sensor remoto: el .env', () => {
	it('se escribe acabado en salto de línea', () => {
		expect(fuente).toContain("echo '${b64(entorno + '\\n')}' | base64 -d > .env");
	});

	it('lo que se le añade empieza y acaba en salto de línea', () => {
		const anadidos = fuente.split('\n').filter((l) => />>\s*\.env\b/.test(l));
		expect(anadidos.length).toBeGreaterThan(0);
		for (const l of anadidos)
			expect(l.trim()).toMatch(/^printf '\\\\n[A-Z_]+=[^']*\\\\n' >> \.env$/);
	});
});
