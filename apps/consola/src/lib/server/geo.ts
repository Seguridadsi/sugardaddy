/*
 * De dónde viene una IP pública: país y organización (la red o el proveedor
 * desde el que ataca) y, si es española, la comunidad autónoma. Con las bases
 * gratuitas de DB-IP (CC BY 4.0) que viajan dentro de la imagen de la consola:
 * ninguna IP sale del nodo para averiguarlo. Las privadas y reservadas no se
 * buscan: no tienen sitio en un mapa.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Reader, type AsnResponse, type CountryResponse } from 'maxmind';
import { esIpPublica } from '@sugardaddy/canal';

export type Geo = {
	pais: string | null;
	asn: number | null;
	organizacion: string | null;
	/* Comunidad autónoma (ISO 3166-2:ES sin el «ES-»), solo en las españolas. */
	region: string | null;
};

const carpeta = process.env.GEO_DIR ?? join(process.cwd(), 'geo');

type Espana = { v4: Buffer; n4: number; v6: Buffer; n6: number };
let bases: {
	pais: Reader<CountryResponse> | null;
	asn: Reader<AsnResponse> | null;
	espana: Espana | null;
} | null = null;

/* El mismo orden que scripts/geo-espana.mjs, que es quien escribe espana.bin. */
export const COMUNIDADES = [
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
] as const;

export function leerEspana(b: Buffer): Espana | null {
	if (b.length < 13 || b.toString('latin1', 0, 5) !== 'SDES1') return null;
	const n4 = b.readUInt32BE(5);
	const n6 = b.readUInt32BE(9);
	const v4 = b.subarray(13, 13 + n4 * 9);
	const v6 = b.subarray(13 + n4 * 9, 13 + n4 * 9 + n6 * 33);
	return v4.length === n4 * 9 && v6.length === n6 * 33 ? { v4, n4, v6, n6 } : null;
}

function bytesIp(ip: string): Buffer | null {
	const v4 = ip.startsWith('::ffff:') && ip.includes('.') ? ip.slice(7) : ip;
	if (v4.includes('.')) {
		const p = v4.split('.').map(Number);
		return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
			? Buffer.from(p)
			: null;
	}
	const [a, z] = ip.split('::');
	const izq = a ? a.split(':') : [];
	const der = z ? z.split(':') : [];
	const grupos =
		z === undefined ? izq : [...izq, ...Array(8 - izq.length - der.length).fill('0'), ...der];
	if (grupos.length !== 8 || grupos.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
	const b = Buffer.alloc(16);
	grupos.forEach((g, i) => b.writeUInt16BE(parseInt(g, 16), i * 2));
	return b;
}

/* Búsqueda binaria en los rangos (ordenados y sin solaparse). */
export function comunidadDe(e: Espana, ip: string): string | null {
	const x = bytesIp(ip);
	if (!x) return null;
	const [tabla, n, ancho] = x.length === 4 ? [e.v4, e.n4, 4] : [e.v6, e.n6, 16];
	const paso = ancho * 2 + 1;
	let lo = 0;
	let hi = n - 1;
	while (lo <= hi) {
		const m = (lo + hi) >> 1;
		const i = m * paso;
		if (Buffer.compare(x, tabla.subarray(i, i + ancho)) < 0) hi = m - 1;
		else if (Buffer.compare(x, tabla.subarray(i + ancho, i + 2 * ancho)) > 0) lo = m + 1;
		else return COMUNIDADES[tabla[i + 2 * ancho]] ?? null;
	}
	return null;
}

function abrir() {
	if (bases) return bases;
	const leer = <T extends CountryResponse | AsnResponse>(f: string) => {
		const ruta = join(carpeta, f);
		return existsSync(ruta) ? new Reader<T>(readFileSync(ruta)) : null;
	};
	const es = join(carpeta, 'espana.bin');
	bases = {
		pais: leer<CountryResponse>('dbip-country-lite.mmdb'),
		asn: leer<AsnResponse>('dbip-asn-lite.mmdb'),
		espana: existsSync(es) ? leerEspana(readFileSync(es)) : null
	};
	if (!bases.pais) console.warn(`[geo] sin base de países en ${carpeta}: no se geolocaliza`);
	return bases;
}

/* Si el nodo trae las bases de DB-IP: entonces hay que citarlas (pie de la consola). */
export const hayGeo = () => !!(abrir().pais || abrir().asn);

const cache = new Map<string, Geo | null>();

export function geo(ip: string | undefined | null): Geo | null {
	if (!ip || !esIpPublica(ip)) return null;
	if (cache.has(ip)) return cache.get(ip)!;
	const b = abrir();
	let r: Geo | null = null;
	try {
		const p = b.pais?.get(ip);
		const a = b.asn?.get(ip);
		const pais = p?.country?.iso_code ?? null;
		r = {
			pais,
			asn: a?.autonomous_system_number ?? null,
			organizacion: a?.autonomous_system_organization ?? null,
			region: pais === 'ES' && b.espana ? comunidadDe(b.espana, ip) : null
		};
	} catch {
		r = null;
	}
	if (cache.size > 50_000) cache.clear();
	cache.set(ip, r);
	return r;
}
