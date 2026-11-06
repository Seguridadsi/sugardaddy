/*
 * La colocación de un sitio del mapa del despliegue: un sitio es donde están las
 * trampas (la máquina de un sensor, un servidor, una web, una cuenta de nube), y
 * aquí se decide dónde va cada una dentro de él. El sitio va en el centro y sus
 * trampas alrededor, agrupadas por tipo de servicio cuando son muchas: cada tipo
 * tiene su sector, para que las líneas de un grupo no crucen las de otro.
 *
 * Cada anillo se recorre dejando una trampa en cuanto cabe sin pisar nada, así que
 * dos nodos no pueden pisarse, sean cuantos sean. El resultado depende solo de los
 * datos: el mismo sitio se ve siempre igual y no se mueve al actualizarse la página.
 */
import type { TipoDeServicio } from '@sugardaddy/estilo/pictogramas';
import { FAMILIAS, type SensorMapa, type SistemaMapa, type TrampaMapa } from './mapa-despliegue';

/* Lo que ocupa cada nodo. Una trampa: su círculo, y debajo su servicio y su puerto. */
export const HOJA = { ancho: 92, circulo: 46, debajo: 64 };
export const CENTRO_SENSOR = { ancho: 254, alto: 112 };
export const CENTRO_SITIO = { ancho: 232, alto: 92 };
export const FAMILIA = { circulo: 36 };

type Tamano = { ancho: number; alto: number };

/* De un anillo al siguiente. */
const PASO_X = 102;
const PASO_Y = 94;
/* Con hasta tantas trampas no hace falta agruparlas: una estrella alrededor del sitio. */
const MAX_ESTRELLA = 9;
const ESTRELLA = { x: 208, y: 152 };
const ANILLO_FAMILIAS = { x: 196, y: 120 };
/* Lo que hay del anillo de los grupos al primero de sus trampas. */
const SALTO_HOJAS = { x: 108, y: 106 };
/* El sitio que necesita de un grupo, como mínimo, en su anillo: su icono y su nombre. */
const SITIO_FAMILIA = 110;
/* Lo que se deja libre arriba, en grados a cada lado: por ahí entra la línea que le llega. */
const HUECO_ARRIBA = 17;
/* Un sitio pequeño abre sus trampas hacia abajo, en este arco, y queda compacto. */
const MAX_ABANICO = 5;
const ARCO_ABANICO = { desde: 118, hasta: 242 };
const ABANICO = { x: 132, y: 112 };
const MARGEN = 14;

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
);

export type ClaseArista = 'estructura' | 'ok' | 'pendiente' | 'aviso' | 'mal' | 'senal' | 'rele';

export interface AristaGrafo {
	de: string;
	a: string;
	clase: ClaseArista;
	/* Lo sembrado que apunta a otra trampa del mismo sitio: lleva flecha y dice cómo llega. */
	relacion?: { texto: string; destino: string | null };
}

export interface Grafo {
	ancho: number;
	alto: number;
	nodos: NodoGrafo[];
	aristas: AristaGrafo[];
	/* El centro, y lo que mide: por él entra la línea que llega al sitio. */
	centro: { x: number; y: number };
	tamano: Tamano;
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
const cajaCentrada = (c: Tamano, holgura = 8): Caja => ({
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
 * Los huecos de un arco: lo recorre y deja una trampa en cuanto cabe sin pisar a la
 * anterior ni a nada de lo ya colocado. Lo que sobra al final se reparte a los dos
 * lados, para que quede simétrico.
 */
function huecosDeArco(rx: number, ry: number, desde: number, hasta: number, ocupado: Caja[]) {
	const primera = recorrer(rx, ry, desde, hasta, ocupado);
	if (!primera.length) return primera;
	const sobra = hasta - primera[primera.length - 1].grados;
	const centrada = recorrer(rx, ry, desde + sobra / 2, hasta, ocupado);
	return centrada.length >= primera.length ? centrada : primera;
}

/* n de esos huecos, repartidos por todo el arco. */
const repartir = <T>(lista: T[], n: number) =>
	Array.from({ length: n }, (_, k) => lista[Math.floor(((k + 0.5) * lista.length) / n)]);

const perimetro = (rx: number, ry: number) => 2 * Math.PI * Math.sqrt((rx ** 2 + ry ** 2) / 2);

const DESDE = HUECO_ARRIBA;
const HASTA = 360 - HUECO_ARRIBA;

type Colocada = { trampa: TrampaMapa; x: number; y: number; caja: Caja };

interface Reparto {
	hojas: Colocada[];
	familias: {
		familia: TipoDeServicio | null;
		trampas: TrampaMapa[];
		x: number;
		y: number;
		conNombre: boolean;
	}[];
}

/* Pocas en un sitio pequeño: abiertas hacia abajo, con el sitio arriba. */
function abanico(trampas: TrampaMapa[], centro: Tamano): Reparto {
	const ocupado = [cajaCentrada(centro, 4)];
	const hojas: Colocada[] = [];
	let cuenta = 0;
	for (let i = 0; cuenta < trampas.length; i++) {
		const lista = huecosDeArco(
			ABANICO.x + i * PASO_X,
			ABANICO.y + i * PASO_Y,
			ARCO_ABANICO.desde,
			ARCO_ABANICO.hasta,
			ocupado
		);
		ocupado.push(...lista.map((x) => x.caja));
		const n = Math.min(lista.length, trampas.length - cuenta);
		for (const hueco of repartir(lista, n)) hojas.push({ trampa: trampas[cuenta++], ...hueco });
	}
	return { hojas, familias: [] };
}

/* Hasta MAX_ESTRELLA, todas alrededor del sitio, en el anillo más pequeño donde quepan. */
function estrella(trampas: TrampaMapa[], centro: Tamano): Reparto {
	const ocupado = [cajaCentrada(centro)];
	let h: Hueco[] = [];
	for (let i = 0; h.length < trampas.length; i++)
		h = huecosDeArco(ESTRELLA.x + i * 20, ESTRELLA.y + i * 20, DESDE, HASTA, ocupado);
	const elegidos = repartir(h, trampas.length);
	return { hojas: trampas.map((trampa, i) => ({ trampa, ...elegidos[i] })), familias: [] };
}

/*
 * Con más: cada tipo de servicio tiene su sector, de un ancho según cuántas trampas
 * lleva. El grupo va en el centro de su sector y sus trampas no salen de él: si no
 * caben en un anillo, siguen en el siguiente.
 */
function porSectores(trampas: TrampaMapa[], centro: Tamano): Reparto {
	const grupos = new Map<TipoDeServicio | null, TrampaMapa[]>();
	for (const t of trampas) grupos.set(t.pictograma, [...(grupos.get(t.pictograma) ?? []), t]);
	const orden = [...grupos.entries()].toSorted(
		(a, b) => b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0]))
	);

	/* El anillo de los grupos crece para que quepan todos con su nombre. */
	const conNodo = orden.filter(([, ts]) => ts.length > 1).length;
	const escala = Math.max(
		1,
		(conNodo * SITIO_FAMILIA) / perimetro(ANILLO_FAMILIAS.x, ANILLO_FAMILIAS.y)
	);
	const rf = { x: ANILLO_FAMILIAS.x * escala, y: ANILLO_FAMILIAS.y * escala };

	const total = HASTA - DESDE;
	const pesos = orden.map(([, ts]) => ts.length + 1);
	const suma = pesos.reduce((a, b) => a + b, 0);
	let acumulado = DESDE;
	const sectores = pesos.map((p) => {
		const desde = acumulado;
		acumulado += (total * p) / suma;
		return { desde, hasta: acumulado, medio: (desde + acumulado) / 2 };
	});

	/* Dos grupos seguidos, si se quedan demasiado cerca, se separan sin pisarse. */
	const medios = sectores.map((s) => s.medio);
	const minimo = (48 / perimetro(rf.x, rf.y)) * 360;
	for (let i = 1; i < medios.length; i++) medios[i] = Math.max(medios[i], medios[i - 1] + minimo);
	if (medios.length && medios[medios.length - 1] > HASTA) {
		medios[medios.length - 1] = HASTA;
		for (let i = medios.length - 2; i >= 0; i--)
			medios[i] = Math.min(medios[i], medios[i + 1] - minimo);
	}

	const familias = orden.map(([familia, ts], i) => {
		const p = enElipse(rf.x, rf.y, medios[i]);
		/* Su nombre, solo si cabe entre sus vecinos con nodo. */
		const distancias = medios
			.filter((_, k) => k !== i && orden[k][1].length > 1)
			.map((m) => Math.abs(m - medios[i]));
		const separacion = Math.min(Infinity, ...distancias);
		return {
			familia,
			trampas: ts,
			x: p.x,
			y: p.y,
			conNombre: (separacion / 360) * perimetro(rf.x, rf.y) >= 92
		};
	});

	const ocupado: Caja[] = [
		cajaCentrada(centro),
		...familias
			.filter((f) => f.trampas.length > 1)
			.map((f) => ({ l: f.x - 50, r: f.x + 50, t: f.y - 22, b: f.y + 36 }))
	];

	const hojas: Colocada[] = [];
	const pendientes = orden.map(([, ts]) => [...ts]);
	for (let i = 0; pendientes.some((p) => p.length); i++) {
		const rx = rf.x + SALTO_HOJAS.x + i * PASO_X;
		const ry = rf.y + SALTO_HOJAS.y + i * PASO_Y;
		pendientes.forEach((p, f) => {
			if (!p.length) return;
			const lista = huecosDeArco(rx, ry, sectores[f].desde + 0.5, sectores[f].hasta - 0.5, ocupado);
			const n = Math.min(lista.length, p.length);
			for (const hueco of repartir(lista, n)) {
				hojas.push({ trampa: p.shift()!, ...hueco });
				ocupado.push(hueco.caja);
			}
		});
	}
	return { hojas, familias };
}

/* Un sitio con sus trampas. idCentro: el nodo del propio sitio. */
export function armarGrafo(v: {
	idCentro: string;
	trampas: TrampaMapa[];
	centro: Tamano;
	/* Si con pocas trampas puede quedarse compacto, con ellas debajo. */
	compacto?: boolean;
}): Grafo {
	const { idCentro, trampas, centro } = v;
	const aquiEstan = new Set(trampas.map((t) => t.id));
	const reparto: Reparto = !trampas.length
		? { hojas: [], familias: [] }
		: v.compacto && trampas.length <= MAX_ABANICO
			? abanico(trampas, centro)
			: trampas.length <= MAX_ESTRELLA
				? estrella(trampas, centro)
				: porSectores(trampas, centro);

	/* Lo que ocupa, medido desde el centro. Simétrico a los lados: el sitio queda en medio. */
	const cajas = reparto.hojas.map((h) => h.caja);
	const lado = Math.max(centro.ancho / 2, ...cajas.map((c) => Math.max(-c.l, c.r)));
	const arriba = Math.max(centro.alto / 2, ...cajas.map((c) => -c.t));
	const abajo = Math.max(centro.alto / 2, ...cajas.map((c) => c.b));
	const ancho = lado * 2 + MARGEN * 2;
	const cx = ancho / 2;
	const cy = MARGEN + arriba;

	const nodos: NodoGrafo[] = [{ id: idCentro, tipo: 'centro', x: cx, y: cy }];
	const aristas: AristaGrafo[] = [];
	const padreDe = new Map<string, string>();
	for (const f of reparto.familias) {
		/* Un tipo con una sola trampa no necesita nodo propio: va directa al sitio. */
		if (f.trampas.length < 2) continue;
		const id = `f:${idCentro}:${f.familia}`;
		nodos.push({
			id,
			tipo: 'familia',
			familia: f.familia,
			nombre: f.familia ? FAMILIAS[f.familia] : 'Other',
			trampas: f.trampas,
			conNombre: f.conNombre,
			x: cx + f.x,
			y: cy + f.y
		});
		aristas.push({ de: idCentro, a: id, clase: 'estructura' });
		for (const t of f.trampas) padreDe.set(t.id, id);
	}
	for (const h of reparto.hojas) {
		const id = `t:${h.trampa.id}`;
		nodos.push({ id, tipo: 'trampa', trampa: h.trampa, x: cx + h.x, y: cy + h.y });
		aristas.push({
			de: padreDe.get(h.trampa.id) ?? idCentro,
			a: id,
			clase: claseDeEstado(h.trampa)
		});
		/* Lo sembrado en este mismo sitio que apunta a otra de sus trampas. */
		if (h.trampa.objetivo && aquiEstan.has(h.trampa.objetivo))
			aristas.push({
				de: id,
				a: `t:${h.trampa.objetivo}`,
				clase: h.trampa.ruta?.rele ? 'rele' : 'senal',
				relacion: {
					texto: (h.trampa.ruta?.texto ?? 'Signal').replace(/,? (to|land on)$/, ''),
					destino: h.trampa.ruta?.destino ?? null
				}
			});
	}

	return {
		ancho: Math.round(ancho),
		alto: Math.round(cy + abajo + MARGEN),
		nodos: nodos.map((n) => ({ ...n, x: Math.round(n.x), y: Math.round(n.y) })),
		aristas,
		centro: { x: Math.round(cx), y: Math.round(cy) },
		tamano: centro
	};
}

export const idSensor = (x: Pick<SensorMapa, 'id'>) => `c:${x.id}`;
export const idSistema = (x: Pick<SistemaMapa, 'id'>) => `s:${x.id}`;

/* El sitio de un sensor: su máquina y las trampas que tiene. */
export const grafoDeSensor = (x: SensorMapa) =>
	armarGrafo({ idCentro: idSensor(x), trampas: x.trampas, centro: CENTRO_SENSOR });

/* Un sitio sin sensor: un servidor, una web, una cuenta de nube. */
export const grafoDeSistema = (x: SistemaMapa) =>
	armarGrafo({ idCentro: idSistema(x), trampas: x.trampas, centro: CENTRO_SITIO, compacto: true });

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
		if (n.tipo === 'familia') {
			const r = FAMILIA.circulo / 2 + 5;
			return { x: n.x + (dx / d) * r, y: n.y + (dy / d) * r };
		}
		const k = Math.min(
			dx ? (g.tamano.ancho / 2 + 5) / Math.abs(dx) : Infinity,
			dy ? (g.tamano.alto / 2 + 5) / Math.abs(dy) : Infinity
		);
		return { x: n.x + dx * k, y: n.y + dy * k };
	};
	return { desde: borde(de, hacia), hasta: borde(hacia, de) };
}
