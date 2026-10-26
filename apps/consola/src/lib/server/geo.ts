/*
 * De dónde viene una IP pública: país y organización (la red o el proveedor
 * desde el que ataca). Con las bases gratuitas de DB-IP (CC BY 4.0) que
 * viajan dentro de la imagen de la consola: ninguna IP sale del nodo para
 * averiguarlo. Las privadas y reservadas no se buscan: no tienen sitio en
 * un mapa.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Reader, type AsnResponse, type CountryResponse } from 'maxmind';
import { esIpPublica } from '@sugardaddy/canal';

export type Geo = { pais: string | null; asn: number | null; organizacion: string | null };

const carpeta = process.env.GEO_DIR ?? join(process.cwd(), 'geo');

let bases: { pais: Reader<CountryResponse> | null; asn: Reader<AsnResponse> | null } | null = null;

function abrir() {
	if (bases) return bases;
	const leer = <T extends CountryResponse | AsnResponse>(f: string) => {
		const ruta = join(carpeta, f);
		return existsSync(ruta) ? new Reader<T>(readFileSync(ruta)) : null;
	};
	bases = {
		pais: leer<CountryResponse>('dbip-country-lite.mmdb'),
		asn: leer<AsnResponse>('dbip-asn-lite.mmdb')
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
		r = {
			pais: p?.country?.iso_code ?? null,
			asn: a?.autonomous_system_number ?? null,
			organizacion: a?.autonomous_system_organization ?? null
		};
	} catch {
		r = null;
	}
	if (cache.size > 50_000) cache.clear();
	cache.set(ip, r);
	return r;
}
