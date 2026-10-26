/*
 * El mapa de cada trampa a su tipo de servicio y los pictogramas que lo
 * pintan: que todas las trampas del catálogo tengan tipo, que cada tipo tenga
 * su dibujo, y que lo que se sirve sin sesión sea un SVG limpio, sin nada que
 * se pueda ejecutar, igual en la consola y en el panel.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TIPOS_DE_SERVICIO, modulosConTipo, tipoDeServicio } from './pictogramas';

const repo = join(import.meta.dirname, '../..');
const pictogramas = join(repo, 'marca/pictogramas');
/* Los módulos de las familias: trampas de contenedor, ficheros cebo y nube. */
const modulos = ['trampas', 'ficheros', 'nube'].flatMap((familia) =>
	readdirSync(join(repo, 'modulos', familia)).filter((id) =>
		existsSync(join(repo, 'modulos', familia, id, 'trampa.yaml'))
	)
);
const svgs = (carpeta: string) =>
	readdirSync(carpeta)
		.filter((f) => f.endsWith('.svg'))
		.sort();

describe('el tipo de cada trampa', () => {
	it('todas las trampas del catálogo tienen tipo', () => {
		expect(modulos.length).toBeGreaterThan(30);
		expect(
			modulos.filter((id) => tipoDeServicio(id) === null),
			'sin tipo: añádelas a TIPO_DE_TRAMPA'
		).toEqual([]);
	});

	it('no hay tipo para un módulo que no está en el catálogo', () => {
		expect(modulosConTipo().filter((id) => !modulos.includes(id))).toEqual([]);
	});

	it('una trampa desconocida no tiene tipo: lleva la abeja', () => {
		for (const id of ['desconocida', 'MySQL', ' mysql', '', null, undefined])
			expect(tipoDeServicio(id), String(id)).toBeNull();
		/* Lo que trae cualquier objeto de JavaScript no cuenta como tipo. */
		for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty'])
			expect(tipoDeServicio(id), id).toBeNull();
	});

	it('algunos, como se dibujan', () => {
		expect(tipoDeServicio('mysql')).toBe('bases-de-datos');
		expect(tipoDeServicio('cowrie')).toBe('terminal');
		expect(tipoDeServicio('correo')).toBe('correo-electronico');
		/* Su pictograma; en la consola, delante va el gopher de go-pot (logos.ts). */
		expect(tipoDeServicio('retencion-web')).toBe('retencion');
		expect(tipoDeServicio('retencion-ssh')).toBe('retencion');
	});

	it('ningún tipo se llama como un módulo: la landing dice el tipo y nunca el módulo', () => {
		for (const tipo of TIPOS_DE_SERVICIO) expect(modulos, tipo).not.toContain(tipo);
	});
});

/*
 * Un SVG abierto directamente en el navegador ejecuta lo que lleve. Lo que
 * escribe marca/preparar_pictogramas.py es una línea de etiquetas de dibujo y
 * nada más; aquí se lee etiqueta a etiqueta y cualquier otra cosa (texto,
 * comentarios, CDATA, entidades, scripts, enlaces, estilos) no pasa.
 */
const ELEMENTOS = new Set([
	'svg',
	'g',
	'path',
	'rect',
	'circle',
	'ellipse',
	'line',
	'polyline',
	'polygon'
]);
const ATRIBUTOS = new Set(
	'd x y width height rx ry cx cy r x1 y1 x2 y2 points transform fill stroke stroke-width stroke-linecap stroke-linejoin fill-opacity stroke-opacity opacity'.split(
		' '
	)
);
const COLORES = new Set(['none', '#F5B800', '#111']);
const ETIQUETA = /<(\/?)([a-z]+)((?: [a-zA-Z-]+="[^"]*")*)(\/?)>/y;
const ATRIBUTO = / ([a-zA-Z-]+)="([^"]*)"/g;

function problemas(svg: string): string[] {
	const mal: string[] = [];
	const abiertas: string[] = [];
	let i = 0;
	const texto = svg.replace(/\n$/, '');
	while (i < texto.length) {
		ETIQUETA.lastIndex = i;
		const m = ETIQUETA.exec(texto);
		if (!m) return [...mal, `no es una etiqueta de dibujo: ${texto.slice(i, i + 40)}`];
		const [todo, cierre, nombre, atributos, sola] = m;
		i += todo.length;
		if (!ELEMENTOS.has(nombre)) mal.push(`<${nombre}>`);
		if (nombre === 'svg' && (abiertas.length > 0 || i !== todo.length) && !cierre)
			mal.push('<svg> dentro de otro');
		if (cierre) {
			if (abiertas.pop() !== nombre) mal.push(`</${nombre}> sin abrir`);
			continue;
		}
		if (!sola) abiertas.push(nombre);
		for (const [, clave, valor] of atributos.matchAll(ATRIBUTO)) {
			if (nombre === 'svg' && clave === 'xmlns') {
				if (valor !== 'http://www.w3.org/2000/svg') mal.push(`xmlns="${valor}"`);
				continue;
			}
			if (nombre === 'svg' && clave === 'viewBox') {
				if (valor !== '0 0 48 48') mal.push(`viewBox="${valor}"`);
				continue;
			}
			if (!ATRIBUTOS.has(clave)) mal.push(`${clave} en <${nombre}>`);
			if (!/^[-+0-9A-Za-z.,#() ]*$/.test(valor) || /url\s*\(/i.test(valor))
				mal.push(`${clave}="${valor}"`);
			if ((clave === 'fill' || clave === 'stroke') && !COLORES.has(valor))
				mal.push(`${clave}="${valor}" no es de la marca`);
		}
		if (abiertas.length === 0 && i !== texto.length) mal.push('algo después de </svg>');
	}
	if (abiertas.length > 0) mal.push(`sin cerrar: ${abiertas.join(', ')}`);
	if (!texto.startsWith('<svg ')) mal.push('no empieza por <svg>');
	return mal;
}

describe('los pictogramas', () => {
	it('cada tipo tiene su dibujo y su pictograma, y no sobra ninguno', () => {
		const nombres = [...TIPOS_DE_SERVICIO].map((t) => `${t}.svg`).sort();
		expect(svgs(pictogramas)).toEqual(nombres);
		expect(svgs(join(pictogramas, 'fuente')).filter((f) => !f.startsWith('_'))).toEqual(nombres);
	});

	it('son SVG limpios: solo dibujo, con los colores de la marca y pocos bytes', () => {
		for (const f of svgs(pictogramas)) {
			const svg = readFileSync(join(pictogramas, f), 'utf8');
			expect(problemas(svg), f).toEqual([]);
			expect(Buffer.byteLength(svg), f).toBeLessThanOrEqual(2048);
		}
	});

	it('la comprobación no deja pasar nada que se pueda ejecutar ni cargar de fuera', () => {
		const bueno = readFileSync(join(pictogramas, 'web.svg'), 'utf8');
		expect(problemas(bueno)).toEqual([]);
		const cola = '</svg>';
		const con = (trozo: string) => bueno.replace(cola, `${trozo}${cola}`);
		for (const malo of [
			con('<script>alert(1)</script>'),
			con('<foreignObject/>'),
			con('<image href="https://otro.test/x.png"/>'),
			con('<use href="#x"/>'),
			con('<style>*{}</style>'),
			con('<!-- nota -->'),
			con('<![CDATA[x]]>'),
			con('hola'),
			con('<path d="M0 0" onload="alert(1)"/>'),
			con('<path d="M0 0" style="fill:red"/>'),
			con('<path d="M0 0" fill="url(#degradado)"/>'),
			con('<path d="M0 0" fill="red"/>'),
			con('<path d="M0 0" fill="&#106;"/>'),
			con('<a href="javascript:alert(1)"><path d="M0 0"/></a>'),
			con('<svg viewBox="0 0 48 48"/>'),
			'<?xml version="1.0"?>' + bueno,
			'<!DOCTYPE svg [<!ENTITY x "y">]>' + bueno,
			bueno.replace('<svg ', '<svg onload="alert(1)" '),
			bueno + '<script>alert(1)</script>'
		])
			expect(problemas(malo), malo.slice(-80)).not.toEqual([]);
	});

	it('la consola y el panel sirven exactamente los de marca/ (lanza marca/preparar.sh)', () => {
		for (const app of ['consola', 'central']) {
			const copia = join(repo, 'apps', app, 'static/pictogramas');
			expect(svgs(copia), app).toEqual(svgs(pictogramas));
			expect(
				readdirSync(copia).filter((f) => !f.endsWith('.svg')),
				app
			).toEqual([]);
			for (const f of svgs(pictogramas))
				expect(readFileSync(join(copia, f), 'utf8'), `${app}/${f}`).toBe(
					readFileSync(join(pictogramas, f), 'utf8')
				);
		}
	});
});
