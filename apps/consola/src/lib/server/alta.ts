/*
 * Poner y modificar una trampa con el elector (docs/diseno/modulo-despliegue.md
 * §7.3, pasos 9 y 11). El alta tiene dos pasos: «¿dónde?», cada destino activo
 * con lo que diría el elector en modo sondeo, y el formulario de la vía
 * elegida en ese destino, con las otras formas y por qué no valen allí. Al
 * guardar, el elector decide con autoridad, con los valores de verdad y la vía
 * que pidió el cliente, dentro de la misma transacción que guarda la trampa y
 * con el destino bloqueado: dos altas a la vez en el mismo destino no pueden
 * coger el mismo puerto. Una vía de contenedor la pone el sensor del destino;
 * una a mano (manual@1) se guarda con sus pasos, generados con los datos del
 * destino y de la trampa a la que apunta.
 */
import { asc, eq, inArray, sql } from 'drizzle-orm';
import {
	EJECUTORES,
	elegir,
	motivo,
	proyectarParaSensor,
	tipoEvento,
	validarParametros,
	viaDe
} from '@sugardaddy/contrato';
import type {
	CargaContenedor,
	CargaManual,
	ContextoElector,
	Destino,
	Eleccion,
	Honeycosa,
	ManifiestoTrampa,
	Motivo,
	PasosGenerados,
	Via
} from '@sugardaddy/contrato';
import { plataformaDe } from '$lib/destinos';
import { porDireccion } from '$lib/red';
import { noSeCambiaPor } from '$lib/formato';
import { hechosNodo, receptorDelNodo } from './balizas';
import { honeycosas, nombresModulos, textoDeFicha } from './catalogo';
import { datosDelObjetivo, tituloDe } from './colocacion';
import { crearTrampa, modificarTrampa, paraRetirar } from './consultas';
import { db, schema as s } from './db';
import {
	EJECUTORES_CONSOLA,
	destinoDelElector,
	destinoDeSensor,
	enTexto,
	resumenEleccion,
	trampasConPuertos,
	trampasDelCliente,
	type Bd,
	type MotivoVisible,
	type Tx
} from './destinos';
import { DONDE_MANUAL, generarPasos, objetivosDe, opcionesDeObjetivo } from './pasos';
import { sellarPasos } from './sello-pasos';

type Fila = {
	destino: typeof s.destinos.$inferSelect;
	sensor: typeof s.sensores.$inferSelect | null;
};

/* Un destino con la fila de su sensor. */
async function leerDestino(bd: Bd, id: string): Promise<Fila | null> {
	const [f] = await bd
		.select({ destino: s.destinos, sensor: s.sensores })
		.from(s.destinos)
		.leftJoin(s.sensores, eq(s.sensores.id, s.destinos.sensor))
		.where(eq(s.destinos.id, id));
	return f ?? null;
}

/*
 * Bloquea hasta el final de la transacción lo que decide un alta o un cambio
 * (§5.3, §7.3, §8.4): el destino donde se pone (FOR UPDATE: dos altas a la
 * vez no cogen el mismo puerto), la propia trampa si se cambia (FOR UPDATE) y
 * las trampas a las que apunta (x-trampa) con sus destinos (FOR SHARE):
 * mientras se guarda, nadie las retira, las para, les cambia los datos ni
 * cambia la dirección de su destino. Primero los destinos y después las
 * trampas, cada grupo en orden de id: dos que se cruzan no se esperan en
 * círculo.
 */
async function bloquear(
	tx: Tx,
	que: { destino?: string | null; trampa?: string; objetivos?: string[] }
) {
	const objetivos = que.objetivos ?? [];
	const deObjetivos = objetivos.length
		? await tx
				.select({ destino: s.trampas.destino })
				.from(s.trampas)
				.where(inArray(s.trampas.id, objetivos))
		: [];
	const destinos = new Set(deObjetivos.flatMap((f) => (f.destino ? [f.destino] : [])));
	if (que.destino) destinos.add(que.destino);
	for (const id of [...destinos].sort())
		await tx
			.select({ id: s.destinos.id })
			.from(s.destinos)
			.where(eq(s.destinos.id, id))
			.for(id === que.destino ? 'update' : 'share');
	const trampas = new Set(objetivos);
	if (que.trampa) trampas.add(que.trampa);
	for (const id of [...trampas].sort())
		await tx
			.select({ id: s.trampas.id })
			.from(s.trampas)
			.where(eq(s.trampas.id, id))
			.for(id === que.trampa ? 'update' : 'share');
}

/*
 * El contexto del elector en un destino: sus trampas con sus puertos y las del
 * cliente. excepto: la trampa que se cambia, que no choca consigo misma ni con
 * su propia marca.
 */
async function contextoEn(
	bd: Bd,
	destino: string,
	extra: { preferida?: string; excepto?: string; escucha?: string | null } = {}
): Promise<ContextoElector> {
	const catalogo = new Map(honeycosas().map((h) => [h.id, h]));
	const { preferida, excepto, escucha } = extra;
	return {
		autorizado: true,
		ejecutoresConsola: EJECUTORES_CONSOLA,
		hechosNodo: await hechosNodo(bd),
		trampasDelDestino:
			(await trampasConPuertos(catalogo, { destino, excepto }, bd)).get(destino) ?? [],
		trampas: await trampasDelCliente(bd, excepto),
		nombresModulos: nombresModulos(catalogo.values()),
		...(preferida === undefined ? {} : { preferida }),
		/* Sin indicar: aún no se ha elegido (ContextoElector.escucha). */
		...(escucha === undefined ? {} : { escucha })
	};
}

/*
 * Por qué el alta no puede seguir con la vía que vale. La ruta de alta exige,
 * como siempre, un sensor en línea para las vías que corren en el agente (el
 * elector solo avisa: agente.sin-contacto). Los pasos a mano no dependen del
 * sensor del destino: los genera la consola.
 */
function bloqueoDeAlta(ejecutor: string, d: Destino): string | null {
	if (Object.hasOwn(EJECUTORES, ejecutor) && EJECUTORES[ejecutor].corre === 'agente')
		if (d.agente && !d.agente.vivo)
			return `The sensor on ${d.nombre} is not responding right now, and honeypots are deployed while the sensor is online. Come back when it responds.`;
	return null;
}

/* El sensor de un destino en pocas palabras, para las páginas del alta. */
function resumenDestino(f: Fila, d: Destino) {
	return {
		id: d.id,
		nombre: d.nombre,
		tipo: d.tipo,
		plataforma: plataformaDe(d.hechos),
		sensor: f.sensor && { nombre: f.sensor.nombre, vivo: d.agente!.vivo }
	};
}

/*
 * El paso «¿dónde?» (§7.3): cada destino activo con lo que dice el elector en
 * modo sondeo (sin parámetros: con sus valores de serie), con la vía que
 * valdría o el primer motivo. Primero los que valen sin avisos, después los
 * que valen con avisos, los que valen pero ahora no se puede (su sensor no
 * contesta) y al final los que no valen; dentro de cada grupo, en el orden
 * de la lista de Destinos. Tres consultas, tenga el cliente los destinos que
 * tenga.
 */
export const dondePoner = async (h: Honeycosa) => (await sondeoDeDestinos())(h);

/*
 * El sondeo de «¿dónde?» para varias honeycosas a la vez (una plantilla): lee
 * los destinos y su contexto una sola vez y contesta por cada una.
 */
export async function sondeoDeDestinos() {
	const ahora = Date.now();
	const catalogo = new Map(honeycosas().map((x) => [x.id, x]));
	const filas = await db
		.select({ destino: s.destinos, sensor: s.sensores })
		.from(s.destinos)
		.leftJoin(s.sensores, eq(s.sensores.id, s.destinos.sensor))
		.where(eq(s.destinos.activo, true))
		.orderBy(asc(s.destinos.creado), asc(s.destinos.id));
	const puertos = await trampasConPuertos(catalogo);
	const trampas = await trampasDelCliente();
	const nombres = nombresModulos(catalogo.values());
	/* canal.rele es del nodo entero: el mismo para todos los destinos. */
	const nodo = await hechosNodo();
	return (h: Honeycosa) => sondear(h);
	function sondear(h: Honeycosa) {
		const lista = filas.map((f) => {
			const d = destinoDelElector(f.destino, f.sensor, ahora);
			const e = elegir({
				honeycosa: h,
				destino: d,
				parametros: { modo: 'sondeo' },
				contexto: {
					autorizado: true,
					ejecutoresConsola: EJECUTORES_CONSOLA,
					hechosNodo: nodo,
					trampasDelDestino: puertos.get(d.id) ?? [],
					trampas,
					nombresModulos: nombres
				}
			});
			const { elegida, motivo } = resumenEleccion(h, e);
			const bloqueo = elegida ? bloqueoDeAlta(elegida.ejecutor, d) : null;
			/* Con el sensor sin contacto lo dice el bloqueo, y el aviso del elector («se pondrá cuando vuelva») confundiría. */
			if (elegida && bloqueo)
				elegida.avisos = elegida.avisos.filter((a) => a.codigo !== 'agente.sin-contacto');
			return { ...resumenDestino(f, d), elegida, motivo, bloqueo };
		});
		const grupo = (x: (typeof lista)[number]) =>
			!x.elegida ? 3 : x.bloqueo ? 2 : x.elegida.avisos.length ? 1 : 0;
		return lista
			.map((x, i) => ({ x, i }))
			.sort((a, b) => grupo(a.x) - grupo(b.x) || a.i - b.i)
			.map(({ x }) => x);
	}
}

/*
 * Lo que harás en el destino con una vía a mano, antes de rellenar nada: el
 * texto de cada paso con lo que irá en cada hueco dicho con las palabras del
 * cliente (textoDeFicha). Los pasos de verdad, con los datos, salen al guardar.
 */
function pasosDeVia(h: Honeycosa, via: Via) {
	const carga = via.carga as CargaManual;
	return {
		lenguaje: carga.lenguaje,
		pasos: carga.pasos.map((p) => textoDeFicha(p.texto, h)),
		retirada:
			via.retirada.tipo === 'manual' ? via.retirada.pasos.map((p) => textoDeFicha(p.texto, h)) : []
	};
}

/*
 * El formulario del alta en un destino: la vía que elige el elector en modo
 * sondeo (la que pidió el cliente, si vale), las demás con sus motivos, por
 * qué no se puede seguir si es el caso y, en una vía de contenedor, el
 * manifiesto v1 que recibirá el sensor; en una a mano, lo que harás y las
 * trampas a las que puede apuntar. null si el destino no existe.
 */
export async function formaEn(h: Honeycosa, destino: string, preferida?: string) {
	const f = await leerDestino(db, destino);
	if (!f) return null;
	const d = destinoDelElector(f.destino, f.sensor);
	const contexto = await contextoEn(db, d.id, { preferida });
	const e = elegir({ honeycosa: h, destino: d, parametros: { modo: 'sondeo' }, contexto });
	const eleccion = resumenEleccion(h, e);
	const via = eleccion.elegida && viaDe(h, eleccion.elegida.via);
	let manifiesto: ManifiestoTrampa | null = null;
	if (via?.ejecutor === 'contenedor@1') {
		/* Lo que se enseña, sin la imagen pública alternativa (no sale de la consola). */
		const m = proyectarParaSensor(h, via.id);
		if (m.contenedor) delete m.contenedor.imagenPublica;
		manifiesto = m;
	}
	return {
		destino: resumenDestino(f, d),
		eleccion,
		bloqueo: via ? bloqueoDeAlta(via.ejecutor, d) : null,
		manifiesto,
		pasos: via?.ejecutor === 'manual@1' ? pasosDeVia(h, via) : null,
		objetivos: opcionesDeObjetivo(h, contexto.trampas),
		/* Las direcciones de esa máquina entre las que elegir dónde escucha; vacía si no se elige. */
		direcciones: via ? direccionesParaElegir(via, d) : []
	};
}

/*
 * Las direcciones de la máquina de un destino entre las que se puede elegir
 * dónde se publica una trampa de contenedor: las que cuenta su sensor, si sabe
 * publicar en una sola (sensor.escuchaPorTrampa). Vacía con una trampa de «IP
 * propia» (ya tiene la suya) o de otra vía.
 */
function direccionesParaElegir(via: Via, d: Destino): string[] {
	if (via.ejecutor !== 'contenedor@1' || (via.carga as CargaContenedor).red) return [];
	if (d.hechos['sensor.escuchaPorTrampa']?.valor !== true) return [];
	const v = d.hechos['red.direcciones']?.valor;
	return Array.isArray(v)
		? v.filter((x): x is string => typeof x === 'string').sort(porDireccion)
		: [];
}

/*
 * Las direcciones de la máquina de un destino entre las que repartir las trampas
 * de un módulo (una plantilla con «una por dirección»), y las que ya tiene
 * cogidas alguna trampa de ese destino. Vacías si ahí no se elige.
 */
export async function direccionesDeDestino(
	h: Honeycosa,
	destino: string
): Promise<{ direcciones: string[]; usadas: string[] }> {
	const f = await leerDestino(db, destino);
	if (!f) return { direcciones: [], usadas: [] };
	const d = destinoDelElector(f.destino, f.sensor);
	const e = elegir({
		honeycosa: h,
		destino: d,
		parametros: { modo: 'sondeo' },
		contexto: await contextoEn(db, d.id)
	});
	const via = e.elegida ? viaDe(h, e.elegida.via) : undefined;
	if (!via) return { direcciones: [], usadas: [] };
	const usadas = await db
		.selectDistinct({ escucha: s.trampas.escucha })
		.from(s.trampas)
		.where(
			sql`${s.trampas.destino} = ${d.id} and ${s.trampas.activo} and ${s.trampas.escucha} is not null`
		);
	return {
		direcciones: direccionesParaElegir(via, d),
		usadas: usadas.map((u) => u.escucha!).filter(Boolean)
	};
}

/*
 * Para la ficha de una trampa de contenedor: dónde escucha hoy (null, en todas)
 * y las direcciones de su máquina entre las que se puede cambiar. null si ahí
 * no hay nada que elegir (una sola dirección y escuchando en todas, otra vía,
 * un sensor que aún no sabe).
 */
export async function opcionesDeEscucha(t: FilaTrampa, h: Honeycosa) {
	const via = viaDe(h, t.via);
	const destino = await destinoDe(db, t);
	const f = destino ? await leerDestino(db, destino) : null;
	if (!via || !f) return null;
	const direcciones = direccionesParaElegir(via, destinoDelElector(f.destino, f.sensor));
	if (t.escucha && !direcciones.includes(t.escucha)) direcciones.push(t.escucha);
	direcciones.sort(porDireccion);
	if (direcciones.length < 2 && !t.escucha) return null;
	return { actual: t.escucha ?? null, direcciones };
}

export type FalloAlta = { errores: string[]; motivos: MotivoVisible[] };
const fallo = (errores: string[], motivos: Motivo[] = []): FalloAlta => ({
	errores,
	motivos: motivos.map(enTexto)
});

/*
 * Los motivos de la vía pedida (o, si no se pidió ninguna, de la primera del
 * manifiesto) cuando el elector no la elige; si afecta a todas, el global.
 */
function motivosDe(e: Eleccion, via: string | undefined): Motivo[] {
	if (e.global && e.global.codigo !== 'elector.sin-via') return [e.global];
	const x = via === undefined ? e.descartadas[0] : e.descartadas.find((v) => v.via === via);
	return x?.motivos.length ? x.motivos : e.global ? [e.global] : [];
}

/*
 * Lo que se guarda de una trampa a mano (manual@1, §6.3, §8.5): sus pasos,
 * generados con los datos del destino y de la trampa a la que apunta, y quién
 * recibe su señal. Con la fuente «trampa», el sensor de esa otra trampa (sus
 * eventos son los de ella) y senal_trampa = su id; con otra fuente
 * (registros, relé, conector: llegan con el módulo de control), el sensor del
 * destino. balizaUrl es la URL de su baliza —la recién acuñada al darla de
 * alta, la guardada al regenerar (§2.5.2 de la tanda de conectores)— para
 * que los pasos de las vías de nube peguen ${baliza_url}; null si no acuña.
 * Unos valores que renderizar no acepta vuelven como parametros.invalidos.
 */
async function conPasos(
	tx: Tx,
	h: Honeycosa,
	via: Via,
	d: Destino,
	trampa: { id: string; nombre: string },
	parametros: Record<string, unknown>,
	balizaUrl: string | null
): Promise<
	{ sensor: string; senalTrampa: string | null; manual: PasosGenerados; donde: string } | FalloAlta
> {
	const fuente = via.senal.fuente;
	let sensor = d.agente?.sensor ?? null;
	let senalTrampa: string | null = null;
	if (fuente.tipo === 'trampa') {
		const p = /^\$\{([^}.]+)\}$/.exec(fuente.trampa)?.[1];
		const id = p === undefined ? undefined : parametros[p];
		const [o] =
			typeof id === 'string'
				? await tx
						.select({ id: s.trampas.id, sensor: s.trampas.sensor })
						.from(s.trampas)
						.where(eq(s.trampas.id, id))
				: [];
		if (!o) return fallo(['The honeypot it points to no longer exists: choose another.']);
		sensor = o.sensor;
		senalTrampa = o.id;
	} else if (fuente.tipo === 'rele') {
		/*
		 * Una baliza de fichero la recibe el sensor con el receptor del nodo, que
		 * puede no ser el del destino donde se deja el documento (un fileserver
		 * sin sensor). Su señal la recibe ese sensor.
		 */
		const r = await receptorDelNodo(tx);
		if (!r) return fallo(['This node has no deployed and verified beacon receiver.']);
		sensor = r.sensor;
	}
	if (!sensor) return fallo([`Nothing would receive its signal on ${d.nombre}.`]);
	const r = await generarPasos(tx, h, via, trampa, d, parametros, balizaUrl);
	if (!r.ok) return fallo([], [motivo('parametros.invalidos', { errores: r.errores.join('; ') })]);
	/* El sello autentica los pasos con la clave del nodo (BAL-10): sin clave, van sin él. */
	const sello = sellarPasos(r.valor.sha256);
	const manual = sello ? { ...r.valor, sello } : r.valor;
	return { sensor, senalTrampa, manual, donde: DONDE_MANUAL };
}

/*
 * Guardar el alta (§7.3, «al guardar»): con el destino y lo que decide el
 * alta bloqueados, el elector en modo reales con los valores ya validados y
 * la vía pedida como preferida. Si esa vía no vale, no se guarda nada y
 * vuelven sus motivos. La trampa queda con su destino, su vía (con el id de
 * hoy, aunque se pidiera por un «antes») y su ejecutor; una de contenedor,
 * con el sensor que la despliega, y una a mano, con sus pasos (con-pasos).
 */
export async function darDeAlta(
	quien: string,
	v: {
		honeycosa: Honeycosa;
		id: string;
		nombre: string;
		destino: string;
		via?: string;
		parametros: Record<string, unknown>;
		/* La plantilla desde la que se pone, para agruparla con las demás de ella. */
		plantilla?: string;
		/* La dirección de la máquina en la que se publica (contenedor); sin ella, en todas. */
		escucha?: string | null;
	}
): Promise<'creada' | 'con-pasos' | FalloAlta> {
	const h = v.honeycosa;
	const pedida = v.via === undefined ? undefined : viaDe(h, v.via);
	if (v.via !== undefined && !pedida)
		return fallo(['That deployment method does not exist in this module.']);
	return db.transaction(async (tx) => {
		await bloquear(tx, { destino: v.destino, objetivos: objetivosDe(h, v.parametros) });
		const f = await leerDestino(tx, v.destino);
		if (!f) return fallo(['Target: that target no longer exists; choose another.']);
		const d = destinoDelElector(f.destino, f.sensor);
		const e = elegir({
			honeycosa: h,
			destino: d,
			parametros: { modo: 'reales', valor: { ok: true, valor: v.parametros } },
			/* Al guardar ya está elegida: una dirección o, sin ella, todas (nunca «sin indicar»). */
			contexto: await contextoEn(tx, d.id, {
				...(pedida ? { preferida: pedida.id } : {}),
				escucha: v.escucha?.trim() || null
			})
		});
		const via = pedida ?? (e.elegida ? viaDe(h, e.elegida.via) : undefined);
		if (!e.elegida || !via || e.elegida.via !== via.id) return fallo([], motivosDe(e, via?.id));
		const bloqueo = bloqueoDeAlta(via.ejecutor, d);
		if (bloqueo) return fallo([bloqueo]);
		const fila = {
			id: v.id,
			nombre: v.nombre,
			modulo: h.id,
			tipo: tipoEvento(h),
			destino: d.id,
			via: via.id,
			ejecutor: via.ejecutor,
			parametros: v.parametros,
			...(v.plantilla ? { plantilla: v.plantilla } : {})
		};
		const repetida = fallo(['Identifier: a honeypot with that name already exists']);
		if (via.ejecutor === 'manual@1') {
			/*
			 * El acuñado del documento cebo (honeycosas de fichero) y el token de
			 * las de nube son una pieza de pago, ausente en la edición community:
			 * el alta a mano solo genera los pasos (sin ${baliza_url} que pegar) y
			 * crea la trampa.
			 */
			const x = await conPasos(tx, h, via, d, { id: v.id, nombre: v.nombre }, v.parametros, null);
			if ('errores' in x) return x;
			if (!(await crearTrampa(quien, { ...fila, ...x }, tx))) return repetida;
			return 'con-pasos';
		}
		/* contenedor@1: la despliega el sensor del destino (sin él, el elector ya da agente.falta). */
		const sensor = d.agente?.sensor;
		if (!sensor) return fallo([`A sensor is required on ${d.nombre}.`]);
		const escucha = v.escucha?.trim() || null;
		return (await crearTrampa(quien, { ...fila, sensor, escucha }, tx)) ? 'creada' : repetida;
	});
}

type FilaTrampa = typeof s.trampas.$inferSelect;

/* El destino de una trampa: el suyo o, si una consola anterior la dejó sin destino, el de su sensor. */
async function destinoDe(bd: Bd, t: Pick<FilaTrampa, 'destino' | 'sensor'>) {
	return t.destino ?? (await destinoDeSensor(t.sensor, bd))?.id ?? null;
}

/*
 * Cambiar una trampa a mano que aún no está puesta, o volver a generar sus
 * pasos con los datos de hoy (§6.3: «mientras está por colocar, cambiar
 * parámetros vuelve a generar los pasos»; §8.2: si la trampa a la que apunta
 * ha cambiado, lo sembrado aún no está y se puede generar de nuevo). Con el
 * elector en modo reales, como al darla de alta, y sin su propia marca entre
 * las del objetivo. Una ya puesta no se cambia: se retira y se pone otra.
 */
export async function regenerarPasos(
	quien: string,
	id: string,
	h: Honeycosa,
	v: { nombre: string; parametros: Record<string, unknown> }
): Promise<'generados' | FalloAlta> {
	return db.transaction(async (tx: Tx) => {
		const [antes] = await tx.select().from(s.trampas).where(eq(s.trampas.id, id));
		if (!antes) return fallo(['That honeypot no longer exists.']);
		const destino = await destinoDe(tx, antes);
		await bloquear(tx, { destino, trampa: id, objetivos: objetivosDe(h, v.parametros) });
		const [t] = await tx.select().from(s.trampas).where(eq(s.trampas.id, id));
		if (!t || t.ejecutor !== 'manual@1') return fallo(['This honeypot is not deployed manually.']);
		if (t.colocacion !== 'por-colocar')
			return fallo([
				'It has already been marked as deployed: a manually deployed honeypot cannot be changed. Remove it and deploy another.'
			]);
		const via = viaDe(h, t.via);
		const f = destino ? await leerDestino(tx, destino) : null;
		if (!via || via.ejecutor !== 'manual@1')
			return fallo([
				'The method it was deployed with no longer exists in the module: remove it and deploy it again.'
			]);
		if (!f) return fallo(['Its target no longer exists: remove it.']);
		const d = destinoDelElector(f.destino, f.sensor);
		const e = elegir({
			honeycosa: h,
			destino: d,
			parametros: { modo: 'reales', valor: { ok: true, valor: v.parametros } },
			contexto: await contextoEn(tx, d.id, { preferida: via.id, excepto: id })
		});
		if (e.elegida?.via !== via.id) return fallo([], motivosDe(e, via.id));
		/* En community no hay balizas (pieza de pago): al regenerar los pasos no
		 * hay URL de baliza que pegar. */
		const x = await conPasos(tx, h, via, d, { id, nombre: v.nombre }, v.parametros, null);
		if ('errores' in x) return x;
		await tx
			.update(s.trampas)
			.set({
				nombre: v.nombre,
				parametros: v.parametros,
				via: via.id,
				sensor: x.sensor,
				senalTrampa: x.senalTrampa,
				manual: x.manual
			})
			.where(eq(s.trampas.id, id));
		await tx.insert(s.auditoria).values({
			quien,
			accion: 'steps regenerated',
			detalle: {
				id,
				nombre: v.nombre,
				parametros: v.parametros,
				pasos: x.manual.sha256,
				...(t.manual ? { antes: t.manual.sha256 } : {}),
				retirar: paraRetirar(x.manual)
			}
		});
		return 'generados';
	});
}

/*
 * Cambiar de sitio una trampa a mano sin retirarla: el destino donde está. La
 * vía con que se puso tiene que valer en el nuevo (el mismo sistema, un tipo
 * de destino que admita): si el elector no la elige allí, no se mueve y
 * vuelven sus motivos. Por colocar, sus pasos se generan otra vez para el
 * nuevo destino, como al darla de alta. Puesta, solo cambia el destino: lo
 * sembrado es lo que se siguió, así que sus pasos de retirar y quien recibe su
 * señal se quedan como están. Una de contenedor no se mueve: corre en la
 * máquina de su sensor.
 */
export async function cambiarSitio(
	quien: string,
	id: string,
	h: Honeycosa,
	nuevo: string,
	parametros: Record<string, unknown>
): Promise<'movida' | FalloAlta> {
	return db.transaction(async (tx: Tx) => {
		await bloquear(tx, { destino: nuevo, trampa: id, objetivos: objetivosDe(h, parametros) });
		const [t] = await tx.select().from(s.trampas).where(eq(s.trampas.id, id));
		if (!t) return fallo(['That honeypot no longer exists.']);
		if (t.ejecutor !== 'manual@1')
			return fallo([
				"A container honeypot runs on its sensor's machine: to move it, remove it and deploy it on the other one."
			]);
		if (t.colocacion === 'retirando')
			return fallo(['It is being removed: finish removing it, or deploy it again elsewhere.']);
		const viejo = await destinoDe(tx, t);
		if (viejo === nuevo) return fallo(['It is already on that target.']);
		const via = viaDe(h, t.via);
		if (!via || via.ejecutor !== 'manual@1')
			return fallo([
				'The method it was deployed with no longer exists in the module: remove it and deploy it again.'
			]);
		const f = await leerDestino(tx, nuevo);
		if (!f || !f.destino.activo) return fallo(['That target no longer exists.']);
		const d = destinoDelElector(f.destino, f.sensor);
		const e = elegir({
			honeycosa: h,
			destino: d,
			parametros: { modo: 'reales', valor: { ok: true, valor: parametros } },
			contexto: await contextoEn(tx, d.id, { preferida: via.id, excepto: id })
		});
		if (e.elegida?.via !== via.id) return fallo([], motivosDe(e, via.id));
		const detalle = { id, nombre: t.nombre, de: viejo, a: nuevo, colocacion: t.colocacion };
		if (t.colocacion === 'por-colocar') {
			const x = await conPasos(tx, h, via, d, { id, nombre: t.nombre }, parametros, null);
			if ('errores' in x) return x;
			await tx
				.update(s.trampas)
				.set({
					destino: nuevo,
					sensor: x.sensor,
					senalTrampa: x.senalTrampa,
					manual: x.manual
				})
				.where(eq(s.trampas.id, id));
			await tx.insert(s.auditoria).values({
				quien,
				accion: 'decoy moved',
				detalle: {
					...detalle,
					pasos: x.manual.sha256,
					...(t.manual ? { antes: t.manual.sha256 } : {}),
					retirar: paraRetirar(x.manual)
				}
			});
			return 'movida';
		}
		await tx.update(s.trampas).set({ destino: nuevo }).where(eq(s.trampas.id, id));
		await tx.insert(s.auditoria).values({ quien, accion: 'decoy moved', detalle });
		return 'movida';
	});
}

/*
 * Lo que dice el elector de una trampa de contenedor@1 ya puesta, con unos
 * valores (los suyos o los nuevos), sin ella entre las del destino (§7.3,
 * «modificar»). Solo impide guardar lo que depende de lo que se cambia: los
 * parámetros (ya validados antes) y los puertos (puertos.*). Lo demás describe
 * la máquina o el módulo, que no cambian al modificar (motor, IP real,
 * versión del sensor, imagen, credencial): la trampa ya está puesta, el plan
 * no reevalúa requisitos (§13, punto 6) y sale como aviso.
 */
async function eleccionAlModificar(
	bd: Bd,
	t: FilaTrampa,
	h: Honeycosa,
	parametros: Record<string, unknown>,
	/* La dirección nueva, si lo que se cambia es dónde escucha; sin indicar, la que tiene. */
	escucha?: string | null
): Promise<{ bloquean: Motivo[]; avisos: Motivo[] }> {
	const destino = await destinoDe(bd, t);
	const f = destino ? await leerDestino(bd, destino) : null;
	const via = viaDe(h, t.via);
	if (!f || !via) return { bloquean: [], avisos: [] };
	const e = elegir({
		honeycosa: h,
		destino: destinoDelElector(f.destino, f.sensor),
		parametros: { modo: 'reales', valor: { ok: true, valor: parametros } },
		contexto: await contextoEn(bd, f.destino.id, {
			preferida: via.id,
			excepto: t.id,
			escucha: escucha === undefined ? t.escucha : escucha
		})
	});
	const x = [...e.validas, ...e.descartadas].find((y) => y.via === via.id);
	const motivos = x?.motivos ?? (e.global ? [e.global] : []);
	const dePuertos = (m: Motivo) => m.codigo.startsWith('puertos.');
	return {
		bloquean: motivos.filter(dePuertos),
		avisos: [...motivos.filter((m) => !dePuertos(m)), ...(x?.avisos ?? [])]
	};
}

/* Para la página de ajustes de una trampa: lo que avisa hoy el elector con sus valores. */
export async function avisosDeTrampa(
	t: FilaTrampa,
	h: Honeycosa,
	parametros: Record<string, unknown>
) {
	const { bloquean, avisos } = await eleccionAlModificar(db, t, h, parametros);
	return [...bloquean, ...avisos].map(enTexto);
}

/*
 * Lo sembrado que apunta a una trampa con alguno de los ajustes que cambian
 * (§8.4): las trampas con senal_trampa = ella cuyos pasos se generaron con
 * esos valores (un objetivo_<parámetro> en trampas.manual.variables). Cambiar
 * otros ajustes, o el nombre, no les afecta. Devuelve sus nombres y los
 * títulos de los ajustes, o null si no hay ninguna.
 */
async function sembradoQueUsa(
	tx: Tx,
	id: string,
	h: Honeycosa,
	antes: Record<string, unknown>,
	despues: Record<string, unknown>
): Promise<{ dependientes: string[]; ajustes: string[] } | null> {
	const filas = await tx
		.select({
			nombre: s.trampas.nombre,
			modulo: s.trampas.modulo,
			via: s.trampas.via,
			parametros: s.trampas.parametros,
			senalTrampa: s.trampas.senalTrampa,
			variables: sql<Record<string, string> | null>`${s.trampas.manual} -> 'variables'`
		})
		.from(s.trampas)
		.where(eq(s.trampas.senalTrampa, id))
		.orderBy(asc(s.trampas.nombre));
	if (!filas.length) return null;
	const catalogo = new Map(honeycosas().map((x) => [x.id, x]));
	const viejo = validarParametros(h.parametros, antes);
	const valorDe = (p: Record<string, unknown>, k: string) =>
		Object.hasOwn(p, k) && p[k] !== undefined ? String(p[k]) : undefined;
	const cambia = (k: string) => valorDe(viejo.ok ? viejo.valor : antes, k) !== valorDe(despues, k);
	const dependientes: string[] = [];
	const ajustes = new Set<string>();
	for (const f of filas) {
		const usados = datosDelObjetivo(f, catalogo.get(f.modulo))
			.map((x) => x.campo)
			.filter((k) => k !== 'direccion' && cambia(k));
		if (!usados.length) continue;
		dependientes.push(f.nombre);
		for (const k of usados) ajustes.add(tituloDe(h, k));
	}
	return dependientes.length ? { dependientes, ajustes: [...ajustes] } : null;
}

/*
 * Modificar una trampa de contenedor@1 (§7.3): con su destino y la propia
 * trampa bloqueados, el elector con los valores nuevos; si choca algún
 * puerto, no se guarda y vuelven sus motivos. Tampoco se cambia un ajuste con
 * que se generó lo sembrado que apunta a ella (§8.4: el puerto de una Cowrie
 * al que apunta una credencial): vuelven sus nombres.
 */
export async function modificarConElector(
	quien: string,
	t: FilaTrampa,
	h: Honeycosa,
	v: { nombre: string; parametros: Record<string, unknown> }
): Promise<'modificada' | FalloAlta> {
	return db.transaction(async (tx: Tx) => {
		await bloquear(tx, { destino: await destinoDe(tx, t), trampa: t.id });
		const [ahora] = await tx.select().from(s.trampas).where(eq(s.trampas.id, t.id));
		if (!ahora) return fallo(['That honeypot no longer exists.']);
		const sembrado = await sembradoQueUsa(tx, t.id, h, ahora.parametros, v.parametros);
		if (sembrado) return fallo([noSeCambiaPor(sembrado.dependientes, sembrado.ajustes)]);
		const { bloquean } = await eleccionAlModificar(tx, ahora, h, v.parametros);
		if (bloquean.length) return fallo([], bloquean);
		await modificarTrampa(quien, t.id, v, tx);
		return 'modificada';
	});
}

/*
 * Cambiar la dirección de la máquina en la que se publica una trampa de
 * contenedor: una de las de su sensor o, con null, todas. Con el destino y la
 * trampa bloqueados y el elector con la dirección nueva: si ahí choca un puerto
 * con otra trampa, o la dirección no es de esa máquina, no se guarda y vuelven
 * sus motivos. El sensor la rehace al leer el plan.
 */
export async function cambiarEscucha(
	quien: string,
	t: FilaTrampa,
	h: Honeycosa,
	escucha: string | null
): Promise<'modificada' | FalloAlta> {
	const nueva = escucha?.trim() || null;
	if (t.ejecutor !== 'contenedor@1')
		return fallo(['Only a honeypot that runs on a sensor has a listening address.']);
	return db.transaction(async (tx: Tx) => {
		await bloquear(tx, { destino: await destinoDe(tx, t), trampa: t.id });
		const [ahora] = await tx.select().from(s.trampas).where(eq(s.trampas.id, t.id));
		if (!ahora) return fallo(['That honeypot no longer exists.']);
		if ((ahora.escucha ?? null) === nueva) return 'modificada';
		const { bloquean } = await eleccionAlModificar(tx, ahora, h, ahora.parametros, nueva);
		if (bloquean.length) return fallo([], bloquean);
		await tx
			.update(s.trampas)
			.set({ escucha: nueva, donde: 'aplicando cambios…' })
			.where(eq(s.trampas.id, t.id));
		await tx.insert(s.auditoria).values({
			quien,
			accion: 'decoy listening address changed',
			detalle: { id: t.id, escucha: nueva }
		});
		return 'modificada';
	});
}
