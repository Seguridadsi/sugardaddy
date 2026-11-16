/*
 * Contraseñas que prueban los atacantes y alertas por el nombre de la empresa.
 *
 * Qué campo es la contraseña lo dice el manifiesto de cada trampa (Cowrie
 * hoy; cualquiera con login mañana), en el traductor de su vía. Se guarda
 * cifrada, con su huella para reunirlas y contarlas y su máscara para
 * enseñarla (credenciales-protegidas.ts); verla entera es revelarla, con
 * permiso y auditado.
 *
 * La alerta salta SOLO si la contraseña o el usuario contienen una de las
 * palabras que el cliente pone en Ajustes, tal cual: sin variantes ni
 * parecidos, para no inventar falsos positivos. Se ignoran mayúsculas y
 * tildes, nada más. Con alerta, el evento sube a crítico; la línea firmada
 * del sensor no se toca.
 */
import { and, desc, eq, gte, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Evento, Severidad } from '@sugardaddy/contrato';
import { db, schema as s } from './db';
import { honeycosas, traductorDeTrampa } from './catalogo';
import { claveDelNodo } from './secretos';
import {
	CAMPOS_CREDENCIAL,
	MAXIMO_CREDENCIAL,
	abrir,
	huella,
	proteger
} from './credenciales-protegidas';

export const MINIMO_PALABRA = 4;
const MAXIMO_PALABRAS = 20;
const MAXIMO_CONTRASENA = 256;

/* "Aldanza", "ALDANZA" y "Aldánza" son la misma palabra; "4ld4nz4" no. */
export const normalizar = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export async function palabras(): Promise<string[]> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'detonadores'));
	return (f?.valor as string[] | undefined) ?? [];
}

/*
 * El campo de contraseña de los eventos de una trampa, según el traductor de
 * su vía (traductorDeTrampa: sin vía, el del módulo).
 */
function camposContrasena() {
	const porId = new Map(honeycosas().map((h) => [h.id, h]));
	return (modulo: string, via?: string) => {
		const h = porId.get(modulo);
		return h && traductorDeTrampa(h, via)?.contrasena;
	};
}

export function alertaPara(
	contrasena: string | null,
	usuario: string | null,
	lista: string[]
): string | null {
	for (const p of lista) {
		const n = normalizar(p);
		if (contrasena && normalizar(contrasena).includes(n)) return `Password contains "${p}"`;
		if (usuario && normalizar(usuario).includes(n)) return `Username contains "${p}"`;
	}
	return null;
}

/*
 * Lo que se guarda junto al evento: su contraseña, si la hay, y si es
 * alerta. campo: el de la contraseña en el detalle, según su manifiesto.
 */
export function credencialDe(
	e: Evento,
	campo: string | undefined,
	lista: string[]
): { contrasena: string | null; alerta: string | null; severidad: Severidad } {
	const v = campo ? e.detalle?.[campo] : undefined;
	const contrasena = typeof v === 'string' && v ? v.slice(0, MAXIMO_CONTRASENA) : null;
	const alerta = alertaPara(contrasena, e.origen.usuario ?? null, lista);
	return { contrasena, alerta, severidad: alerta ? 'critica' : e.severidad };
}

/*
 * Para la recepción: lo que no cambia entre eventos se lee una vez por
 * entrega. via: la de la trampa del evento, si se sabe. campo: el de la
 * contraseña según su traductor, para protegerla al guardar (guardable).
 */
export async function preparar() {
	const campo = camposContrasena();
	const lista = await palabras();
	return (e: Evento, via?: string) => {
		const c = campo(e.trampa.modulo, via);
		return { ...credencialDe(e, c, lista), campo: c ?? null };
	};
}

let avisadoSinClave = false;

/*
 * Lo que se guarda de una línea recién llegada: la línea con sus credenciales
 * enmascaradas y el sobre, la huella y la máscara (credenciales-protegidas.ts).
 * hash: el de la línea tal como llegó.
 */
export function guardable(
	linea: string,
	hash: string,
	c: { campo: string | null; contrasena: string | null }
) {
	const p = proteger(linea, hash, c.campo, c.contrasena);
	if (p.perdida && !avisadoSinClave) {
		avisadoSinClave = true;
		console.error(
			'[credenciales] this node has no CLAVE_SECRETOS: captured credentials are kept masked only, their value is lost'
		);
	}
	return {
		linea: p.linea,
		credencial: p.credencial,
		contrasenaHuella: p.contrasenaHuella,
		contrasenaMascara: p.contrasenaMascara
	};
}

/*
 * La contraseña de un evento guardado: del sobre o, en una fila que aún no se
 * ha cifrado, de la columna de antes. undefined: no se puede leer (otra clave).
 */
function contrasenaGuardada(f: {
	hash: string;
	credencial: string | null;
	contrasena: string | null;
}): string | null | undefined {
	if (f.credencial === null) return f.contrasena;
	if (f.credencial === '') return undefined;
	const r = abrir(f.credencial, f.hash);
	return r.ok ? r.credencial.contrasena : undefined;
}

/*
 * Vuelve a calcular alerta y severidad de los eventos de autenticación al
 * cambiar las palabras. La contraseña sale del sobre (se descifra aquí, en la
 * memoria de la consola, sin auditar: no la ve nadie). Uno de prueba («Probar»,
 * §8.3) nunca es alerta: conserva la severidad de su sensor; uno de un escáner
 * tampoco, y va en lo más bajo. Uno cuyo sobre no se puede leer se queda como está.
 */
export async function recalcular() {
	const lista = await palabras();
	let desde: string | null = null;
	let cambiados = 0;
	for (;;) {
		const filas = await db
			.select({
				id: s.eventos.id,
				hash: s.eventos.hash,
				linea: s.eventos.linea,
				credencial: s.eventos.credencial,
				contrasena: s.eventos.contrasena,
				alerta: s.eventos.alerta,
				severidad: s.eventos.severidad,
				prueba: s.eventos.prueba,
				escaner: s.eventos.escaner
			})
			.from(s.eventos)
			.where(
				and(
					eq(s.eventos.accion, 'autenticacion'),
					desde ? sql`${s.eventos.id} > ${desde}::uuid` : undefined
				)
			)
			.orderBy(s.eventos.id)
			.limit(1000);
		if (!filas.length) break;
		for (const f of filas) {
			const contrasena = contrasenaGuardada(f);
			if (contrasena === undefined) continue;
			let e: Evento;
			try {
				const { senuelo, ...dato } = JSON.parse(f.linea);
				e = (senuelo ? { ...dato, trampa: senuelo } : dato) as Evento;
			} catch {
				continue;
			}
			const alerta =
				f.prueba || f.escaner
					? null
					: alertaPara(
							contrasena?.slice(0, MAXIMO_CONTRASENA) ?? null,
							e.origen?.usuario ?? null,
							lista
						);
			const severidad: Severidad = f.escaner ? 'baja' : alerta ? 'critica' : e.severidad;
			if (alerta !== f.alerta || severidad !== f.severidad) {
				await db.update(s.eventos).set({ alerta, severidad }).where(eq(s.eventos.id, f.id));
				cambiados++;
			}
		}
		desde = filas[filas.length - 1].id;
	}
	return cambiados;
}

/*
 * Las claves del detalle que pueden traer una credencial: las de la lista
 * común y las que declaran los traductores. Para escoger filas en SQL (lo que se
 * protege lo decide proteger() con el traductor de cada una) y para enmascarar lo
 * que no es un evento: la cuarentena y las filas de antes de la 0063 al exportar.
 */
export function clavesCredencial(): string[] {
	const declarados = honeycosas().flatMap((h) =>
		[undefined, ...h.vias.map((v) => v.id)]
			.map((via) => traductorDeTrampa(h, via)?.contrasena)
			.filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]+$/.test(x))
	);
	return [...new Set([...CAMPOS_CREDENCIAL, ...declarados])];
}

function patronCredencial(): string {
	return `"(${clavesCredencial().join('|')})"[[:space:]]*:`;
}

export const LOTE_CIFRADO = 500;
const AJUSTE_CIFRADO = 'credenciales-cifradas';

/*
 * La parte de datos de la migración 0063: cifra lo que llegó en claro. Por lotes
 * de LOTE_CIFRADO, por el id, cada lote en un solo UPDATE: en cada fila, a la
 * vez, el sobre, la huella, la máscara, la línea enmascarada y la columna de
 * antes a null, y solo si sigue sin sobre. Repetirlo, o que entre a la vez un
 * evento nuevo, no estropea nada.
 *
 * Desde: solo lo recibido desde entonces (la pasada anterior). Así, tras volver
 * a una consola de antes y otra vez a esta, lo que esa guardó en claro se cifra
 * al arrancar, sin recorrer cada vez toda la tabla (va por el índice de
 * «recibido»). Sin la clave del nodo no hace nada y lo dice: no hay con qué.
 */
export async function cifrarAnteriores(desde: Date | null = null): Promise<number | null> {
	const base = claveDelNodo();
	if (!base) return null;
	const campo = camposContrasena();
	const vias = new Map(
		(await db.select({ id: s.trampas.id, via: s.trampas.via }).from(s.trampas)).map((t) => [
			t.id,
			t.via ?? undefined
		])
	);
	const patron = patronCredencial();
	let ultimo: string | null = null;
	let cifradas = 0;
	for (;;) {
		const filas = await db
			.select({
				id: s.eventos.id,
				hash: s.eventos.hash,
				linea: s.eventos.linea,
				contrasena: s.eventos.contrasena,
				modulo: s.eventos.modulo,
				trampa: s.eventos.trampa
			})
			.from(s.eventos)
			.where(
				and(
					isNull(s.eventos.credencial),
					or(isNotNull(s.eventos.contrasena), sql`${s.eventos.linea} ~ ${patron}`),
					desde ? gte(s.eventos.recibido, desde) : undefined,
					ultimo ? sql`${s.eventos.id} > ${ultimo}::uuid` : undefined
				)
			)
			.orderBy(s.eventos.id)
			.limit(LOTE_CIFRADO);
		if (!filas.length) break;
		const cambios = filas.flatMap((f) => {
			const p = proteger(
				f.linea,
				f.hash,
				campo(f.modulo, vias.get(f.trampa)) ?? null,
				f.contrasena,
				base
			);
			return p.protegida ? [{ id: f.id, ...p }] : [];
		});
		/* Un solo UPDATE por lote (con sus valores en una lista): mil filas por segundo no bastaban. */
		if (cambios.length) {
			const valores = sql.join(
				cambios.map(
					(x) =>
						sql`(${x.id}::uuid, ${x.linea}, ${x.credencial}, ${x.contrasenaHuella}, ${x.contrasenaMascara})`
				),
				sql`, `
			);
			const hechas = await db.execute(sql`
				update ${s.eventos} as e set
					linea = v.linea,
					credencial = v.credencial,
					contrasena_huella = v.huella,
					contrasena_mascara = v.mascara,
					contrasena = null
				from (values ${valores}) as v(id, linea, credencial, huella, mascara)
				where e.id = v.id and e.credencial is null
				returning e.id
			`);
			cifradas += hechas.length;
		}
		ultimo = filas[filas.length - 1].id;
	}
	return cifradas;
}

/*
 * Al arrancar: cifra lo que quede en claro (cifrarAnteriores) y apunta hasta
 * cuándo. Con margen: lo que una transacción larga confirme tarde también entra
 * en la pasada siguiente.
 */
export async function rellenarSiHaceFalta() {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, AJUSTE_CIFRADO));
	const antes = (f?.valor as { hasta?: string } | undefined)?.hasta;
	const empieza = new Date(Date.now() - 10 * 60_000);
	const n = await cifrarAnteriores(antes ? new Date(antes) : null);
	if (n === null) {
		console.error(
			'[credenciales] this node has no CLAVE_SECRETOS: captured credentials received before cannot be encrypted yet'
		);
		return;
	}
	if (n) console.log(`[credenciales] ${n} events with captured credentials encrypted`);
	const valor = { hasta: empieza.toISOString() };
	await db
		.insert(s.ajustes)
		.values({ clave: AJUSTE_CIFRADO, valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
}

export async function guardarPalabras(quien: string, texto: string) {
	const lista = [
		...new Set(
			texto
				.split(/[\n,]+/)
				.map((p) => p.trim())
				.filter(Boolean)
		)
	];
	const cortas = lista.filter((p) => normalizar(p).length < MINIMO_PALABRA);
	if (cortas.length)
		return {
			ok: false as const,
			error: `Each word needs at least ${MINIMO_PALABRA} letters (${cortas.join(', ')}): shorter ones match almost anything.`
		};
	if (lista.length > MAXIMO_PALABRAS)
		return { ok: false as const, error: `At most ${MAXIMO_PALABRAS} words.` };
	await db
		.insert(s.ajustes)
		.values({ clave: 'detonadores', valor: lista })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: lista } });
	await db
		.insert(s.auditoria)
		.values({ quien, accion: 'alert words changed', detalle: { palabras: lista } });
	return { ok: true as const, cambiados: await recalcular() };
}

/*
 * Todas las contraseñas probadas, de la más usada a la menos, enmascaradas y
 * agrupadas por su huella. Sin las de «Probar» (§8.3): las escribe el propio
 * cliente, no un atacante. huella: solo las de esa (buscarContrasena).
 */
export async function contrasenas(huella: string | null = null) {
	return db
		.select({
			huella: s.eventos.contrasenaHuella,
			mascara: sql<string>`max(${s.eventos.contrasenaMascara})`,
			veces: sql<number>`count(*)::int`,
			ips: sql<number>`count(distinct ${s.eventos.ip})::int`,
			usuarios: sql<
				string[]
			>`(array_agg(distinct ${s.eventos.usuario}) filter (where ${s.eventos.usuario} is not null))[1:6]`,
			trampas: sql<string[]>`array_agg(distinct ${s.eventos.trampa})`,
			primera: sql<string>`min(${s.eventos.cuando})`,
			ultima: sql<string>`max(${s.eventos.cuando})`,
			alerta: sql<string | null>`max(${s.eventos.alerta})`
		})
		.from(s.eventos)
		.where(
			and(
				isNotNull(s.eventos.contrasenaHuella),
				eq(s.eventos.prueba, false),
				huella ? eq(s.eventos.contrasenaHuella, huella) : undefined
			)
		)
		.groupBy(s.eventos.contrasenaHuella)
		.orderBy(desc(sql`max(${s.eventos.alerta}) is not null`), desc(sql`count(*)`))
		.limit(500);
}

/* Las acciones de la auditoría: salen como auditoria.credenciales (salidas/auditoria.ts). */
export const ACCION_REVELAR = 'captured credentials revealed';
export const ACCION_BUSCAR = 'captured password looked up';

export type Revelado =
	| { ok: true; contrasena: string | null; campos: Record<string, string> }
	| { ok: false; error: string };

const texto = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

const NO_SE_PUEDE: Record<'sin-clave' | 'otra-clave' | 'ilegible' | 'perdida', string> = {
	'sin-clave':
		'This node does not have its key (CLAVE_SECRETOS): the credentials cannot be decrypted.',
	'otra-clave':
		'These credentials were encrypted with a different node key (e.g. before restoring a backup on another machine).',
	ilegible: 'The stored credentials cannot be read.',
	perdida:
		'This node had no key (CLAVE_SECRETOS) when the event arrived: only the masked value was kept.'
};

/*
 * Revela las credenciales de un evento. Quien llama ya ha comprobado el permiso
 * ver-credenciales; aquí se audita SIEMPRE, también si no se pudo descifrar,
 * antes de devolver nada. En la auditoría va qué evento y qué campos, nunca los valores.
 */
export async function revelarDeEvento(quien: string, id: string): Promise<Revelado> {
	const [f] = await db
		.select({
			id: s.eventos.id,
			hash: s.eventos.hash,
			credencial: s.eventos.credencial,
			contrasena: s.eventos.contrasena,
			trampa: s.eventos.trampa,
			ip: s.eventos.ip
		})
		.from(s.eventos)
		.where(eq(s.eventos.id, id));
	if (!f || (f.credencial === null && f.contrasena === null))
		return { ok: false, error: 'That event has no captured credentials.' };
	const r: Revelado =
		f.credencial === null
			? { ok: true, contrasena: f.contrasena, campos: {} }
			: f.credencial === ''
				? { ok: false, error: NO_SE_PUEDE.perdida }
				: (() => {
						const a = abrir(f.credencial!, f.hash);
						if (!a.ok) return { ok: false as const, error: NO_SE_PUEDE[a.motivo] };
						return {
							ok: true as const,
							contrasena: a.credencial.contrasena,
							campos: Object.fromEntries(
								Object.entries(a.credencial.detalle).map(([k, v]) => [k, texto(v)])
							)
						};
					})();
	await db.insert(s.auditoria).values({
		quien,
		accion: ACCION_REVELAR,
		detalle: {
			evento: f.id,
			trampa: f.trampa,
			origen: f.ip,
			campos: r.ok ? Object.keys(r.campos) : [],
			contrasena: r.ok && r.contrasena !== null,
			resultado: r.ok ? 'revealed' : 'not readable'
		}
	});
	return r;
}

/* Revela una contraseña de «Captured passwords» (por su huella), del último evento que la trae. */
export async function revelarPorHuella(quien: string, h: string): Promise<Revelado> {
	if (!/^[0-9a-f]{32}$/.test(h)) return { ok: false, error: 'Unknown password.' };
	const [f] = await db
		.select({ id: s.eventos.id })
		.from(s.eventos)
		.where(
			and(
				eq(s.eventos.contrasenaHuella, h),
				isNotNull(s.eventos.credencial),
				sql`${s.eventos.credencial} <> ''`
			)
		)
		.orderBy(desc(s.eventos.cuando))
		.limit(1);
	if (!f) return { ok: false, error: 'Unknown password.' };
	return revelarDeEvento(quien, f.id);
}

/*
 * ¿Se probó esta contraseña? Por su huella, sin descifrar nada: sirve para
 * comprobar si una contraseña real de la empresa ha llegado a una trampa. Como
 * confirma una contraseña, también queda en la auditoría (sin el texto buscado).
 */
export async function buscarContrasena(quien: string, buscada: string) {
	const h = huella(buscada.slice(0, MAXIMO_CREDENCIAL));
	if (!h) return null;
	const filas = await contrasenas(h);
	await db.insert(s.auditoria).values({
		quien,
		accion: ACCION_BUSCAR,
		detalle: { encontrada: filas.length > 0 }
	});
	return filas;
}
