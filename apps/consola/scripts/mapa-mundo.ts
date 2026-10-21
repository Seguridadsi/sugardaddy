/*
 * Genera src/lib/mapa/mundo.json: el contorno de cada país ya proyectado,
 * para pintar el mapa del Resumen sin pedir nada fuera (ni teselas ni
 * librerías en el navegador). Datos de Natural Earth (dominio público) vía
 * world-atlas. Solo hace falta volver a lanzarlo si se cambia la proyección.
 *
 *   node --experimental-strip-types scripts/mapa-mundo.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { geoNaturalEarth1, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import paises from 'i18n-iso-countries';

const requerir = createRequire(import.meta.url);
const mundo = JSON.parse(readFileSync(requerir.resolve('world-atlas/countries-110m.json'), 'utf8'));
const geo = feature(mundo, mundo.objects.countries) as unknown as {
	features: { id: string; geometry: unknown }[];
};
/* La Antártida ocupa mucho y no ataca a nadie. */
const visibles = {
	type: 'FeatureCollection',
	features: geo.features.filter((f) => f.id !== '010')
};

export const ANCHO = 960;
export const ALTO = 470;
const proyeccion = geoNaturalEarth1().fitSize([ANCHO, ALTO], visibles as never);
const camino = geoPath(proyeccion);
const redondear = (d: string) => d.replace(/\d+\.\d+/g, (n) => Number(n).toFixed(1));

const salida = visibles.features.flatMap((f) => {
	const a2 = paises.numericToAlpha2(f.id);
	const d = camino(f as never);
	return a2 && d ? [{ a2, d: redondear(d) }] : [];
});
writeFileSync(
	'src/lib/mapa/mundo.json',
	JSON.stringify({ ancho: ANCHO, alto: ALTO, paises: salida })
);
console.log(`${salida.length} países`);
