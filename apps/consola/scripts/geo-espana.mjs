/*
 * La tabla de IP españolas por comunidad autónoma, para el mapa de España del
 * Resumen. Se construye al hacer la imagen (Dockerfile, etapa geo) desde DB-IP
 * City Lite (CC BY 4.0): lee por la entrada estándar las filas españolas del
 * CSV y escribe espana.bin, pequeña (los rangos seguidos de la misma comunidad
 * se juntan). Sin dependencias: en esa etapa solo hay node.
 *
 *   gunzip -c dbip-city-lite-AAAA-MM.csv.gz | awk -F, '$4=="ES"' | node geo-espana.mjs espana.bin
 *
 * Formato (lo lee src/lib/server/geo.ts): «SDES1», nº de rangos IPv4 y nº de
 * rangos IPv6 (u32 big endian); luego cada rango IPv4 (inicio u32, fin u32,
 * comunidad u8) y cada rango IPv6 (inicio 16 bytes, fin 16 bytes, comunidad
 * u8). La comunidad es su posición en COMUNIDADES, que geo.ts repite igual.
 */
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

/* Los códigos de ISO 3166-2:ES de las comunidades y ciudades autónomas. */
const COMUNIDADES = [
	'AN',
	'AR',
	'AS',
	'CB',
	'CE',
	'CL',
	'CM',
	'CN',
	'CT',
	'EX',
	'GA',
	'IB',
	'MC',
	'MD',
	'ML',
	'NC',
	'PV',
	'RI',
	'VC'
];
/* Cómo las nombra DB-IP (en inglés). */
const DBIP = {
	Andalusia: 'AN',
	Aragon: 'AR',
	Asturias: 'AS',
	Cantabria: 'CB',
	Ceuta: 'CE',
	'Castille and León': 'CL',
	'Castille-La Mancha': 'CM',
	'Canary Islands': 'CN',
	Catalonia: 'CT',
	Extremadura: 'EX',
	Galicia: 'GA',
	'Balearic Islands': 'IB',
	Murcia: 'MC',
	Madrid: 'MD',
	Melilla: 'ML',
	Navarre: 'NC',
	'Basque Country': 'PV',
	'La Rioja': 'RI',
	Valencia: 'VC'
};

/* Los campos del CSV de DB-IP: solo el nombre de ciudad o región va entre comillas. */
function campos(linea) {
	const r = [];
	let actual = '';
	let comillas = false;
	for (const c of linea) {
		if (c === '"') comillas = !comillas;
		else if (c === ',' && !comillas) {
			r.push(actual);
			actual = '';
		} else actual += c;
	}
	r.push(actual);
	return r;
}

function ipv4(t) {
	const p = t.split('.').map(Number);
	return p.length === 4 && p.every((n) => n >= 0 && n <= 255)
		? ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
		: null;
}

function ipv6(t) {
	const [a, b] = t.split('::');
	const izq = a ? a.split(':') : [];
	const der = b !== undefined && b ? b.split(':') : [];
	const grupos =
		b === undefined ? izq : [...izq, ...Array(8 - izq.length - der.length).fill('0'), ...der];
	if (grupos.length !== 8) return null;
	const buf = Buffer.alloc(16);
	grupos.forEach((g, i) => buf.writeUInt16BE(parseInt(g || '0', 16), i * 2));
	return buf;
}

const v4 = [];
const v6 = [];
const sinComunidad = new Map();
for await (const linea of createInterface({ input: process.stdin })) {
	const [ini, fin, , pais, region] = campos(linea);
	if (pais !== 'ES') continue;
	const c = COMUNIDADES.indexOf(DBIP[region]);
	if (c < 0) {
		sinComunidad.set(region, (sinComunidad.get(region) ?? 0) + 1);
		continue;
	}
	if (ini.includes(':')) {
		const a = ipv6(ini);
		const z = ipv6(fin);
		if (a && z) v6.push([a, z, c]);
	} else {
		const a = ipv4(ini);
		const z = ipv4(fin);
		if (a !== null && z !== null) v4.push([a, z, c]);
	}
}

/* Juntar los rangos contiguos de la misma comunidad (DB-IP los parte por ciudad). */
function juntar(rangos, cmp, siguiente) {
	rangos.sort((x, y) => cmp(x[0], y[0]));
	const r = [];
	for (const x of rangos) {
		const u = r.at(-1);
		if (u && u[2] === x[2] && cmp(siguiente(u[1]), x[0]) === 0) u[1] = x[1];
		else r.push([...x]);
	}
	return r;
}
const mas1v6 = (b) => {
	const n = Buffer.from(b);
	for (let i = 15; i >= 0; i--) if (++n[i] <= 255) break;
	return n;
};
const r4 = juntar(
	v4,
	(a, b) => a - b,
	(n) => n + 1
);
const r6 = juntar(v6, Buffer.compare, mas1v6);
/* Sin filas (p. ej. la descarga del mes aún no existe): fallar sin escribir nada. */
if (r4.length === 0) {
	console.error('Spain: no ranges in the input');
	process.exit(1);
}

const salida = Buffer.alloc(5 + 8 + r4.length * 9 + r6.length * 33);
let o = salida.write('SDES1', 0, 'latin1');
o = salida.writeUInt32BE(r4.length, o);
o = salida.writeUInt32BE(r6.length, o);
for (const [a, z, c] of r4) {
	o = salida.writeUInt32BE(a, o);
	o = salida.writeUInt32BE(z, o);
	o = salida.writeUInt8(c, o);
}
for (const [a, z, c] of r6) {
	o += a.copy(salida, o);
	o += z.copy(salida, o);
	o = salida.writeUInt8(c, o);
}
writeFileSync(process.argv[2] ?? 'espana.bin', salida);
console.log(`Spain: ${r4.length} IPv4 ranges and ${r6.length} IPv6`);
if (sinComunidad.size) console.log('No known region:', Object.fromEntries(sinComunidad));
