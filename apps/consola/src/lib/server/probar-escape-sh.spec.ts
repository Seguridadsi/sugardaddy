/*
 * herramientas/probar-escape-linux.sh: con CORTAFUEGOS_IMAGEN pone la regla de SEN-5 como
 * el actualizador, y si el auxiliar no contesta «aplicada» se para con error (antes seguía
 * y la prueba de la pasarela no probaba nada). Con un docker de mentira.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const GUION = new URL('../../../../../herramientas/probar-escape-linux.sh', import.meta.url)
	.pathname;

function correr(respuesta: string) {
	const d = mkdtempSync(join(tmpdir(), 'sd-escape-'));
	try {
		writeFileSync(join(d, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 });
		/* El auxiliar contesta lo que toque; construir imágenes falla, para acabar ahí. */
		writeFileSync(
			join(d, 'docker'),
			`#!/bin/sh
case "$*" in
*cortafuegos-trampas*) echo 'iptables v1.8'; echo '${respuesta}' ;;
image*|build*) exit 3 ;;
esac
exit 0
`,
			{ mode: 0o755 }
		);
		writeFileSync(join(d, 'trampa.json'), '{"imagen":"sd-prueba/escape:local"}\n');
		return spawnSync('/bin/sh', [GUION, join(d, 'informes')], {
			env: {
				PATH: `${d}:/usr/bin:/bin`,
				CORTAFUEGOS_IMAGEN: 'actualizador@sha256:1',
				MANIFIESTO: join(d, 'trampa.json'),
				NODO_DIR: join(d, 'sin-nodo')
			},
			encoding: 'utf8'
		});
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(GUION))('probar-escape-linux.sh y la regla de SEN-5', () => {
	it('se para con error si el auxiliar no dice «aplicada»', () => {
		const r = correr('{"estado":"error","detalle":"iptables: not found"}');
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('did not answer «aplicada»');
		expect(r.stdout).not.toContain('==> Images');
	});

	it('sigue si la ha puesto', () => {
		const r = correr('{"estado":"aplicada","detalle":"SD-TRAMPAS"}');
		expect(r.stdout).toContain('==> Images');
		expect(r.stderr).not.toContain('did not answer');
	});
});
