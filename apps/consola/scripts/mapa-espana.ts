/*
 * Genera src/lib/mapa/espana.json: las comunidades autónomas ya proyectadas,
 * con Canarias en un recuadro, para el mapa de España del Resumen (las IP
 * españolas por comunidad). Como el del mundo: nada se pide fuera al pintarlo.
 * Datos de Natural Earth (dominio público), las provincias de admin-1 a 1:10m,
 * agrupadas por su comunidad. Solo hace falta volver a lanzarlo si cambia el
 * dibujo:
 *
 *   curl -o ne-admin1.geojson https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson
 *   node --experimental-strip-types scripts/mapa-espana.ts ne-admin1.geojson
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { geoMercator, geoPath, type GeoProjection } from 'd3-geo';

type Anillo = [number, number][];
type Provincia = {
	properties: { region: string; adm0_a3: string };
	geometry:
		{ type: 'Polygon'; coordinates: Anillo[] } | { type: 'MultiPolygon'; coordinates: Anillo[][] };
};

/* Natural Earth nombra las comunidades a su manera; aquí van a ISO 3166-2:ES. */
const CODIGO: Record<string, string> = {
	Andalucía: 'AN',
	Aragón: 'AR',
	Asturias: 'AS',
	Cantabria: 'CB',
	Ceuta: 'CE',
	'Castilla y León': 'CL',
	'Castilla-La Mancha': 'CM',
	'Canary Is.': 'CN',
	Cataluña: 'CT',
	Extremadura: 'EX',
	Galicia: 'GA',
	'Islas Baleares': 'IB',
	Murcia: 'MC',
	Madrid: 'MD',
	Melilla: 'ML',
	'Foral de Navarra': 'NC',
	'País Vasco': 'PV',
	'La Rioja': 'RI',
	Valenciana: 'VC'
};

const fuente = JSON.parse(readFileSync(process.argv[2] ?? 'ne-admin1.geojson', 'utf8'));
const provincias = (fuente.features as Provincia[]).filter((f) => f.properties.adm0_a3 === 'ESP');
for (const p of provincias)
	if (!CODIGO[p.properties.region]) throw new Error(`Region with no code: ${p.properties.region}`);

const coleccion = (fs: Provincia[]) => ({ type: 'FeatureCollection', features: fs }) as never;
const canarias = provincias.filter((p) => CODIGO[p.properties.region] === 'CN');
const resto = provincias.filter((p) => CODIGO[p.properties.region] !== 'CN');

const ANCHO = 600;
const MARGEN = 10;
const peninsula = geoMercator().fitWidth(ANCHO - 2 * MARGEN, coleccion(resto));
const [[, y0], [, y1]] = geoPath(peninsula).bounds(coleccion(resto));
peninsula.translate([peninsula.translate()[0] + MARGEN, peninsula.translate()[1] - y0 + MARGEN]);
const altoPeninsula = y1 - y0 + 2 * MARGEN;

/* Canarias a la misma escala, debajo y a la izquierda, dentro de su recuadro. */
const islas = geoMercator().scale(peninsula.scale()).translate([0, 0]);
const [[cx0, cy0], [cx1, cy1]] = geoPath(islas).bounds(coleccion(canarias));
const HUECO = 12;
islas.translate([MARGEN + HUECO - cx0, altoPeninsula + HUECO - cy0]);
const recuadro = {
	x: MARGEN,
	y: altoPeninsula,
	ancho: cx1 - cx0 + 2 * HUECO,
	alto: cy1 - cy0 + 2 * HUECO
};
const ALTO = Math.ceil(recuadro.y + recuadro.alto + MARGEN);

/* Proyecta y quita los puntos a menos de medio píxel del anterior: pesa mucho menos. */
function camino(proy: GeoProjection, anillos: Anillo[]) {
	let d = '';
	for (const anillo of anillos) {
		const puntos: [number, number][] = [];
		for (const c of anillo) {
			const p = proy(c);
			if (!p) continue;
			const u = puntos.at(-1);
			if (!u || Math.hypot(p[0] - u[0], p[1] - u[1]) >= 0.5) puntos.push(p);
		}
		if (puntos.length < 3) continue;
		d += 'M' + puntos.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L') + 'Z';
	}
	return d;
}

const anillos = (p: Provincia) =>
	p.geometry.type === 'Polygon' ? p.geometry.coordinates : p.geometry.coordinates.flat();

const zonas = new Map<string, string>();
for (const p of provincias) {
	const id = CODIGO[p.properties.region];
	const d = camino(id === 'CN' ? islas : peninsula, anillos(p));
	zonas.set(id, (zonas.get(id) ?? '') + d);
}

writeFileSync(
	'src/lib/mapa/espana.json',
	JSON.stringify({
		ancho: ANCHO,
		alto: ALTO,
		recuadro: Object.fromEntries(Object.entries(recuadro).map(([k, v]) => [k, Math.round(v)])),
		zonas: [...zonas].map(([id, d]) => ({ id, d }))
	})
);
console.log(`${zonas.size} regions, ${ANCHO}x${ALTO}`);
