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

	/*
	 * Con un registro sin contraseña (el panel en desarrollo da usuario y token vacíos)
	 * el instalador se paraba en «download the images»: docker login con usuario vacío
	 * falla. Lo vio el banco e2e del sensor remoto (herramientas/e2e/sensor-remoto.sh).
	 */
	it('solo entra en el registro si hay credencial, como el instalador del nodo', () => {
		const lineas = fuente.split('\n');
		const login = lineas.findIndex((l) => /\| docker login /.test(l));
		expect(login).toBeGreaterThan(0);
		expect(lineas[login - 1].trim()).toBe("if grep -q '^REGISTRO_TOKEN=.' .env; then");
		expect(lineas[login + 1].trim()).toBe('fi');
		const nodo = readFileSync(
			join(import.meta.dirname, '../../../../../despliegue/nodo/instalar.sh'),
			'utf8'
		);
		expect(nodo).toContain("if grep -q '^REGISTRO_TOKEN=.' .env; then");
	});

	it('lo que se le añade empieza y acaba en salto de línea', () => {
		const anadidos = fuente.split('\n').filter((l) => />>\s*\.env\b/.test(l));
		expect(anadidos.length).toBeGreaterThan(0);
		for (const l of anadidos)
			expect(l.trim()).toMatch(/^printf '\\\\n[A-Z_]+=[^']*\\\\n' >> \.env$/);
	});
});
