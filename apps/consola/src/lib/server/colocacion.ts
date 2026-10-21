/*
 * La colocación de cada trampa (docs/diseno/modulo-despliegue.md §8): dónde
 * está de verdad, guardado en trampas.colocacion y trampas.colocacion_motivo,
 * y lo que ve el cliente, que se calcula al leer.
 *
 * Las transiciones (§8.1) son puras: reciben lo guardado y lo que acaba de
 * pasar (el plan la deja fuera, el sensor dice cómo ha quedado, llega su
 * primer evento…) y devuelven solo lo que cambia, para que plan(),
 * informarEstado y recibirEventos escriban únicamente cuando hay algo nuevo:
 * cada estado del sensor cae en una sola fila de la tabla y no hay vaivenes.
 *
 * El estado visible (§8.2) no escribe nada: se calcula con lo guardado, el
 * latido y lo que cuenta el sensor de su máquina (avisosSensor) y, en las
 * trampas cuya señal es otra trampa, con el estado de esa otra.
 */
import { and, eq, sql } from 'drizzle-orm';
import { EJECUTORES, motivo, validarParametros, viaDe } from '@sugardaddy/contrato';
import type { Capacidades, Colocacion, Honeycosa, Motivo } from '@sugardaddy/contrato';
import { avisosSensor } from '$lib/capacidades';
import { EN_ESPERA, enEspera } from '$lib/espera';
import { honeycosas } from './catalogo';
import { db, schema as s } from './db';
import { hechosDe } from './hechos';
import type { EstadoTrampa } from './sensor';

/* Las causas por las que plan() deja fuera una trampa (§7.3), con su código de motivos.ts. */
export const DESCARTES_PLAN: readonly string[] = [
	'modulo.desconocido',
	'modulo.no-autorizado',
	'modulo.via-desaparecida',
	'agente.version',
	'carga.imagen-sin-publicar',
	'carga.sin-credencial',
	'parametros.invalidos'
];

/*
 * Los códigos de colocación que no son del elector ni del plan (§8.1): los
 * pone la consola con lo que cuenta el sensor, o al calcular el estado
 * visible. Los del plan y los de la señal por otra trampa (senal.objetivo-*)
 * están en motivos.ts, y un fallo con código propio del sensor (motor.permiso…)
 * se guarda con ese código.
 */
export const MOTIVOS_COLOCACION = {
	'despliegue.error': 'Su sensor no la tiene en marcha.',
	'despliegue.parada': 'El sensor la ha parado.',
	'aislamiento.se-ven':
		'Las trampas de esta máquina se ven entre sí: el motor de contenedores no aplica el aislamiento entre ellas.',
	'red.ip-oculta': 'Las trampas de esta máquina no ven la IP de quien se conecta.',
	'retirada.pendiente':
		'Falta quitarla del destino con sus pasos de retirada y decir aquí que ya está quitada.'
} as const;
export type CodigoColocacion = keyof typeof MOTIVOS_COLOCACION;

/* Lo que se guarda de la colocación de una trampa y decide cómo cambia. */
export type FilaColocacion = {
	colocacion: Colocacion;
	colocacionMotivo: string | null;
	comprobada: Date | null;
	/* false: la ha parado alguien desde la consola. */
	activo: boolean;
	donde: string;
};

/* Lo que cambia: solo las columnas que tienen otro valor. Vacío si no cambia nada. */
export type CambioColocacion = Partial<{
	colocacion: Colocacion;
	colocacionMotivo: string | null;
	colocacionCuando: Date;
	comprobada: Date;
}>;

/* De lo guardado a lo que debería ser: solo lo distinto, y con la hora si cambia algo. */
function hacia(
	f: FilaColocacion,
	colocacion: Colocacion,
	codigo: string | null,
	ahora: Date
): CambioColocacion {
	const c: CambioColocacion = {};
	if (f.colocacion !== colocacion) c.colocacion = colocacion;
	if (f.colocacionMotivo !== codigo) c.colocacionMotivo = codigo;
	if (Object.keys(c).length) c.colocacionCuando = ahora;
	return c;
}

/*
 * plan() la deja fuera (cualquier causa): el sensor borra el contenedor que
 * no viene en el plan, así que deja de estar puesta y queda por colocar con
 * el código del descarte. Una que ya lo estaba solo cambia si cambia el
 * código.
 */
export function trasDescarte(f: FilaColocacion, codigo: string, ahora: Date): CambioColocacion {
	if (f.colocacion === 'retirando') return {};
	return hacia(f, 'por-colocar', codigo, ahora);
}

/*
 * Lo que dicen los sensores 0.12 a 0.13.1 mientras bajan la imagen de una
 * trampa que aún no corre: va como error, pero es lo normal en cada alta en
 * un sensor que aún no la tiene.
 */
const DESCARGANDO = 'error: descargando la imagen';

/* Lo que el sensor dice que ha parado él (la cuota de sus registros): cuenta como un error. */
export const paradaPorSensor = (donde: string) => donde.startsWith('parada: ');

/*
 * Por colocar y en camino: nada la frena. Ni un descarte del plan, ni una
 * parada desde la consola, ni un fallo o una parada de su sensor, que se ve
 * en el motivo (un descarte, despliegue.error, despliegue.parada, motor.*) o
 * en «donde» («en espera: …», «error…», «parada: …» con el motivo nulo, como
 * dejan las filas la 0012 y completarDestinos). Solo una así puede dar por
 * puesta un evento que llega antes que su primer estado; con las demás, el
 * evento viene de la cola del sensor y no dice que ahora esté en marcha.
 */
const enCamino = (f: FilaColocacion) =>
	f.colocacion === 'por-colocar' &&
	f.activo &&
	f.colocacionMotivo === null &&
	!enEspera(f.donde) &&
	!f.donde.startsWith('error') &&
	!paradaPorSensor(f.donde);

/*
 * El estado de la trampa según su sensor (§8.1):
 * - con error (un código, o «donde» empieza por «error» o por «parada: »):
 *   degradada si estaba puesta, y si no, sigue por colocar; con el código del
 *   sensor o, si no lo trae (sensores 0.12 y 0.13), despliegue.error o
 *   despliegue.parada;
 * - sin error y con un aviso que degrada (aislamiento.se-ven): degradada;
 * - limpio: puesta (comprobada si ya llegó algún evento suyo) y sin motivo,
 *   también si ya lo estaba con el código de un descarte de antes.
 * Una trampa fuera del plan no cambia: el estado llega tarde (el sensor aún
 * no tenía el plan nuevo) y el siguiente ya no la trae. Tampoco una que se
 * está retirando.
 */
export function trasEstado(f: FilaColocacion, e: EstadoTrampa, ahora: Date): CambioColocacion {
	if (f.colocacion === 'retirando' || !f.activo || enEspera(f.donde)) return {};
	const parada = paradaPorSensor(e.donde);
	if (e.codigo || e.donde.startsWith('error') || parada) {
		const codigo = e.codigo ?? (parada ? 'despliegue.parada' : 'despliegue.error');
		return hacia(f, f.colocacion === 'por-colocar' ? 'por-colocar' : 'degradada', codigo, ahora);
	}
	if (e.avisos?.includes('aislamiento.se-ven'))
		return hacia(f, 'degradada', 'aislamiento.se-ven', ahora);
	return hacia(f, f.comprobada ? 'comprobada' : 'colocada', null, ahora);
}

/*
 * Su primer evento real (§8.3): fija «comprobada» una sola vez. Una puesta,
 * o por colocar en camino (aún no ha llegado su primer estado), pasa a
 * comprobada. Una degradada, o por colocar con un descarte del plan, parada
 * o con un fallo de su sensor, lo sigue estando: el evento venía de su cola,
 * y el primer estado limpio la dejará comprobada.
 */
export function trasEvento(f: FilaColocacion, recibido: Date): CambioColocacion {
	if (f.comprobada) return {};
	const c: CambioColocacion = { comprobada: recibido };
	if (f.colocacion === 'colocada' || enCamino(f))
		Object.assign(c, hacia(f, 'comprobada', null, recibido));
	return c;
}

/* «Ya está hecho» (manual@1): quien ha seguido los pasos dice que está puesta. */
export function trasHecho(f: FilaColocacion, ahora: Date): CambioColocacion | null {
	return f.colocacion === 'por-colocar' ? hacia(f, 'colocada', null, ahora) : null;
}

/* «Parar» (contenedor@1): el sensor la quita de su máquina hasta que se reanude. */
export function trasParar(f: FilaColocacion, ahora: Date): CambioColocacion {
	return hacia(f, 'por-colocar', null, ahora);
}

/*
 * «Retirar»: con retirada automática (contenedor@1), la fila se borra y el
 * sensor quita el contenedor en su siguiente plan; con retirada confirmada
 * (manual@1), queda retirando hasta que alguien diga que ya la ha quitado.
 */
export function trasRetirar(
	f: FilaColocacion,
	retirada: 'automatica' | 'confirmada',
	ahora: Date
): 'borrar' | CambioColocacion {
	if (retirada === 'automatica') return 'borrar';
	return f.colocacion === 'retirando' ? {} : hacia(f, 'retirando', 'retirada.pendiente', ahora);
}

/* «Ya lo he quitado»: solo desde retirando, y entonces se borra la fila. */
export const trasQuitado = (f: FilaColocacion): 'borrar' | null =>
	f.colocacion === 'retirando' ? 'borrar' : null;

/* ---------------------------------------------------------------------------
 * Estado visible (§8.2)
 * ------------------------------------------------------------------------- */

export type Visible =
	'retirando' | 'parada' | 'sin-contacto' | 'degradada' | 'comprobada' | 'colocada' | 'por-colocar';

/* Cómo se llama cada estado en las listas y en la ficha. */
export const ETIQUETAS: Readonly<Record<Visible, string>> = {
	retirando: 'Retirando',
	parada: 'Parada',
	'sin-contacto': 'Sin contacto',
	degradada: 'Degradada',
	comprobada: 'Comprobada',
	colocada: 'Puesta, sin comprobar',
	'por-colocar': 'Pendiente de poner'
};

export type AvisoVisible = { codigo: string; texto: string };

export interface EstadoVisible {
	estado: Visible;
	etiqueta: string;
	/* El código del motivo (para soporte), o null. */
	codigo: string | null;
	/* Por qué está así, en una frase para el cliente. */
	motivo: string | null;
	/* Lo que contó el sensor, o lo que hay que saber del motivo. */
	detalle: string | null;
	remedio: string | null;
	/* Lo que no cambia el estado pero hay que saber (motor sin garantía, sin root…). */
	avisos: AvisoVisible[];
	/* «Activa» en Inicio, en las listas y en el latido al panel: comprobada y nada más. */
	activa: boolean;
}

/* De una trampa, lo que hace falta para su estado visible. */
export type TrampaColocada = FilaColocacion & {
	id: string;
	nombre: string;
	modulo: string;
	sensor: string;
	ejecutor: string;
	via: string;
	parametros: Record<string, unknown>;
	senalTrampa: string | null;
	/* manual@1: los datos con que se generaron sus pasos (trampas.manual.variables). */
	variables: Record<string, string> | null;
	/* Su señal es otra trampa: sus pasos guardan la marca con que se la reconoce (§8.5). */
	conMarca: boolean;
};

export interface ContextoVisible {
	ahora: number;
	sensores: ReadonlyMap<string, { ultimoLatido: Date | null; capacidades: Capacidades | null }>;
	/* Todas las trampas del cliente, para las que reciben la señal de otra. */
	trampas: ReadonlyMap<string, TrampaColocada>;
	/* La dirección del destino de cada trampa (destino.direccion), si la tiene. */
	direcciones: ReadonlyMap<string, string>;
	honeycosas: ReadonlyMap<string, Honeycosa>;
}

/* El mismo plazo que en Sensores: un sensor que no late en 5 minutos se da por caído. */
const LATIDO_MAXIMO = 5 * 60_000;
const vivo = (ultimo: Date | null | undefined, ahora: number) =>
	!!ultimo && ahora - ultimo.getTime() < LATIDO_MAXIMO;

/* Los avisos de IP oculta que degradan (§8.2); origen.rootless se queda en aviso. */
const IP_OCULTA = new Set(['origen.pasarela', 'origen.desktop', 'origen.wsl']);
/* Una trampa degradada por esto sigue recibiendo: la credencial que apunta a ella también. */
const DEGRADA_SIN_CORTAR = new Set(['red.ip-oculta', 'aislamiento.se-ven']);

/* Un texto del sensor como frase: mayúscula al principio y punto al final. */
function frase(t: string): string {
	const f = t.trim();
	if (!f) return f;
	return f.charAt(0).toLocaleUpperCase('es') + f.slice(1) + (/[.…!?]$/.test(f) ? '' : '.');
}

/* «a», «a y b», «a, b y c». */
const unaLista = (xs: string[]) =>
	xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} y ${xs.at(-1)}`;

/*
 * Lo que dijo el sensor de un fallo, sin el prefijo («error: », «error:
 * motor.permiso: », «parada: »): el detalle para el cliente.
 */
function detalleDe(donde: string, codigo: string | null): string | null {
	let d = donde;
	if (paradaPorSensor(d)) d = d.slice('parada: '.length);
	else if (d.startsWith('error')) {
		d = d.replace(/^error:?\s*/, '');
		if (codigo && d.startsWith(`${codigo}: `)) d = d.slice(codigo.length + 2);
	} else return null;
	return frase(d) || null;
}

/* El texto de un código guardado en colocacion_motivo, con los datos de su trampa. */
function textoDe(codigo: string, t: TrampaColocada, h: Honeycosa | undefined): string {
	if (Object.hasOwn(MOTIVOS_COLOCACION, codigo))
		return MOTIVOS_COLOCACION[codigo as CodigoColocacion];
	if (DESCARTES_PLAN.includes(codigo)) {
		/* Lo mismo que dice el plan, si lo ha escrito tal cual («en espera: …»). */
		if (enEspera(t.donde)) return frase(t.donde.slice(EN_ESPERA.length));
		const via = h && viaDe(h, t.via);
		return motivo(codigo as Motivo['codigo'], {
			modulo: t.modulo,
			nombre: h?.nombre ?? t.modulo,
			minimo: via?.sensorMinimo ?? '',
			errores: 'Sus ajustes ya no valen para el módulo.'
		}).texto;
	}
	/* El código de un fallo del sensor (motor.permiso…): el detalle lo da su «donde». */
	return MOTIVOS_COLOCACION['despliegue.error'];
}

/* Recibe su señal por otra trampa (fuente «trampa», §2.4). */
const porOtraTrampa = (t: TrampaColocada) => t.senalTrampa !== null || t.conMarca;

/* Sigue recibiendo: puesta, o degradada por algo que no la para (IP oculta, se ven). */
export const recibe = (e: EstadoVisible) =>
	e.estado === 'colocada' ||
	e.estado === 'comprobada' ||
	(e.estado === 'degradada' && e.codigo !== null && DEGRADA_SIN_CORTAR.has(e.codigo));

/* Los parámetros de la trampa objetivo, con los valores por defecto de su módulo. */
function parametrosDe(o: TrampaColocada, c: ContextoVisible): Record<string, unknown> {
	const h = c.honeycosas.get(o.modulo);
	const p = h && validarParametros(h.parametros, o.parametros);
	return p && p.ok ? p.valor : o.parametros;
}

/* De una trampa cuya señal es otra, lo que hace falta para saber qué datos de esa otra usa. */
export type DependienteDeSenal = Pick<
	TrampaColocada,
	'via' | 'parametros' | 'senalTrampa' | 'variables'
>;

/*
 * El parámetro que apunta a la trampa objetivo: el de la fuente de su vía
 * (trampa: '${objetivo}') o, si el módulo ya no la tiene, el que guarda su id.
 */
function parametroObjetivo(t: DependienteDeSenal, h: Honeycosa | undefined): string | undefined {
	const fuente = h && viaDe(h, t.via)?.senal.fuente;
	const m = fuente?.tipo === 'trampa' ? /^\$\{([^}.]+)\}$/.exec(fuente.trampa) : null;
	if (m) return m[1];
	return Object.keys(t.parametros).find((k) => t.parametros[k] === t.senalTrampa);
}

/*
 * Los datos de su objetivo con que se generaron sus pasos (§8.2, §8.4): cada
 * objetivo_<campo> de trampas.manual.variables, en orden, con el valor
 * guardado. «direccion» es la del destino del objetivo; el resto, parámetros
 * suyos. h: el módulo de la trampa (no el del objetivo).
 */
export function datosDelObjetivo(
	t: DependienteDeSenal,
	h: Honeycosa | undefined
): { campo: string; guardado: string }[] {
	const p = parametroObjetivo(t, h);
	if (!p || !t.variables) return [];
	return Object.entries(t.variables)
		.filter(([k]) => k.startsWith(`${p}_`))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, guardado]) => ({ campo: k.slice(p.length + 1), guardado }));
}

/* El título de un parámetro de un módulo, para el cliente; si no tiene, su nombre. */
export function tituloDe(h: Honeycosa | undefined, campo: string): string {
	const props = (h?.parametros.properties ?? {}) as Record<string, { title?: unknown }>;
	const titulo = Object.hasOwn(props, campo) ? props[campo].title : undefined;
	return typeof titulo === 'string' ? titulo : campo;
}

/*
 * Lo que ya no es como cuando se generaron los pasos (§8.2): la dirección del
 * destino del objetivo y cada parámetro suyo que usan (objetivo_direccion,
 * objetivo_<parámetro> en trampas.manual.variables).
 */
function datosCambiados(t: TrampaColocada, o: TrampaColocada, c: ContextoVisible): string[] {
	const actuales = parametrosDe(o, c);
	const cambiados: string[] = [];
	for (const { campo, guardado } of datosDelObjetivo(t, c.honeycosas.get(t.modulo))) {
		if (campo === 'direccion') {
			if (c.direcciones.get(o.id) !== guardado) cambiados.push('la dirección de su destino');
			continue;
		}
		const actual = Object.hasOwn(actuales, campo) ? actuales[campo] : undefined;
		if (actual === undefined || String(actual) !== guardado)
			cambiados.push(tituloDe(c.honeycosas.get(o.modulo), campo));
	}
	return cambiados;
}

/* Por qué una trampa cuya señal es otra no avisaría de nada, o null si avisaría. */
function problemaDeSenal(t: TrampaColocada, c: ContextoVisible): Motivo | null {
	const o = t.senalTrampa === null ? undefined : c.trampas.get(t.senalTrampa);
	if (!o) return motivo('senal.objetivo-retirado');
	const eo = estadoVisible(o, c, false);
	if (!recibe(eo))
		return motivo('senal.objetivo-parado', {
			objetivo: o.nombre,
			estado: eo.etiqueta.charAt(0).toLocaleLowerCase('es') + eo.etiqueta.slice(1)
		});
	const cambiados = datosCambiados(t, o, c);
	return cambiados.length
		? motivo('senal.objetivo-cambiado', { objetivo: o.nombre, dato: unaLista(cambiados) })
		: null;
}

function visible(
	estado: Visible,
	x: Partial<Omit<EstadoVisible, 'estado' | 'etiqueta' | 'activa'>> = {}
): EstadoVisible {
	return {
		estado,
		etiqueta: ETIQUETAS[estado],
		codigo: x.codigo ?? null,
		motivo: x.motivo ?? null,
		detalle: x.detalle ?? null,
		remedio: x.remedio ?? null,
		avisos: x.avisos ?? [],
		activa: estado === 'comprobada'
	};
}

/*
 * Lo que ve el cliente de una trampa (§8.2), por este orden:
 * 1. retirando;
 * 2. parada desde la consola;
 * 3. sin contacto: su sensor no late. En una trampa cuya señal es otra trampa
 *    lo dice el punto 4 (su sensor es el de la otra, que se ve sin contacto);
 * 4. señal por otra trampa, si está puesta: degradada si la otra ya no existe,
 *    no recibe o ya no es como cuando se generaron sus pasos. Por colocar, lo
 *    mismo es un aviso;
 * 5. degradada por su máquina (vías en el agente), si está puesta: un fallo
 *    del motor o la IP oculta del motor. Lo demás (sin root, sin garantía…)
 *    es un aviso;
 * 6. lo guardado.
 * conSenal: false al mirar la propia trampa objetivo, para no dar vueltas.
 */
export function estadoVisible(
	t: TrampaColocada,
	c: ContextoVisible,
	conSenal = true
): EstadoVisible {
	const h = c.honeycosas.get(t.modulo);
	if (t.colocacion === 'retirando') {
		const codigo = t.colocacionMotivo ?? 'retirada.pendiente';
		return visible('retirando', { codigo, motivo: textoDe(codigo, t, h) });
	}
	if (!t.activo) return visible('parada', { motivo: 'La han parado desde la consola.' });
	const senal = porOtraTrampa(t);
	const sensor = c.sensores.get(t.sensor);
	if (!senal && !vivo(sensor?.ultimoLatido, c.ahora))
		return visible('sin-contacto', {
			motivo: 'Su sensor no contesta desde hace más de 5 minutos: no se sabe cómo está.'
		});

	const puesta = t.colocacion === 'colocada' || t.colocacion === 'comprobada';
	const avisos: AvisoVisible[] = [];
	if (senal && conSenal) {
		const p = problemaDeSenal(t, c);
		if (p && puesta)
			return visible('degradada', {
				codigo: p.codigo,
				motivo: p.texto,
				remedio: p.remedio ?? null
			});
		if (p) avisos.push({ codigo: p.codigo, texto: p.texto });
	}

	if (EJECUTORES[t.ejecutor]?.corre === 'agente') {
		let degrada: { codigo: string; motivo: string; detalle: string } | null = null;
		for (const a of avisosSensor(sensor?.capacidades)) {
			const codigo =
				a.gravedad === 'error' ? a.codigo : IP_OCULTA.has(a.codigo) ? 'red.ip-oculta' : null;
			if (codigo && puesta && !degrada) degrada = { codigo, motivo: a.titulo, detalle: a.texto };
			else avisos.push({ codigo: a.codigo, texto: a.titulo });
		}
		if (degrada) return visible('degradada', { ...degrada, avisos });
	}

	switch (t.colocacion) {
		case 'comprobada':
			return visible('comprobada', { avisos });
		case 'colocada':
			return visible('colocada', {
				motivo: 'Está puesta, pero aún no ha llegado ningún evento suyo.',
				avisos
			});
		case 'degradada': {
			const codigo = t.colocacionMotivo ?? 'despliegue.error';
			return visible('degradada', {
				codigo,
				motivo: textoDe(codigo, t, h),
				detalle: detalleDe(t.donde, codigo),
				avisos
			});
		}
		default: {
			/*
			 * Por colocar: con el motivo del plan si sigue fuera («en espera: …»)
			 * o con el fallo del sensor, salvo la descarga de su imagen, que es
			 * su sensor poniéndola. Un descarte de antes que ya no está en
			 * espera es que ha vuelto al plan y su sensor la está poniendo.
			 */
			const codigo = t.colocacionMotivo;
			if (codigo === 'despliegue.error' && t.donde.startsWith(DESCARGANDO))
				return visible('por-colocar', {
					codigo,
					motivo: 'Su sensor la está poniendo: está descargando su imagen.',
					avisos
				});
			if (codigo && (!DESCARTES_PLAN.includes(codigo) || enEspera(t.donde)))
				return visible('por-colocar', {
					codigo,
					motivo: textoDe(codigo, t, h),
					detalle: detalleDe(t.donde, codigo),
					avisos
				});
			return visible('por-colocar', {
				motivo:
					EJECUTORES[t.ejecutor]?.corre === 'consola'
						? 'Aún no se ha dicho que esté puesta.'
						: 'Su sensor la está poniendo.',
				avisos
			});
		}
	}
}

/* ---------------------------------------------------------------------------
 * Con la base de datos
 * ------------------------------------------------------------------------- */

/*
 * El estado visible de todas las trampas del cliente, sin escribir nada: tres
 * consultas (trampas, sensores y, solo si alguna recibe la señal de otra, los
 * destinos con su dirección) y el catálogo, también solo si hace falta.
 */
export async function estadosVisibles(ahora = Date.now()): Promise<Map<string, EstadoVisible>> {
	const filas = await db
		.select({
			id: s.trampas.id,
			nombre: s.trampas.nombre,
			modulo: s.trampas.modulo,
			sensor: s.trampas.sensor,
			destino: s.trampas.destino,
			ejecutor: s.trampas.ejecutor,
			via: s.trampas.via,
			activo: s.trampas.activo,
			donde: s.trampas.donde,
			colocacion: s.trampas.colocacion,
			colocacionMotivo: s.trampas.colocacionMotivo,
			comprobada: s.trampas.comprobada,
			parametros: s.trampas.parametros,
			senalTrampa: s.trampas.senalTrampa,
			/* De los pasos guardados, solo lo que hace falta: no se lee el resto. */
			variables: sql<Record<string, string> | null>`${s.trampas.manual} -> 'variables'`,
			conMarca: sql<boolean>`coalesce(${s.trampas.manual} -> 'marca', 'null'::jsonb) <> 'null'::jsonb`
		})
		.from(s.trampas);
	const sensores = await db
		.select({
			id: s.sensores.id,
			ultimoLatido: s.sensores.ultimoLatido,
			capacidades: s.sensores.capacidades
		})
		.from(s.sensores);
	const trampas = new Map(filas.map((f) => [f.id, f]));
	const conSenal = filas.some((f) => f.senalTrampa !== null || f.conMarca);
	const direcciones = new Map<string, string>();
	let catalogo = new Map<string, Honeycosa>();
	if (conSenal) {
		catalogo = new Map(honeycosas().map((h) => [h.id, h]));
		const destinos = await db
			.select({ destino: s.destinos, sensor: s.sensores })
			.from(s.destinos)
			.leftJoin(s.sensores, eq(s.sensores.id, s.destinos.sensor));
		const deDestino = new Map<string, string>();
		const deSensor = new Map<string, string>();
		for (const { destino: d, sensor: x } of destinos) {
			const v = hechosDe(d, x)['destino.direccion']?.valor;
			if (typeof v !== 'string') continue;
			deDestino.set(d.id, v);
			if (d.sensor) deSensor.set(d.sensor, v);
		}
		/* Sin destino (lo dejó así una consola anterior): el de su sensor. */
		for (const f of filas) {
			const v = f.destino ? deDestino.get(f.destino) : deSensor.get(f.sensor);
			if (v !== undefined) direcciones.set(f.id, v);
		}
	}
	const contexto: ContextoVisible = {
		ahora,
		sensores: new Map(sensores.map((x) => [x.id, x])),
		trampas,
		direcciones,
		honeycosas: catalogo
	};
	return new Map(filas.map((f) => [f.id, estadoVisible(f, contexto)]));
}

/* Cuántas trampas están activas de verdad: comprobadas en lo que se ve (§8.2). */
export async function cuentaActivas(): Promise<{ total: number; activas: number }> {
	const e = [...(await estadosVisibles()).values()];
	return { total: e.length, activas: e.filter((x) => x.activa).length };
}

/*
 * Fija «comprobada» con el primer evento real de una trampa (§8.3). Dentro de
 * la entrega, con lo que ya se leyó de la trampa al empezar. Solo si sigue
 * sin fijar: dos entregas a la vez no la mueven dos veces.
 */
export async function comprobarConEvento(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	id: string,
	f: FilaColocacion,
	recibido: Date
): Promise<CambioColocacion> {
	const c = trasEvento(f, recibido);
	if (!Object.keys(c).length) return c;
	await tx
		.update(s.trampas)
		.set(c)
		.where(and(eq(s.trampas.id, id), sql`${s.trampas.comprobada} IS NULL`));
	return c;
}
