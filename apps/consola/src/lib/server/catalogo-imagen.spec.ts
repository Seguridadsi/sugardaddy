/*
 * Lo que de modulos/ viaja en la imagen de la consola (modulos/catalogo-de-imagen.sh):
 * solo manifiestos y plantillas. El código de las trampas no debe poder sacarse
 * de esta imagen, y la consola tiene que ver el mismo catálogo que con la carpeta
 * entera: si algún día lee otro fichero de modulos/, esto lo avisa antes de publicar.
 */
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ db: {}, schema: {} }));

const { catalogoRespuestas, honeycosas, plantillaDeFichero } = await import('./catalogo');

const repo = join(process.cwd(), '../..');
const modulos = join(repo, 'modulos');
const guion = join(modulos, 'catalogo-de-imagen.sh');

const carpetas: string[] = [];
function temporal() {
	const c = mkdtempSync(join(tmpdir(), 'sd-catalogo-imagen-'));
	carpetas.push(c);
	return c;
}
const filtrar = (origen: string, destino: string) =>
	spawnSync('sh', [guion, origen, destino], { encoding: 'utf8' });
const ficheros = (raiz: string) =>
	(readdirSync(raiz, { recursive: true, withFileTypes: true }) as import('node:fs').Dirent[])
		.filter((e) => e.isFile())
		.map((e) => join(e.parentPath, e.name).slice(raiz.length + 1))
		.sort();

/* La carpeta de verdad, ya filtrada como en la imagen. */
const filtrado = join(temporal(), 'catalogo');
const resultado = filtrar(modulos, filtrado);

afterAll(() => carpetas.forEach((c) => rmSync(c, { recursive: true, force: true })));
afterEach(() => {
	delete process.env.SUGARDADDY_MODULOS;
});

describe('catalogo-de-imagen.sh', () => {
	it('deja solo manifiestos y plantillas', () => {
		expect(resultado.status).toBe(0);
		const raros = ficheros(filtrado).filter(
			(f) =>
				!/^(trampas|ficheros|nube)\/[^/]+\/trampa\.yaml$/.test(f) &&
				!/^respuestas\/[^/]+\/respuesta\.yaml$/.test(f) &&
				!/^ficheros\/[^/]+\/plantilla\/[^/]+\.(docx|xlsx|pptx|pdf|svg)$/.test(f)
		);
		expect(raros).toEqual([]);
	});

	it('el código que haya junto al manifiesto no pasa, se llame como se llame', () => {
		const origen = temporal();
		const escribir = (ruta: string) => {
			mkdirSync(dirname(join(origen, ruta)), { recursive: true });
			writeFileSync(join(origen, ruta), 'x');
		};
		[
			'trampas/x/trampa.yaml',
			'trampas/x/prueba.yaml',
			'trampas/x/imagen/Dockerfile',
			'trampas/x/imagen/fuente/main.go',
			'trampas/x/imagen/fuente/trampa.yaml',
			'trampas/x/licencia/licencia.go',
			'comun/licencia/licencia.go',
			'comun/x/trampa.yaml',
			'nube/n/trampa.yaml',
			'nube/n/banco.ts',
			'ficheros/f/trampa.yaml',
			'ficheros/f/plantilla/hacer-plantilla.js',
			'ficheros/f/plantilla/LEEME.md',
			'ficheros/f/plantilla/cebo.docx',
			'respuestas/r/respuesta.yaml',
			'respuestas/r/exo/servicio.mjs'
		].forEach(escribir);
		const destino = join(temporal(), 'catalogo');
		expect(filtrar(origen, destino).status).toBe(0);
		expect(ficheros(destino)).toEqual([
			'ficheros/f/plantilla/cebo.docx',
			'ficheros/f/trampa.yaml',
			'nube/n/trampa.yaml',
			'respuestas/r/respuesta.yaml',
			'trampas/x/trampa.yaml'
		]);
	});

	it('sin trampas falla: una imagen con el catálogo vacío no se construye', () => {
		const r = filtrar(temporal(), join(temporal(), 'catalogo'));
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain('ninguna trampa');
	});

	it('sin carpeta de origen falla', () => {
		expect(filtrar(join(temporal(), 'no-esta'), join(temporal(), 'catalogo')).status).not.toBe(0);
	});
});

describe('la consola con el catálogo de la imagen', () => {
	function con<T>(raiz: string, leer: () => T): T {
		process.env.SUGARDADDY_MODULOS = raiz;
		return leer();
	}

	it('ve las mismas trampas que con la carpeta entera', () => {
		const entera = con(modulos, honeycosas);
		expect(entera.length).toBeGreaterThan(0);
		expect(con(filtrado, honeycosas)).toEqual(entera);
	});

	/* La edición community no trae respuestas ni ficheros cebo. */
	const hay = (familia: string) => existsSync(join(modulos, familia));

	it.skipIf(!hay('respuestas'))('ve las mismas respuestas que con la carpeta entera', () => {
		expect(con(filtrado, catalogoRespuestas)).toEqual(con(modulos, catalogoRespuestas));
	});

	it.skipIf(!hay('ficheros'))('puede acuñar todos los ficheros cebo', () => {
		const deFichero = con(modulos, honeycosas).filter(
			(h) => (h.siembra as { clase?: string }).clase === 'fichero'
		);
		expect(deFichero.length).toBeGreaterThan(0);
		for (const h of deFichero) {
			const original = con(modulos, () => plantillaDeFichero(h));
			expect(original, h.id).not.toBeNull();
			expect(
				con(filtrado, () => plantillaDeFichero(h)),
				h.id
			).toEqual(original);
		}
	});
});

describe('lo que se construye', () => {
	const etapaFinal = (dockerfile: string) => dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
	const copiaModulos = /^COPY\s+(--\S+\s+)*modulos\b/m;

	it('la imagen final de la consola no copia modulos/ entero', () => {
		const final = etapaFinal(readFileSync(join(repo, 'apps/consola/Dockerfile'), 'utf8'));
		expect(final).not.toMatch(copiaModulos);
		expect(final).toMatch(/^COPY --from=catalogo \/catalogo \/app\/modulos$/m);
	});

	it('tampoco lleva los mapas de fuentes, que tienen dentro el código original', () => {
		const dockerfile = readFileSync(join(repo, 'apps/consola/Dockerfile'), 'utf8');
		expect(dockerfile).toContain(`find build -name '*.map' -delete`);
	});

	it('la construcción local no vuelve a meterlo encima', () => {
		const local = readFileSync(join(repo, 'despliegue/nodo/construir-imagenes-local.sh'), 'utf8');
		expect(local).not.toMatch(copiaModulos);
	});
});
