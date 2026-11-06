/*
 * Las líneas del mapa del despliegue: de las cajas que mide la página a los
 * trazos del SVG. Es un árbol, así que nunca se cruzan: la consola arriba, una
 * barra debajo y de ella una rama por sensor. El primer sensor de cada columna
 * baja directo; los demás, por el pasillo entre columnas.
 */
export type Caja = { l: number; t: number; r: number; b: number };
export type ClaseLinea = 'ok' | 'mal' | 'rele' | 'senal';

export interface RamaEntrada {
	caja: Caja;
	zona: Caja;
	clase: Exclude<ClaseLinea, 'senal'>;
	/* Es lo primero de su columna: baja directo desde la barra. */
	directa: boolean;
	pildora: string | null;
}

export interface HijoEntrada {
	padre: Caja;
	hijo: Caja;
	clase: 'senal' | 'rele';
}

export interface Trazado {
	trazos: { d: string; clase: ClaseLinea }[];
	flechas: { x: number; y: number; clase: ClaseLinea }[];
	pildoras: { x: number; y: number; texto: string; clase: ClaseLinea }[];
}

/* Dónde cae la rama en el ancho de la red: a la derecha, para no pisar su título. */
const POSICION_RAMA = 0.84;
/* Lo que baja la rama antes de entrar por el lado en un sensor que no es el primero. */
const ENTRADA_LATERAL = 44;
/* Lo que baja el raíl de un sistema hasta entrar en su tarjeta. */
const ENTRADA_HIJO = 24;
const BAJADA_BARRA = 22;
const RAIL = 8;

const camino = (puntos: [number, number][]) =>
	`M${puntos.map(([x, y]) => `${Math.round(x)} ${Math.round(y)}`).join(' L')}`;

export function trazarLineas(e: {
	consola: Caja;
	ramas: RamaEntrada[];
	hijos: HijoEntrada[];
	/* El hueco entre columnas: por él bajan las ramas de los demás sensores. */
	hueco: number;
}): Trazado {
	const r: Trazado = { trazos: [], flechas: [], pildoras: [] };
	const centro = (e.consola.l + e.consola.r) / 2;
	const barra = e.consola.b + BAJADA_BARRA;
	const xs: number[] = [];

	for (const m of e.ramas) {
		if (m.directa) {
			const x = m.zona.l + (m.zona.r - m.zona.l) * POSICION_RAMA;
			xs.push(x);
			r.trazos.push({
				d: camino([
					[x, barra],
					[x, m.caja.t]
				]),
				clase: m.clase
			});
			r.flechas.push({ x, y: barra + 10, clase: m.clase });
			if (m.pildora)
				r.pildoras.push({
					x: x - 40,
					y: (barra + m.zona.t) / 2 + 6,
					texto: m.pildora,
					clase: m.clase
				});
		} else {
			/* Un sensor caído va en su propio carril, para que no se tapen en el pasillo. */
			const x = m.zona.r + e.hueco / 2 + (m.clase === 'mal' ? 6 : 0);
			const y = m.caja.t + ENTRADA_LATERAL;
			xs.push(x);
			r.trazos.push({
				d: camino([
					[x, barra],
					[x, y],
					[m.caja.r, y]
				]),
				clase: m.clase
			});
			r.flechas.push({ x, y: barra + 10, clase: m.clase });
		}
	}

	if (xs.length) {
		/* La barra es de lo que funciona; solo si no queda nada en línea, del color de lo que hay. */
		const clases = e.ramas.map((m) => m.clase);
		const clase: ClaseLinea = clases.includes('ok')
			? 'ok'
			: clases.includes('mal')
				? 'mal'
				: 'rele';
		r.trazos.unshift(
			{
				d: camino([
					[centro, e.consola.b],
					[centro, barra]
				]),
				clase
			},
			{
				d: camino([
					[Math.min(centro, ...xs), barra],
					[Math.max(centro, ...xs), barra]
				]),
				clase
			}
		);
		r.flechas.unshift({ x: centro, y: e.consola.b + 9, clase });
	}

	/* Lo gris primero: si un raíl comparte tramo, se ve el del relé. */
	const hijos = e.hijos.toSorted((a, b) => Number(a.clase === 'rele') - Number(b.clase === 'rele'));
	const vistas = new Set<string>();
	for (const h of hijos) {
		const x = h.padre.l + RAIL;
		const y = h.hijo.t + ENTRADA_HIJO;
		r.trazos.push({
			d: camino([
				[x, h.padre.b],
				[x, y],
				[h.hijo.l, y]
			]),
			clase: h.clase
		});
		const clave = `${Math.round(x)}:${Math.round(h.padre.b)}`;
		if (!vistas.has(clave)) r.flechas.push({ x, y: h.padre.b + 9, clase: h.clase });
		vistas.add(clave);
	}
	return r;
}

export interface RamaFila {
	/* El nodo del sensor, su grafo y su red. */
	caja: Caja;
	cuadro: Caja;
	zona: Caja;
	clase: Exclude<ClaseLinea, 'senal'>;
	pildora: string | null;
	/* Su grafo es de la primera fila de su red: baja directo. */
	primeraDeZona: boolean;
}

/* Lo que sube la barra de una fila sobre sus redes, y dónde va su píldora. */
const SOBRE_FILA = 44;
const PILDORA_FILA = 20;

/*
 * Las líneas del grafo. Las redes miden distinto y van por filas: cada fila tiene
 * su barra en el hueco de encima, y un tronco a la izquierda las une a la consola.
 * Así ninguna línea atraviesa una red ajena.
 */
export function trazarFilas(e: { consola: Caja; ramas: RamaFila[] }): Trazado {
	const r: Trazado = { trazos: [], flechas: [], pildoras: [] };
	if (!e.ramas.length) return r;
	const centro = (e.consola.l + e.consola.r) / 2;
	const clases = e.ramas.map((m) => m.clase);
	const clase: ClaseLinea = clases.includes('ok') ? 'ok' : clases.includes('mal') ? 'mal' : 'rele';

	const filas = new Map<number, RamaFila[]>();
	for (const m of e.ramas) {
		const k = Math.round(m.zona.t);
		filas.set(k, [...(filas.get(k) ?? []), m]);
	}
	const orden = [...filas.keys()].toSorted((a, b) => a - b);
	const izquierda = Math.min(...e.ramas.map((m) => m.zona.l)) - 16;
	const xDe = (m: RamaFila) => (m.caja.l + m.caja.r) / 2;
	const barras: { y: number; xs: number[] }[] = orden.map((k) => ({
		y: k - SOBRE_FILA,
		xs: filas.get(k)!.map(xDe)
	}));

	/* Desde la consola a la barra de la primera fila. */
	r.trazos.push({
		d: camino([
			[centro, e.consola.b],
			[centro, barras[0].y]
		]),
		clase
	});
	r.flechas.push({ x: centro, y: e.consola.b + 9, clase });

	const conTronco = barras.length > 1;
	if (conTronco)
		r.trazos.push({
			d: camino([
				[izquierda, barras[0].y],
				[izquierda, barras[barras.length - 1].y]
			]),
			clase
		});
	barras.forEach((b, i) => {
		const extremos = [...b.xs, ...(conTronco ? [izquierda] : []), ...(i === 0 ? [centro] : [])];
		r.trazos.push({
			d: camino([
				[Math.min(...extremos), b.y],
				[Math.max(...extremos), b.y]
			]),
			clase
		});
	});

	orden.forEach((k, i) => {
		const y = barras[i].y;
		for (const m of filas.get(k)!) {
			const x = xDe(m);
			if (m.primeraDeZona) {
				r.trazos.push({
					d: camino([
						[x, y],
						[x, m.caja.t]
					]),
					clase: m.clase
				});
				r.flechas.push({ x, y: y + 10, clase: m.clase });
				if (m.pildora)
					r.pildoras.push({ x, y: k - PILDORA_FILA, texto: m.pildora, clase: m.clase });
			} else {
				/* Otro grafo más abajo en la misma red: sale por el margen de la red. */
				const margen = m.zona.l + 6;
				const hueco = m.cuadro.t - 6;
				r.trazos.push({
					d: camino([
						[margen, y],
						[margen, hueco],
						[x, hueco],
						[x, m.caja.t]
					]),
					clase: m.clase
				});
				r.flechas.push({ x: margen, y: y + 10, clase: m.clase });
			}
		}
	});
	return r;
}
