/*
 * La colocación del grafo del mapa del despliegue: de un sensor y lo suyo, a
 * nodos con posición y aristas. El sensor va en el centro y sus trampas en
 * anillos alrededor, agrupadas por tipo de servicio cuando son muchas; debajo,
 * cada sistema sin sensor con las suyas, unido a la trampa que recibe su señal.
 *
 * Cada anillo se reparte en huecos fijos, separados lo que ocupa una trampa, y
 * cada trampa ocupa uno: así dos nodos no pueden pisarse, sean cuantos sean. El
 * resultado no depende de nada más que de los datos: el mismo despliegue se ve
 * siempre igual, y no se mueve al actualizarse la página.
 */
import type { TipoDeServicio } from '@sugardaddy/estilo/pictogramas';
import { FAMILIAS, type SensorMapa, type SistemaMapa, type TrampaMapa } from './mapa-despliegue';

/* Lo que ocupa cada nodo. Una trampa: su círculo, y debajo su servicio y su puerto. */
export const HOJA = { ancho: 92, circulo: 46, debajo: 64 };
export const CENTRO = { ancho: 254, alto: 112 };
export const SISTEMA = { ancho: 196, alto: 76 };
export const FAMILIA = { circulo: 36 };

/* De un anillo al siguiente. */
const PASO_X = 102;
const PASO_Y = 94;
/* Con hasta tantas trampas no hace falta agruparlas: una estrella alrededor del sensor. */
const MAX_ESTRELLA = 9;
const ESTRELLA = { x: 208, y: 152 };
const ANILLO_FAMILIAS = { x: 196, y: 120 };
const PRIMER_ANILLO = { x: 304, y: 226 };
/* Lo que se deja libre arriba, en grados a cada lado: por ahí entra la línea de la consola. */
const HUECO_ARRIBA = 17;
/* Las trampas de un sistema se abren hacia abajo, en este arco. */
const ARCO_SISTEMA = { desde: 118, hasta: 242 };
const SISTEMA_PRIMERO = { x: 132, y: 112 };
const MARGEN = 14;
const ENTRE_SISTEMAS = 26;
/* Lo que baja del último anillo a la fila de sistemas, para que se vea su línea. */
const BAJADA_SISTEMAS = 66;
const ANCHO_FILA = 760;

export type NodoGrafo = { id: string; x: number; y: number } & (
	| { tipo: 'centro' }
	| { tipo: 'trampa'; trampa: TrampaMapa }
	| {
			tipo: 'familia';
			familia: TipoDeServicio | null;
			nombre: string;
			trampas: TrampaMapa[];
			conNombre: boolean;
	  }
	| { tipo: 'sistema'; sistema: SistemaMapa }
);

export type ClaseArista = 'estructura' | 'ok' | 'pendiente' | 'aviso' | 'mal' | 'senal' | 'rele';

export interface AristaGrafo {
	de: string;
	a: string;
	clase: ClaseArista;
	/* Es una señal: lleva flecha hacia quien la recibe y dice cómo llega. */
	relacion?: { texto: string; destino: string | null };
}

export interface Grafo {
	ancho: number;
	alto: number;
	nodos: NodoGrafo[];
	aristas: AristaGrafo[];
	/* El centro, si lo hay: por él entra la línea de la consola. */
	centro: { x: number; y: number } | null;
}

/* El color de la línea que une una trampa con lo suyo. */
export const claseDeEstado = (t: Pick<TrampaMapa, 'estado'>): ClaseArista =>
	t.estado === 'comprobada'
		? 'ok'
		: t.estado === 'colocada'
			? 'pendiente'
			: t.estado === 'degradada' || t.estado === 'por-colocar'
				? 'aviso'
				: t.estado === 'sin-contacto'
					? 'mal'
					: 'estructura';

/* El ángulo se cuenta desde arriba y en el sentido de las agujas del reloj. */
const enElipse = (rx: number, ry: number, grados: number) => {
	const a = (grados * Math.PI) / 180;
	return { x: rx * Math.sin(a), y: -ry * Math.cos(a) };
};

type Caja = { l: number; r: number; t: number; b: number };
const pisa = (a: Caja, b: Caja) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const cajaHoja = (x: number, y: number): Caja => ({
	l: x - HOJA.ancho / 2,
	r: x + HOJA.ancho / 2,
	t: y - HOJA.circulo / 2,
	b: y + HOJA.debajo
});
const cajaCentrada = (c: { ancho: number; alto: number }, holgura = 8): Caja => ({
	l: -c.ancho / 2 - holgura,
	r: c.ancho / 2 + holgura,
	t: -c.alto / 2 - holgura,
	b: c.alto / 2 + holgura
});

type Hueco = { grados: number; x: number; y: number; caja: Caja };

function recorrer(rx: number, ry: number, desde: number, hasta: number, ocupado: Caja[]): Hueco[] {
	const r: Hueco[] = [];
	for (let g = desde; g <= hasta; g += 0.25) {
		const p = enElipse(rx, ry, g);
		const caja = cajaHoja(p.x, p.y);
		if (ocupado.some((c) => pisa(caja, c))) continue;
		if (r.length && pisa(caja, r[r.length - 1].caja)) continue;
		if (r.length && pisa(caja, r[0].caja)) continue;
		r.push({ grados: g, ...p, caja });
	}
	return r;
}

/*
 * Los huecos de un anillo: recorre la elipse y deja una trampa en cuanto cabe
 * sin pisar a la anterior ni a nada de lo ya colocado. Lo que sobra al final se
 * reparte a los dos lados, para que el anillo quede simétrico.
 */
function huecosDeAnillo(rx: number, ry: number, desde: number, hasta: number, ocupado: Caja[]) {
	const primera = recorrer(rx, ry, desde, hasta, ocupado);
	if (!primera.length) return primera;
	const sobra = hasta - primera[primera.length - 1].grados;
	const centrada = recorrer(rx, ry, desde + sobra / 2, hasta, ocupado);
	return centrada.length >= primera.length ? centrada : primera;
}

/* n de esos huecos, repartidos por todo el anillo. */
const repartir = <T>(lista: T[], n: number) =>
	Array.from({ length: n }, (_, k) => lista[Math.floor(((k + 0.5) * lista.length) / n)]);

const DESDE = HUECO_ARRIBA;
const HASTA = 360 - HUECO_ARRIBA;

/* Las trampas que reciben una señal van abajo, cerca de los sistemas que les llegan. */
function conObjetivosAbajo<T>(lista: T[], esObjetivo: (x: T) => boolean): T[] {
	const objetivos = lista.filter(esObjetivo);
	const resto = lista.filter((x) => !esObjetivo(x));
	const mitad = Math.ceil(resto.length / 2);
	return [...resto.slice(0, mitad), ...objetivos, ...resto.slice(mitad)];
}

type Colocada = { trampa: TrampaMapa; x: number; y: number; caja: Caja };

interface Radial {
	hojas: Colocada[];
	familias: {
		familia: TipoDeServicio | null;
		trampas: TrampaMapa[];
		x: number;
		y: number;
		conNombre: boolean;
	}[];
}

/* Hasta MAX_ESTRELLA, todas alrededor del sensor, en el anillo más pequeño donde quepan. */
function estrella(trampas: TrampaMapa[], objetivos: Set<string>): Radial {
	const orden = conObjetivosAbajo(trampas, (t) => objetivos.has(t.id));
	const ocupado = [cajaCentrada(CENTRO)];
	let h: Hueco[] = [];
	for (let i = 0; h.length < orden.length; i++)
		h = huecosDeAnillo(ESTRELLA.x + i * 20, ESTRELLA.y + i * 20, DESDE, HASTA, ocupado);
	const elegidos = repartir(h, orden.length);
	return {
		hojas: orden.map((trampa, i) => ({ trampa, ...elegidos[i] })),
		familias: []
	};
}

/*
 * Con más: agrupadas por su tipo de servicio. Cada tipo tiene un trozo de la
 * vuelta según cuántas trampas lleva, y cada trampa va al hueco libre más cerca
 * del centro de su trozo, prefiriendo los anillos interiores.
 */
function porFamilias(trampas: TrampaMapa[], objetivos: Set<string>): Radial {
	const grupos = new Map<TipoDeServicio | null, TrampaMapa[]>();
	for (const t of trampas) grupos.set(t.pictograma, [...(grupos.get(t.pictograma) ?? []), t]);
	const orden = conObjetivosAbajo(
		[...grupos.entries()].toSorted(
			(a, b) => b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0]))
		),
		([, ts]) => ts.some((t) => objetivos.has(t.id))
	);

	const total = HASTA - DESDE;
	const pesos = orden.map(([, ts]) => ts.length + 0.5);
	const suma = pesos.reduce((a, b) => a + b, 0);
	let acumulado = DESDE;
	const centros = pesos.map((p) => {
		const ancho = (total * p) / suma;
		const c = acumulado + ancho / 2;
		acumulado += ancho;
		return c;
	});

	/* Los círculos de los tipos no se pisan aunque un trozo sea muy estrecho. */
	const largoFamilias =
		2 * Math.PI * Math.sqrt((ANILLO_FAMILIAS.x ** 2 + ANILLO_FAMILIAS.y ** 2) / 2);
	const minimo = (48 / largoFamilias) * 360;
	for (let i = 1; i < centros.length; i++)
		centros[i] = Math.max(centros[i], centros[i - 1] + minimo);
	if (centros.length && centros[centros.length - 1] > HASTA) {
		centros[centros.length - 1] = HASTA;
		for (let i = centros.length - 2; i >= 0; i--)
			centros[i] = Math.min(centros[i], centros[i + 1] - minimo);
	}

	const familias = orden.map(([familia, ts], i) => {
		const p = enElipse(ANILLO_FAMILIAS.x, ANILLO_FAMILIAS.y, centros[i]);
		/* Su nombre, solo si cabe entre sus vecinos. */
		const separacion = Math.min(
			i > 0 ? centros[i] - centros[i - 1] : Infinity,
			i < centros.length - 1 ? centros[i + 1] - centros[i] : Infinity
		);
		return {
			familia,
			trampas: ts,
			x: p.x,
			y: p.y,
			conNombre: (separacion / 360) * largoFamilias >= 96
		};
	});

	const ocupado: Caja[] = [
		cajaCentrada(CENTRO),
		...familias
			.filter((f) => f.trampas.length > 1)
			.map((f) => ({ l: f.x - 50, r: f.x + 50, t: f.y - 22, b: f.y + 36 }))
	];

	/* Los anillos que hagan falta, con holgura para que cada grupo quepa cerca de su centro. */
	const anillos: { rx: number; huecos: Hueco[]; libre: boolean[] }[] = [];
	let plazas = 0;
	for (let i = 0; plazas < trampas.length * 1.2; i++) {
		const rx = PRIMER_ANILLO.x + i * PASO_X;
		const ry = PRIMER_ANILLO.y + i * PASO_Y;
		const lista = huecosDeAnillo(rx, ry, DESDE, HASTA, ocupado);
		ocupado.push(...lista.map((x) => x.caja));
		anillos.push({ rx, huecos: lista, libre: lista.map(() => true) });
		plazas += lista.length;
	}

	const hojas: Colocada[] = [];
	orden.forEach(([, ts], f) => {
		for (const trampa of ts) {
			let mejor: { a: number; p: number; coste: number } | null = null;
			anillos.forEach((anillo, a) => {
				anillo.huecos.forEach((hueco, p) => {
					if (!anillo.libre[p]) return;
					/* Lo que se aleja del centro de su trozo, medido sobre el anillo, más lo que sube de anillo. */
					const lejos = (Math.abs(hueco.grados - centros[f]) / 360) * 2 * Math.PI * anillo.rx;
					const coste = lejos + a * 70;
					if (!mejor || coste < mejor.coste) mejor = { a, p, coste };
				});
			});
			const { a, p } = mejor!;
			anillos[a].libre[p] = false;
			hojas.push({ trampa, ...anillos[a].huecos[p] });
		}
	});
	return { hojas, familias };
}

/* Un sistema sin sensor con sus trampas abiertas hacia abajo, con el sistema en el origen. */
function subgrafoSistema(sistema: SistemaMapa) {
	const ocupado = [cajaCentrada(SISTEMA, 4)];
	const hojas: Colocada[] = [];
	let cuenta = 0;
	for (let i = 0; cuenta < sistema.trampas.length; i++) {
		const lista = huecosDeAnillo(
			SISTEMA_PRIMERO.x + i * PASO_X,
			SISTEMA_PRIMERO.y + i * PASO_Y,
			ARCO_SISTEMA.desde,
			ARCO_SISTEMA.hasta,
			ocupado
		);
		ocupado.push(...lista.map((x) => x.caja));
		const n = Math.min(lista.length, sistema.trampas.length - cuenta);
		for (const hueco of repartir(lista, n))
			hojas.push({ trampa: sistema.trampas[cuenta++], ...hueco });
	}
	const mitad = Math.max(SISTEMA.ancho / 2, ...hojas.map((h) => Math.max(-h.caja.l, h.caja.r)));
	const alto = SISTEMA.alto / 2 + Math.max(SISTEMA.alto / 2, ...hojas.map((h) => h.caja.b));
	return { hojas, ancho: mitad * 2, alto };
}

/* Lo que une un sistema con quien recibe su señal: una arista por cada destino distinto. */
function relacionesDeSistema(
	sistema: SistemaMapa,
	idCentro: string | null,
	enEsteGrafo: Set<string>
): AristaGrafo[] {
	const vistos = new Set<string>();
	const r: AristaGrafo[] = [];
	const de = `s:${sistema.id}`;
	for (const t of sistema.trampas) {
		const objetivo = t.objetivo && enEsteGrafo.has(t.objetivo) ? `t:${t.objetivo}` : idCentro;
		if (!objetivo || vistos.has(objetivo)) continue;
		vistos.add(objetivo);
		r.push({
			de,
			a: objetivo,
			clase: t.ruta?.rele || sistema.linea === 'rele' ? 'rele' : 'senal',
			relacion: {
				texto: (t.ruta?.texto ?? 'Señal').replace(/,? (hacia|entra en)$/, ''),
				destino: t.ruta?.destino ?? null
			}
		});
	}
	/* Sin trampas que lo digan, sigue colgando de su sensor. */
	if (!r.length && idCentro)
		r.push({
			de,
			a: idCentro,
			clase: sistema.linea === 'rele' ? 'rele' : 'senal',
			relacion: { texto: 'Sin señal todavía', destino: null }
		});
	return r;
}

/*
 * Un centro (un sensor o la salida a internet), sus trampas y sus sistemas. idCentro
 * nulo: solo sistemas, sin línea que los una a nada (los que aún no tienen trampas).
 */
export function armarGrafo(v: {
	idCentro: string | null;
	trampas: TrampaMapa[];
	sistemas: SistemaMapa[];
}): Grafo {
	const { idCentro, trampas, sistemas } = v;
	const aquiEstan = new Set(trampas.map((t) => t.id));
	const objetivos = new Set(
		[...trampas, ...sistemas.flatMap((s) => s.trampas)]
			.map((t) => t.objetivo)
			.filter((o): o is string => !!o && aquiEstan.has(o))
	);

	const radial: Radial | null = !trampas.length
		? null
		: trampas.length <= MAX_ESTRELLA
			? estrella(trampas, objetivos)
			: porFamilias(trampas, objetivos);

	/* Lo que ocupa la parte de arriba, medido desde el centro. */
	const cajas = radial?.hojas.map((h) => h.caja) ?? [];
	const izquierda = Math.max(
		idCentro ? CENTRO.ancho / 2 : 0,
		...cajas.map((c) => Math.max(-c.l, c.r))
	);
	const arriba = Math.max(idCentro ? CENTRO.alto / 2 : 0, ...cajas.map((c) => -c.t));
	const abajo = Math.max(idCentro ? CENTRO.alto / 2 : 0, ...cajas.map((c) => c.b));

	const subgrafos = sistemas.map((s) => ({ sistema: s, ...subgrafoSistema(s) }));
	const limite = Math.max(ANCHO_FILA, izquierda * 2);
	const filas: (typeof subgrafos)[] = [];
	for (const g of subgrafos) {
		const fila = filas[filas.length - 1];
		const ancho = fila ? fila.reduce((n, x) => n + x.ancho + ENTRE_SISTEMAS, 0) + g.ancho : 0;
		if (fila && ancho <= limite) fila.push(g);
		else filas.push([g]);
	}
	const anchoFila = (f: typeof subgrafos) =>
		f.reduce((n, x) => n + x.ancho, 0) + ENTRE_SISTEMAS * (f.length - 1);
	const ancho =
		Math.max(idCentro || radial ? izquierda * 2 : 0, ...filas.map(anchoFila), 0) + MARGEN * 2;

	const cx = ancho / 2;
	const cy = MARGEN + arriba;
	const nodos: NodoGrafo[] = [];
	const aristas: AristaGrafo[] = [];

	if (idCentro) nodos.push({ id: idCentro, tipo: 'centro', x: cx, y: cy });

	if (radial) {
		const padreDe = new Map<string, string>();
		for (const f of radial.familias) {
			/* Un tipo con una sola trampa no necesita nodo propio: va directa al sensor. */
			if (f.trampas.length < 2) continue;
			const id = `f:${idCentro}:${f.familia}`;
			nodos.push({
				id,
				tipo: 'familia',
				familia: f.familia,
				nombre: f.familia ? FAMILIAS[f.familia] : 'Otras',
				trampas: f.trampas,
				conNombre: f.conNombre,
				x: cx + f.x,
				y: cy + f.y
			});
			if (idCentro) aristas.push({ de: idCentro, a: id, clase: 'estructura' });
			for (const t of f.trampas) padreDe.set(t.id, id);
		}
		for (const h of radial.hojas) {
			const id = `t:${h.trampa.id}`;
			nodos.push({ id, tipo: 'trampa', trampa: h.trampa, x: cx + h.x, y: cy + h.y });
			const padre = padreDe.get(h.trampa.id) ?? idCentro;
			if (padre) aristas.push({ de: padre, a: id, clase: claseDeEstado(h.trampa) });
			/* Lo sembrado en la máquina del sensor que apunta a otra trampa suya. */
			if (h.trampa.objetivo && aquiEstan.has(h.trampa.objetivo))
				aristas.push({
					de: id,
					a: `t:${h.trampa.objetivo}`,
					clase: h.trampa.ruta?.rele ? 'rele' : 'senal',
					relacion: {
						texto: (h.trampa.ruta?.texto ?? 'Señal').replace(/,? (hacia|entra en)$/, ''),
						destino: h.trampa.ruta?.destino ?? null
					}
				});
		}
	}

	let y = idCentro || radial ? cy + abajo + BAJADA_SISTEMAS : MARGEN;
	for (const fila of filas) {
		let x = cx - anchoFila(fila) / 2;
		let altoFila = 0;
		for (const g of fila) {
			const sx = x + g.ancho / 2;
			const sy = y + SISTEMA.alto / 2;
			const id = `s:${g.sistema.id}`;
			nodos.push({ id, tipo: 'sistema', sistema: g.sistema, x: sx, y: sy });
			aristas.push(...relacionesDeSistema(g.sistema, idCentro, aquiEstan));
			for (const h of g.hojas) {
				const idHoja = `t:${h.trampa.id}`;
				nodos.push({ id: idHoja, tipo: 'trampa', trampa: h.trampa, x: sx + h.x, y: sy + h.y });
				aristas.push({ de: id, a: idHoja, clase: claseDeEstado(h.trampa) });
			}
			x += g.ancho + ENTRE_SISTEMAS;
			altoFila = Math.max(altoFila, g.alto);
		}
		y += altoFila + ENTRE_SISTEMAS;
	}

	const alto = filas.length ? y - ENTRE_SISTEMAS + MARGEN : cy + abajo + MARGEN;
	return {
		ancho: Math.round(ancho),
		alto: Math.round(alto),
		nodos: nodos.map((n) => ({ ...n, x: Math.round(n.x), y: Math.round(n.y) })),
		aristas,
		centro: idCentro ? { x: Math.round(cx), y: Math.round(cy) } : null
	};
}

/* El grafo de un sensor. */
export const grafoDeSensor = (x: SensorMapa) =>
	armarGrafo({ idCentro: `c:${x.id}`, trampas: x.trampas, sistemas: x.sistemas });

/* Los nodos unidos a uno: lo que se resalta al pinchar en él. */
export function vecinosDe(g: Grafo, id: string): Set<string> {
	const r = new Set([id]);
	for (const a of g.aristas) {
		if (a.de === id) r.add(a.a);
		if (a.a === id) r.add(a.de);
	}
	return r;
}

/* Dónde empieza y acaba una señal: en el borde de cada nodo, para que se vea su flecha. */
export function extremos(g: Grafo, a: AristaGrafo) {
	const de = g.nodos.find((n) => n.id === a.de);
	const hacia = g.nodos.find((n) => n.id === a.a);
	if (!de || !hacia) return null;
	const borde = (n: NodoGrafo, otro: { x: number; y: number }) => {
		const dx = otro.x - n.x;
		const dy = otro.y - n.y;
		const d = Math.hypot(dx, dy) || 1;
		/* Una trampa lleva sus etiquetas debajo: si la señal le llega por ahí, acaba bajo ellas. */
		if (n.tipo === 'trampa') {
			const k = Math.min(
				dx ? (HOJA.ancho / 2 - 8) / Math.abs(dx) : Infinity,
				dy > 0 ? (HOJA.debajo - 4) / dy : dy < 0 ? (HOJA.circulo / 2 + 5) / -dy : Infinity
			);
			return { x: n.x + dx * k, y: n.y + dy * k };
		}
		const caja = n.tipo === 'centro' ? CENTRO : n.tipo === 'sistema' ? SISTEMA : null;
		if (!caja) {
			const r = FAMILIA.circulo / 2 + 5;
			return { x: n.x + (dx / d) * r, y: n.y + (dy / d) * r };
		}
		const k = Math.min(
			dx ? (caja.ancho / 2 + 5) / Math.abs(dx) : Infinity,
			dy ? (caja.alto / 2 + 5) / Math.abs(dy) : Infinity
		);
		return { x: n.x + dx * k, y: n.y + dy * k };
	};
	return { desde: borde(de, hacia), hasta: borde(hacia, de) };
}
