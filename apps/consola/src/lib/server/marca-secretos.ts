/*
 * Secretos marcados: un secreto cebo que una trampa repartió y que aparece en
 * otra (u otra IP, otro día) se reconoce aquí y enlaza las dos sesiones.
 *
 * Es lo mismo que la pieza copiada en las trampas (modulos/trampas/*\/imagen/
 * fuente/marca_nodo.go), con los mismos vectores de prueba; el formato está
 * explicado allí. Puro: las claves llegan de fuera (marcaDeTrampa con la del
 * nodo), y aquí no se toca la base de datos.
 *
 * La clave de cada trampa sale de la del nodo con su id. El sensor solo la
 * pasa a su trampa (${sd.marca}); la del nodo no sale de la consola. Si el nodo
 * cambia CLAVE_SECRETOS, las marcas repartidas antes dejan de reconocerse.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const LARGO_MARCA = 32;
/* Lo más que se mira de un evento: un cuerpo lleno de hex no hace trabajar de más. */
const MAX_CANDIDATAS = 16;
const MAX_TEXTO = 64 * 1024;

const h = (k: Buffer, etiqueta: string, ...partes: Buffer[]) => {
	const m = createHmac('sha256', k).update(`sd-marca/1/${etiqueta}`);
	for (const p of partes) m.update(Buffer.from([0])).update(p);
	return m.digest();
};

/* La clave de una trampa (32 bytes) a partir de la de marcado del nodo. */
export function claveDeTrampa(claveNodo: Buffer, trampa: string): Buffer {
	return h(claveNodo, 'trampa', Buffer.from(trampa, 'utf8'));
}

/* Las 8 partes de 16 bits de una IPv6, o null. */
function grupos6(ip: string): number[] | null {
	let t = ip;
	const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(t);
	if (v4) {
		const o = v4[1].split('.').map(Number);
		t = `${t.slice(0, -v4[1].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
	}
	const [a, b, ...resto] = t.split('::');
	if (resto.length) return null;
	const izq = a ? a.split(':') : [];
	const der = b !== undefined ? (b ? b.split(':') : []) : null;
	const faltan = 8 - izq.length - (der?.length ?? 0);
	if (der === null ? faltan !== 0 : faltan < 1) return null;
	const todos = [...izq, ...Array(der === null ? 0 : faltan).fill('0'), ...(der ?? [])];
	const n = todos.map((g) => parseInt(g, 16));
	return n.length === 8 && n.every((x) => x >= 0 && x <= 0xffff) ? n : null;
}

/*
 * De quién es una marca: la IPv4 (también la que va dentro de una IPv6) tal
 * cual; de una IPv6, su /64. Igual que visitanteMarca en Go.
 */
export function visitanteMarca(ip: string): string {
	const t = ip.trim();
	const v = isIP(t);
	if (v === 4) return t;
	if (v !== 6) return t;
	const g = grupos6(t.toLowerCase());
	if (!g) return t;
	if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff)
		return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.');
	const red = [...g.slice(0, 4), 0, 0, 0, 0].map((x) => x.toString(16)).join(':');
	return `${new URL(`http://[${red}]`).hostname.slice(1, -1)}/64`;
}

/* La huella del visitante (8 hex) que lleva dentro una marca suya. */
export function huellaVisitante(k: Buffer, ip: string): string {
	return h(k, 'visitante', Buffer.from(visitanteMarca(ip), 'utf8'))
		.subarray(0, 4)
		.toString('hex');
}

/* La marca de un secreto para quien llega desde ip (para pruebas y para el banco). */
export function marcar(k: Buffer, ip: string, uso: string): string {
	const vis = Buffer.from(visitanteMarca(ip), 'utf8');
	const p = Buffer.concat([
		h(k, 'visitante', vis).subarray(0, 4),
		h(k, 'nonce', vis, Buffer.from(uso, 'utf8')).subarray(0, 4)
	]);
	const mac = h(k, 'mac', p).subarray(0, 8);
	const velo = h(k, 'velo', mac);
	const c = Buffer.from(p.map((x, i) => x ^ velo[i]));
	return Buffer.concat([c, mac]).toString('hex');
}

/* Si m es una marca de esta clave, la huella del visitante a quien se dio; si no, null. */
export function abrirMarca(k: Buffer, m: string): string | null {
	if (m.length !== LARGO_MARCA || !/^[0-9a-f]+$/.test(m)) return null;
	const b = Buffer.from(m, 'hex');
	const mac = b.subarray(8);
	const velo = h(k, 'velo', mac);
	const p = Buffer.from(b.subarray(0, 8).map((x, i) => x ^ velo[i]));
	const esperado = h(k, 'mac', p).subarray(0, 8);
	return timingSafeEqual(mac, esperado) ? p.subarray(0, 4).toString('hex') : null;
}

/*
 * Los trozos de 32 hex de un texto que podrían ser una marca: dentro de cada
 * tramo hexadecimal de 32 o más, todas sus ventanas (una trampa puede pegarla
 * a otro hex). Con tope.
 */
export function candidatas(texto: string): string[] {
	const vistas = new Set<string>();
	for (const [tramo] of texto
		.slice(0, MAX_TEXTO)
		.toLowerCase()
		.matchAll(/[0-9a-f]{32,}/g)) {
		for (let i = 0; i + LARGO_MARCA <= Math.min(tramo.length, 128); i++) {
			vistas.add(tramo.slice(i, i + LARGO_MARCA));
			if (vistas.size >= MAX_CANDIDATAS) return [...vistas];
		}
	}
	return [...vistas];
}

export type MarcaHallada = { trampa: string; visitante: string; marca: string };

/*
 * La primera marca que lleve un texto, de cualquier trampa del nodo (claves:
 * id de trampa → su clave). null si no lleva ninguna.
 */
export function buscarMarca(texto: string, claves: Map<string, Buffer>): MarcaHallada | null {
	for (const m of candidatas(texto))
		for (const [trampa, k] of claves) {
			const visitante = abrirMarca(k, m);
			if (visitante) return { trampa, visitante, marca: m };
		}
	return null;
}
