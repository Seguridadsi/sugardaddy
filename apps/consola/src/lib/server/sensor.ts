/*
 * Lo que la consola habla con sus sensores. El sensor siempre pregunta: pide su
 * plan (estado deseado), informa de cómo ha quedado y entrega sus eventos. La
 * consola nunca abre una conexión hacia él.
 */
import { createHash } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
	compararVersiones,
	licenciaPermite,
	verificarLicencia,
	type Licencia
} from '@sugardaddy/canal';
import { env } from '$env/dynamic/private';
import {
	CODIGO,
	hashEvento,
	motivo,
	proyectarParaSensor,
	validarEvento,
	validarParametros,
	viaDe
} from '@sugardaddy/contrato';
import type {
	Capacidades,
	CodigoMotivo,
	DatosMotivo,
	Evento,
	ManifiestoTrampa,
	MotorSensor
} from '@sugardaddy/contrato';
import { EN_ESPERA, enEspera } from '../espera';
import { licenciaGuardada } from './canal';
import { autorizados, esDePago, honeycosas } from './catalogo';
import { comprobarConEvento, trasDescarte, trasEstado, type FilaColocacion } from './colocacion';
import { db, schema as s } from './db';
import { preparar } from './credenciales';
import { anotarPrueba, pruebasAbiertas, pruebasDe } from './pruebas';

export const LIMITE_LINEAS = 500;
export const LIMITE_LINEA = 128 * 1024;
/*
 * Lo más que puede pesar una entrega. Tiene que cuadrar con BODY_SIZE_LIMIT
 * del servidor (Dockerfile): si el servidor la cortara antes, el sensor
 * repetiría el mismo lote para siempre.
 */
export const LIMITE_ENTREGA = 16 * 1024 * 1024;

/* Postgres no guarda el carácter NUL en un texto: se cambia por U+FFFD. */
const sinNulos = (t: string) => t.replace(/\u0000/g, '\uFFFD');

/* El token llega en Authorization: Bearer. Se busca por su hash; el token en claro no se guarda. */
export async function sensorDe(request: Request) {
	const token = request.headers
		.get('authorization')
		?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1];
	if (!token) error(401, 'Falta el token del sensor');
	const hash = createHash('sha256').update(token).digest('hex');
	const [sensor] = await db.select().from(s.sensores).where(eq(s.sensores.claveHash, hash));
	if (!sensor) error(401, 'Token desconocido');
	await db.update(s.sensores).set({ ultimoLatido: new Date() }).where(eq(s.sensores.id, sensor.id));
	return sensor;
}

export type TrampaPlan = {
	id: string;
	nombre: string;
	manifiesto: ManifiestoTrampa;
	parametros: Record<string, unknown>;
};

/*
 * Una trampa que el plan deja fuera, con el código de su motivo (motivos.ts,
 * docs/diseno/modulo-despliegue.md §7.4) y el texto para el cliente. El
 * sensor solo lee id y motivo.
 */
export type Descarte = { id: string; codigo: CodigoMotivo; motivo: string };

const esVersion = (v: string) => /^\d+\.\d+\.\d+$/.test(v);

/*
 * El texto de un descarte, que va tras «en espera: » (§7.4): el de
 * motivos.ts con la primera letra en minúscula y sin el punto final, que son
 * las palabras de siempre. parametros.invalidos son los errores de
 * validarParametros tal cual, y modulo.no-autorizado conserva el texto de
 * siempre en el plan: el de motivos.ts («… no entra en tu suscripción») es el
 * del elector.
 */
export function textoDescarte(codigo: CodigoMotivo, datos: DatosMotivo = {}): string {
	if (codigo === 'modulo.no-autorizado') return `el módulo ${datos.modulo} no está autorizado`;
	const t = motivo(codigo, datos).texto;
	if (codigo === 'parametros.invalidos') return t;
	return t[0].toLowerCase() + t.slice(1).replace(/\.$/, '');
}

/*
 * Lo nuevo que esta consola acepta en lo que le manda el sensor. Va en el
 * plan: un sensor solo lo usa si su consola lo dice, porque una anterior
 * apartaría a la cuarentena un evento con un campo que no conoce.
 * origen.oculta: la IP del evento es la del motor de contenedores (0.13.1).
 */
export const ADMITE = ['origen.oculta'];

/*
 * Un sensor sin credencial del registro privado (anterior a la 0.12.1, o de un
 * actualizador antiguo aún sin relevo) no puede descargar la imagen propia y,
 * si la recibe, se queda sin trampa: se le manda la pública, si la hay.
 * imagenPublica no sale de la consola, para no mezclar.
 */
function manifiestoPara(m: ManifiestoTrampa, registroPrivado: boolean): ManifiestoTrampa {
	if (!m.contenedor?.imagenPublica) return m;
	const { imagenPublica, ...c } = m.contenedor;
	return { ...m, contenedor: registroPrivado ? c : { ...c, imagen: imagenPublica } };
}

/*
 * El plan solo lleva lo que el sensor sabe desplegar (las trampas de
 * contenedor@1; las demás no son suyas y ni se miran) y, de cada una, el
 * manifiesto v1 de su vía (proyectarParaSensor, §2.6) con los parámetros ya
 * validados y completados con sus valores por defecto. Una trampa que no se
 * le puede mandar se queda fuera y se dice por qué, con su código: al
 * sensor, y en la propia trampa (ver anotarEspera). El plan no reevalúa
 * requisitos: solo retira por estas causas (§7.3). registroPrivado: el
 * sensor anuncia que puede descargar del registro privado.
 */
export async function plan(sensor: string, registroPrivado: boolean, versionSensor?: string) {
	const catalogo = new Map(honeycosas().map((h) => [h.id, h]));
	const permitidos = new Set(await autorizados());
	/*
	 * El candado de licencia en la consola (capa 4, defensa en profundidad): la
	 * de verdad está dentro del binario cerrado de cada trampa de pago, pero aquí
	 * no se mete en el plan una trampa de pago sin una licencia válida que la
	 * incluya. Se verifica con la clave de PUBLICACIÓN (la del binario), no con la
	 * del panel, para que valga aunque el panel mienta sobre los módulos. Las
	 * trampas gratis (MODULOS_GRATIS) no pasan por aquí.
	 */
	const lic = await licenciaGuardada();
	/* Sin clave de publicación no se puede cotejar: la licencia la juzga solo la trampa. */
	const clavePub = env.PUBLICACION_CLAVE_PUBLICA;
	const cotejaLicencia = !!clavePub;
	let licVerificada: Licencia | null = null;
	let licCaducada = false;
	if (lic && clavePub) {
		const v = verificarLicencia(clavePub, lic);
		if (v.ok) licVerificada = v.licencia;
		else if (v.motivo === 'licencia caducada') licCaducada = true;
	}
	const filas = await db
		.select()
		.from(s.trampas)
		.where(
			and(
				eq(s.trampas.sensor, sensor),
				eq(s.trampas.activo, true),
				eq(s.trampas.ejecutor, 'contenedor@1')
			)
		);

	const trampas: TrampaPlan[] = [];
	const descartados: Descarte[] = [];
	const descartar = (id: string, codigo: CodigoMotivo, datos?: DatosMotivo) =>
		descartados.push({ id, codigo, motivo: textoDescarte(codigo, datos) });
	for (const f of filas) {
		const h = catalogo.get(f.modulo);
		if (!h) {
			descartar(f.id, 'modulo.desconocido', { modulo: f.modulo });
			continue;
		}
		/* La vía con que se puso, también por un id de antes (regla 10). */
		const via = viaDe(h, f.via);
		if (!via || via.ejecutor !== 'contenedor@1') {
			descartar(f.id, 'modulo.via-desaparecida');
			continue;
		}
		/* Una trampa que usa algo que un sensor viejo no entiende no se le manda. */
		if (
			via.sensorMinimo &&
			versionSensor !== 'dev' &&
			(!versionSensor ||
				!esVersion(versionSensor) ||
				compararVersiones(versionSensor, via.sensorMinimo) < 0)
		) {
			descartar(f.id, 'agente.version', { minimo: via.sensorMinimo });
			continue;
		}
		/* Si SeguridadSI retira un módulo, sus trampas dejan de desplegarse. */
		if (!permitidos.has(h.id)) {
			descartar(f.id, 'modulo.no-autorizado', { modulo: f.modulo, nombre: h.nombre });
			continue;
		}
		/*
		 * Candado de licencia (capa 4): una trampa de PAGO solo entra en el plan si
		 * la licencia está, es válida y la incluye. Sin licencia o con un módulo que
		 * no incluye → licencia.sin; con licencia caducada → licencia.caducada. Si
		 * no hay clave para cotejar, no se descarta aquí (la trampa lo hará sola).
		 */
		if (cotejaLicencia && esDePago(h.id)) {
			if (!licVerificada) {
				descartar(f.id, licCaducada ? 'licencia.caducada' : 'licencia.sin');
				continue;
			}
			if (!licenciaPermite(licVerificada, h.id)) {
				descartar(f.id, 'licencia.sin');
				continue;
			}
		}
		const m = proyectarParaSensor(h, via.id);
		/* Una imagen con el digest en ceros aún no se ha publicado: no se descarga. */
		if (m.contenedor && /@sha256:0{64}$/.test(m.contenedor.imagen)) {
			descartar(f.id, 'carga.imagen-sin-publicar');
			continue;
		}
		/*
		 * Una imagen sin alternativa pública es del registro privado: un sensor
		 * sin su credencial no podría descargarla y la trampa quedaría en error.
		 */
		if (m.contenedor && !m.contenedor.imagenPublica && !registroPrivado) {
			descartar(f.id, 'carga.sin-credencial');
			continue;
		}
		const p = validarParametros(h.parametros, f.parametros);
		if (!p.ok) {
			descartar(f.id, 'parametros.invalidos', { errores: p.errores.join('; ') });
			continue;
		}
		trampas.push({
			id: f.id,
			nombre: f.nombre,
			manifiesto: manifiestoPara(m, registroPrivado),
			parametros: p.valor
		});
	}
	await anotarEspera(sensor, filas, trampas, descartados);
	/*
	 * La licencia de pago (la misma que se cotejó arriba), para que el sensor la
	 * monte en las trampas. Se manda solo si la hay (un nodo de edición gratis no
	 * la tiene y el campo se omite). No es secreta: es un permiso firmado.
	 * senuelos: lo mismo con el nombre que entienden los sensores anteriores a la 0.8.0.
	 */
	return {
		trampas,
		senuelos: trampas,
		descartados,
		admite: ADMITE,
		...(lic ? { licencia: lic } : {})
	};
}

/*
 * Lo que el plan deja fuera queda «en espera», con su motivo, en
 * trampas.donde, y por colocar con su código (§8.1): el sensor quita esas
 * trampas de su máquina y deja de informar de ellas. Sin esto, la consola
 * seguiría enseñando como activa una trampa en el último sitio donde estuvo.
 * Cuando vuelve al plan pasa a «desplegando…» hasta que el sensor diga dónde
 * ha quedado, y su primer estado limpio la deja puesta (informarEstado).
 *
 * Se escribe antes de responder: si no se puede, el sensor no recibe el plan
 * y sigue con el anterior, donde la trampa aún estaba. El plan se pide cada
 * pocos segundos, así que solo se escribe lo que cambia, y solo si nadie ha
 * tocado esa fila mientras tanto (lo arreglará el plan siguiente).
 */
async function anotarEspera(
	sensor: string,
	filas: ({ id: string } & FilaColocacion)[],
	trampas: TrampaPlan[],
	descartados: Descarte[]
) {
	const antes = new Map(filas.map((f) => [f.id, f]));
	const ahora = new Date();
	const cambios = new Map<string, Partial<typeof s.trampas.$inferInsert>>();
	for (const d of descartados) {
		const f = antes.get(d.id);
		if (!f) continue;
		const donde = `${EN_ESPERA}${d.motivo}`.slice(0, 200);
		const c = { ...(f.donde === donde ? {} : { donde }), ...trasDescarte(f, d.codigo, ahora) };
		if (Object.keys(c).length) cambios.set(d.id, c);
	}
	for (const t of trampas)
		if (enEspera(antes.get(t.id)?.donde ?? '')) cambios.set(t.id, { donde: 'desplegando…' });
	for (const [id, c] of cambios) {
		const f = antes.get(id)!;
		await db
			.update(s.trampas)
			.set(c)
			.where(
				and(
					eq(s.trampas.id, id),
					eq(s.trampas.sensor, sensor),
					eq(s.trampas.donde, f.donde),
					eq(s.trampas.colocacion, f.colocacion)
				)
			);
	}
}

/*
 * La versión que dice el sensor en la cabecera Sugardaddy-Version (0.13.1,
 * dev…), tal como se guarda en sensores.version_agente: sin cabecera, o con
 * algo que no parece una versión, no se sabe (null).
 */
export function versionAgente(cabecera: string | null): string | null {
	return cabecera && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(cabecera) ? cabecera : null;
}

/* El estado de una trampa según su sensor. */
export type EstadoTrampa = {
	id: string;
	/* Dónde escucha o qué le pasa, en texto: lo que entienden todas las consolas. */
	donde: string;
	/* Desde la 0.13.1, el código estable de su fallo (motor.permiso…). */
	codigo?: string;
	/* Desde el paso 14a, los códigos de sus avisos (aislamiento.se-ven…). */
	avisos?: string[];
};

const esObjeto = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
const esCodigo = (v: unknown): v is string =>
	typeof v === 'string' && v.length <= 64 && CODIGO.test(v);

/*
 * Las trampas de un informe de estado: como mucho 100, y solo las que traen
 * id y donde. codigo y avisos son para la colocación (§8.1); lo que no es un
 * código estable (fase.causa) se descarta.
 */
export function leerEstados(trampas: unknown[]): EstadoTrampa[] {
	const r: EstadoTrampa[] = [];
	for (const e of trampas.slice(0, 100)) {
		if (!esObjeto(e) || typeof e.id !== 'string' || typeof e.donde !== 'string') continue;
		const x: EstadoTrampa = { id: e.id, donde: e.donde.slice(0, 200) };
		if (esCodigo(e.codigo)) x.codigo = e.codigo;
		const avisos = Array.isArray(e.avisos) ? [...new Set(e.avisos.filter(esCodigo))] : [];
		if (avisos.length) x.avisos = avisos.slice(0, 16);
		r.push(x);
	}
	return r;
}

/* Cada bloque de lo que cuenta el sensor de su máquina, como se dice en la auditoría. */
const BLOQUES = {
	motor: 'lo que cuenta de su motor de contenedores',
	hechos: 'lo que cuenta de su máquina'
} as const;
const MAX_BLOQUE = 32 * 1024;

/*
 * Lo que no cuadra en lo que cuenta el sensor de su máquina (§4.4): un motor
 * o unos hechos que no son un objeto, o que pasan de 32 KB. Nunca hace fallar
 * el informe: lo que no es un objeto se ignora, y de lo que pasa de 32 KB
 * leerCapacidades solo se queda con lo que cabe. Es para la auditoría.
 */
export function revisarCapacidades(cuerpo: unknown): string[] {
	if (!esObjeto(cuerpo)) return [];
	const r: string[] = [];
	for (const [k, nombre] of Object.entries(BLOQUES)) {
		const v = cuerpo[k];
		if (v === undefined || v === null) continue;
		if (!esObjeto(v)) r.push(`${nombre} no tiene la forma esperada y se ignora`);
		else if (Buffer.byteLength(JSON.stringify(v)) > MAX_BLOQUE)
			r.push(`${nombre} pasa de 32 KB y se descarta lo que sobra`);
	}
	return r;
}

/*
 * Una línea en la auditoría como mucho cada hora por sensor: uno con un fallo
 * lo repetiría en cada informe, cada 10 s. Se lleva en memoria: tras
 * reiniciar la consola puede salir una más.
 */
const AUDITAR_CADA = 60 * 60_000;
const auditado = new Map<string, number>();
async function auditarDescartes(sensor: string, descartes: string[]) {
	const ahora = Date.now();
	const antes = auditado.get(sensor);
	if (antes !== undefined && ahora - antes < AUDITAR_CADA) return;
	await db.insert(s.auditoria).values({
		quien: `sensor ${sensor}`,
		accion: 'datos de la máquina descartados',
		detalle: { motivo: descartes.join('; ') }
	});
	auditado.set(sensor, ahora);
}

/*
 * Durante un fallo del motor se conserva de lo último que se supo cómo está
 * instalado (§4.4): no cambia por un corte, y sin ello los requisitos de
 * contenedor@1 pasarían a «sin dato». Lo demás (versión, API, pasarelas…) ya
 * no se sabe.
 */
const CONSERVAR = ['tipo', 'modo', 'so', 'arquitectura'] as const;
/* Si nada cambia, «cuando» se refresca como mucho cada 5 minutos. */
const REFRESCO = 5 * 60_000;

/* JSON con las claves ordenadas: jsonb no guarda el orden en que se escribieron. */
function canonico(x: unknown): string {
	if (Array.isArray(x)) return `[${x.map(canonico).join(',')}]`;
	if (esObjeto(x))
		return `{${Object.keys(x)
			.filter((k) => x[k] !== undefined)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonico(x[k])}`)
			.join(',')}}`;
	return JSON.stringify(x);
}

/*
 * Lo que queda en sensores.capacidades con lo que acaba de contar el sensor y
 * lo que ya había. null si no cuenta nada (anterior a la 0.13.1, o vuelto
 * atrás): mejor nada que algo que ya no vale.
 */
function capacidadesNuevas(previas: Capacidades | null, leidas: Capacidades): Capacidades | null {
	if (!leidas.motor && Object.keys(leidas.hechos).length === 0) return null;
	let motor = leidas.motor;
	if (motor?.codigo && previas?.motor) {
		const conservado: MotorSensor = {};
		for (const k of CONSERVAR) if (previas.motor[k]) conservado[k] = previas.motor[k];
		motor = { ...conservado, ...motor };
	}
	return { motor, hechos: leidas.hechos };
}

/*
 * Se escribe solo si cambia lo que cuenta el sensor (sin contar «cuando») y,
 * si no, para refrescar «cuando» cada 5 minutos: el sensor informa cada 10 s
 * y casi siempre dice lo mismo.
 */
async function guardarCapacidades(sensor: string, leidas: Capacidades) {
	const [f] = await db
		.select({ capacidades: s.sensores.capacidades })
		.from(s.sensores)
		.where(eq(s.sensores.id, sensor));
	if (!f) return;
	const nuevas = capacidadesNuevas(f.capacidades, leidas);
	const ahora = Date.now();
	if (f.capacidades && nuevas) {
		const { cuando, ...antes } = f.capacidades;
		if (canonico(antes) === canonico(nuevas) && Math.abs(ahora - Date.parse(cuando)) < REFRESCO)
			return;
	} else if (!f.capacidades && !nuevas) return;
	await db
		.update(s.sensores)
		.set({ capacidades: nuevas && { ...nuevas, cuando: new Date(ahora).toISOString() } })
		.where(eq(s.sensores.id, sensor));
}

/*
 * El estado de cada trampa y, desde la 0.13.1, lo que el sensor cuenta de su
 * máquina (su motor y sus hechos). De cada trampa, dónde está y su colocación
 * (trasEstado, §8.1), en una sola escritura y solo si algo cambia: el sensor
 * informa cada 10 s y casi siempre dice lo mismo. descartes: lo que no
 * cuadraba en el informe (revisarCapacidades), para la auditoría.
 */
export async function informarEstado(
	sensor: string,
	trampas: unknown[],
	capacidades: Capacidades = { motor: null, hechos: {} },
	descartes: string[] = []
) {
	const estados = leerEstados(trampas);
	const filas = estados.length
		? await db
				.select({
					id: s.trampas.id,
					donde: s.trampas.donde,
					activo: s.trampas.activo,
					colocacion: s.trampas.colocacion,
					colocacionMotivo: s.trampas.colocacionMotivo,
					comprobada: s.trampas.comprobada
				})
				.from(s.trampas)
				.where(
					and(
						eq(s.trampas.sensor, sensor),
						inArray(
							s.trampas.id,
							estados.map((e) => e.id)
						)
					)
				)
		: [];
	const leidas = new Map(filas.map((f) => [f.id, f]));
	const ahora = new Date();
	for (const e of estados) {
		const f = leidas.get(e.id);
		/*
		 * Una trampa fuera del plan (en espera o parada) no viene en el plan que
		 * tiene el sensor: un estado suyo llega tarde y no cambia nada, ni dónde
		 * está ni su colocación. El siguiente ya no la trae.
		 */
		if (!f || !f.activo || enEspera(f.donde)) continue;
		const c = { ...(f.donde === e.donde ? {} : { donde: e.donde }), ...trasEstado(f, e, ahora) };
		if (!Object.keys(c).length) continue;
		/* Si otro (el plan) la ha tocado mientras tanto, gana él: el sensor vuelve a informar. */
		await db
			.update(s.trampas)
			.set(c)
			.where(
				and(
					eq(s.trampas.id, e.id),
					eq(s.trampas.sensor, sensor),
					eq(s.trampas.donde, f.donde),
					eq(s.trampas.colocacion, f.colocacion)
				)
			);
		leidas.set(e.id, { ...f, ...c });
	}
	await guardarCapacidades(sensor, capacidades);
	if (descartes.length) await auditarDescartes(sensor, descartes);
}

export type Recepcion = { ok: true; aceptadas: number; ultimoHash: string };

/*
 * Recibe una entrega de un sensor. Regla de oro: NUNCA se queda parada.
 *
 * Cada línea acaba en uno de dos sitios, y en los dos con su hash, así que la
 * cadena se puede verificar siempre juntándolos:
 *   - eventos, si es un evento válido de una trampa de este sensor;
 *   - cuarentena, con el motivo, si no lo es (ilegible, fuera de contrato, de
 *     una trampa retirada o de otro sensor, o un evento ya recibido que vuelve
 *     con otros bytes).
 * Una línea ya guardada (el sensor reenvía tras un corte) cuenta como
 * recibida sin más. Una línea que no continúa la cadena se guarda igual y la
 * ruptura queda anotada: es prueba de que algo pasó, no un motivo para dejar
 * de ver eventos.
 *
 * Todo bajo un bloqueo de la fila del sensor, para que dos entregas a la vez
 * no intercalen la cadena. Si la base de datos falla, la entrega entera se
 * deshace y el sensor la repite: lo ya guardado se reconoce por su hash.
 *
 * Un evento de una prueba abierta («Probar», §8.3) se guarda con prueba =
 * true, sin alerta ni severidad subida, y comprueba la trampa probada. Los
 * demás eventos nuevos pasan al motor de respuesta y a las salidas (avisos y
 * SIEM) después del COMMIT, fuera de la transacción: una respuesta lenta, o
 * un SIEM caído, no frena ni corta la entrega.
 */
export async function recibirEventos(sensor: string, lineas: string[]): Promise<Recepcion> {
	const credencial = await preparar();
	const { recepcion } = await guardarEntrega(sensor, lineas, credencial);
	return recepcion;
}

/*
 * En la edición community no hay salidas (avisos/SIEM) ni motor de respuesta:
 * ambos son piezas de pago. recibirEventos solo guarda la entrega; los
 * eventos se consultan en la consola.
 */

async function guardarEntrega(
	sensor: string,
	lineas: string[],
	credencial: Awaited<ReturnType<typeof preparar>>
): Promise<{ recepcion: Recepcion; nuevos: Evento[] }> {
	return db.transaction(async (tx) => {
		const [fila] = await tx
			.select()
			.from(s.sensores)
			.where(eq(s.sensores.id, sensor))
			.for('update');
		const trampas = await tx
			.select({
				id: s.trampas.id,
				sensor: s.trampas.sensor,
				via: s.trampas.via,
				donde: s.trampas.donde,
				activo: s.trampas.activo,
				colocacion: s.trampas.colocacion,
				colocacionMotivo: s.trampas.colocacionMotivo,
				comprobada: s.trampas.comprobada
			})
			.from(s.trampas);
		const deQuien = new Map(trampas.map((x) => [x.id, x.sensor]));
		const viaDeTrampa = new Map(trampas.map((x) => [x.id, x.via]));
		/* Para fijar «comprobada» con el primer evento, sin consultar por cada línea. */
		const colocacion = new Map<string, FilaColocacion>(trampas.map((x) => [x.id, x]));
		/*
		 * Las pruebas abiertas de sus trampas, y la hora de la consola con que
		 * se guardará «recibido» (now(), la misma en toda la transacción): un
		 * evento es de prueba según cuándo llega, no según el «cuando» del sensor.
		 */
		const abiertas = await pruebasAbiertas(tx, sensor);
		const recibidoAhora = new Date(
			(await tx.execute<{ ahora: string | Date }>(sql`select now() as ahora`))[0].ahora
		);
		const nuevos: Evento[] = [];
		let anterior = fila.ultimoHash;
		let aceptadas = 0;

		for (const linea of lineas) {
			aceptadas++;
			const hash = hashEvento(linea);
			const [yaEvento] = await tx
				.select({ id: s.eventos.id })
				.from(s.eventos)
				.where(eq(s.eventos.hash, hash));
			const [yaCuarentena] = yaEvento
				? []
				: await tx
						.select({ id: s.cuarentena.id })
						.from(s.cuarentena)
						.where(eq(s.cuarentena.hash, hash));
			/* Ya la tenemos: un reenvío. No mueve la cadena hacia atrás. */
			if (yaEvento || yaCuarentena) continue;

			let e: Evento | null = null;
			let motivo: string | null = null;
			if (linea.length > LIMITE_LINEA) motivo = 'línea demasiado larga';
			else {
				let dato: unknown = null;
				try {
					dato = JSON.parse(linea);
				} catch {
					motivo = 'no es JSON';
				}
				if (!motivo) {
					const v = validarEvento(dato);
					if (!v.ok) motivo = `no cumple el contrato: ${v.errores.slice(0, 3).join('; ')}`;
					else e = v.valor;
				}
			}

			if (e && e.hashAnterior !== anterior) {
				await tx
					.insert(s.rupturas)
					.values({ sensor, esperado: anterior, recibido: e.hashAnterior, hash });
				await tx.insert(s.auditoria).values({
					quien: `sensor ${sensor}`,
					accion: 'cadena de eventos rota',
					detalle: { esperado: anterior, recibido: e.hashAnterior, hash }
				});
			}

			if (e && !motivo) {
				if (e.sensor !== sensor) motivo = 'el evento dice ser de otro sensor';
				else if (deQuien.get(e.trampa.id) === undefined)
					motivo = 'la trampa ya no existe (retirada)';
				else if (deQuien.get(e.trampa.id) !== sensor) motivo = 'la trampa es de otro sensor';
			}

			/*
			 * Las balizas (cebos de fichero y el píxel §5.3) son una pieza de
			 * pago, ausente en la edición community: aquí no hay receptor ni
			 * tokens, así que un evento es de prueba solo por «Probar».
			 */
			const deLaPrueba = e && !motivo ? pruebasDe(e, recibidoAhora, abiertas) : [];
			const prueba = deLaPrueba.length > 0;

			if (e && !motivo) {
				const evento = e;
				const leida = credencial(evento, viaDeTrampa.get(evento.trampa.id));
				const c = prueba ? { ...leida, alerta: null, severidad: evento.severidad } : leida;
				/* En su propio punto de guardado: si falla (p. ej. un id repetido), solo cae esta línea. */
				let recibido: Date | null = null;
				try {
					recibido = await tx.transaction(async (sp) => {
						const [x] = await sp
							.insert(s.eventos)
							.values({
								id: evento.id,
								sensor,
								linea,
								hash,
								cuando: new Date(evento.cuando),
								trampa: evento.trampa.id,
								modulo: evento.trampa.modulo,
								tipo: evento.trampa.tipo,
								accion: evento.accion,
								severidad: c.severidad,
								ip: evento.origen.ip ?? null,
								usuario: evento.origen.usuario ? sinNulos(evento.origen.usuario) : null,
								conexionEstablecida: evento.conexionEstablecida,
								contrasena: c.contrasena ? sinNulos(c.contrasena) : null,
								alerta: c.alerta ? sinNulos(c.alerta) : null,
								prueba
							})
							.returning({ recibido: s.eventos.recibido });
						return x.recibido;
					});
				} catch (err) {
					/* Se decide por el propio error: otra consulta aquí podría fallar y tumbar la entrega. */
					const causa = ((err as { cause?: unknown }).cause ?? err) as {
						code?: string;
						constraint_name?: string;
						message?: string;
					};
					motivo =
						causa.code === '23505' && causa.constraint_name === 'eventos_pkey'
							? 'repite un evento ya recibido'
							: `no se pudo guardar: ${String(causa.message ?? err).slice(0, 200)}`;
				}
				/*
				 * El primer evento real de su trampa la comprueba (§8.3). En su propio
				 * punto de guardado: si no se puede, el evento ya está guardado y lo
				 * intentará el siguiente.
				 */
				const f = colocacion.get(evento.trampa.id);
				if (recibido && f && !f.comprobada) {
					const cuando = recibido;
					try {
						const cambio = await tx.transaction((sp) =>
							comprobarConEvento(sp, evento.trampa.id, f, cuando)
						);
						colocacion.set(evento.trampa.id, { ...f, ...cambio });
					} catch (err) {
						console.error('no se pudo dar por comprobada la trampa', evento.trampa.id, err);
					}
				}
				/*
				 * El de cada prueba que aún no tenía evento, y la comprobación de la
				 * trampa probada si no es la suya (la que recibe la señal de otra).
				 * También en su punto de guardado: si falla, el evento ya está.
				 */
				if (recibido && prueba) {
					const cuando = recibido;
					try {
						await tx.transaction((sp) =>
							anotarPrueba(sp, evento.id, deLaPrueba, cuando, colocacion, evento.trampa.id)
						);
					} catch (err) {
						console.error('no se pudo anotar la prueba del evento', evento.id, err);
					}
				}
				/*
				 * El motor de respuesta y las salidas (de pago, fuera de community)
				 * solo verían lo que no es de prueba. nuevos se construye igual,
				 * pero recibirEventos ya no lo pasa a nadie.
				 */
				if (recibido && !prueba) nuevos.push({ ...evento, severidad: c.severidad });
			}

			if (motivo) {
				const fila = {
					sensor,
					hash,
					hashAnterior: e?.hashAnterior ?? null,
					linea: sinNulos(linea.slice(0, LIMITE_LINEA)),
					motivo: sinNulos(motivo)
				};
				/*
				 * También en su punto de guardado: la cuarentena es el último destino
				 * y no puede fallar. Si ni así entra, queda al menos su hash y el motivo.
				 */
				try {
					await tx.transaction(async (sp) => {
						await sp.insert(s.cuarentena).values(fila);
					});
				} catch (err) {
					await tx.insert(s.cuarentena).values({
						...fila,
						linea: '',
						motivo: `${fila.motivo.slice(0, 200)} (la línea no se pudo guardar: ${String((err as Error).message).slice(0, 120)})`
					});
				}
			}
			anterior = hash;
		}
		await tx.update(s.sensores).set({ ultimoHash: anterior }).where(eq(s.sensores.id, sensor));
		return { recepcion: { ok: true, aceptadas, ultimoHash: anterior }, nuevos };
	});
}
