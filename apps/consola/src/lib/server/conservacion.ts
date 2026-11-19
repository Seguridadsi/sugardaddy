/*
 * Cuánto guarda la consola los eventos. De lo que recogen las trampas el
 * responsable es el cliente (docs/negocio/legal/plantilla-eipd-cliente.md):
 * el plazo lo decide él en Ajustes, y por defecto es 1 año. Cada hora se
 * borra lo que lo ha pasado, eventos y cuarentena.
 *
 * La auditoría de la consola (quién entra y qué hace) se guarda 1 año, o lo
 * mismo que los eventos si es más: así siempre queda rastro de al menos un
 * año, también de quién cambió el plazo.
 *
 * Las entradas de lista negra/blanca con caducidad vencida se borran también
 * cada hora, con el TTL que eligió el cliente al añadir cada una (al margen del
 * plazo de conservación de eventos). Lo que no caduca (caduca NULL) se queda.
 *
 * Las credenciales que capturan las trampas (contraseñas, hashes, tokens;
 * credenciales-protegidas.ts) tienen su propio plazo, más corto: 90 días por
 * defecto, nunca más que el de los eventos. Pasado, se borra su sobre cifrado y
 * el evento se queda con la máscara (P*****d1) y la huella, que sigue agrupando
 * «Captured passwords» sin poder revelar nada. Mismo margen de 30 días la
 * primera vez.
 *
 * Dos cuidados:
 *
 * - La cadena de cada sensor tiene que seguir verificable. Se borra por
 *   «recibido», que es el mismo para toda una entrega, así que el corte cae
 *   siempre entre entregas. La auditoría apunta, por sensor, el hash de la
 *   última línea borrada: es el hashAnterior con el que sigue la cadena.
 * - Un nodo que se actualiza solo a esta versión no pierde nada de golpe: el
 *   primer borrado espera 30 días desde que se fija el plazo, para que el
 *   cliente lo vea en Ajustes y lo cambie si quiere.
 */
import { eq, inArray, lt, or, sql } from 'drizzle-orm';
import { db, schema as s } from './db';
import { auditar } from './consultas';
import { CREDENCIAL_CADUCADA } from './credenciales-protegidas';

export const DIAS_POR_DEFECTO = 365;
export const DIAS_MINIMO = 30;
export const DIAS_MAXIMO = 3650;
export const DIAS_AUDITORIA = 365;
const AVISO = 30 * 86_400_000;
const LOTE = 5000;
const DIA = 86_400_000;

export const DIAS_CREDENCIALES_POR_DEFECTO = 90;
export const DIAS_CREDENCIALES_MINIMO = 1;

export type Conservacion = { dias: number; aPartirDe: string };

export function validarDias(v: unknown): number | null {
	const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
	return Number.isInteger(n) && n >= DIAS_MINIMO && n <= DIAS_MAXIMO ? n : null;
}

export function validarDiasCredenciales(v: unknown): number | null {
	const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
	return Number.isInteger(n) && n >= DIAS_CREDENCIALES_MINIMO && n <= DIAS_MAXIMO ? n : null;
}

/* Hasta qué fecha se borra ahora, o null si todavía no toca. */
export function limiteDeBorrado(c: Conservacion, ahora: Date): Date | null {
	if (ahora.getTime() < Date.parse(c.aPartirDe)) return null;
	return new Date(ahora.getTime() - c.dias * DIA);
}

/* Lo mismo para la auditoría: nunca menos de un año. */
export function limiteDeAuditoria(c: Conservacion, ahora: Date): Date | null {
	if (ahora.getTime() < Date.parse(c.aPartirDe)) return null;
	return new Date(ahora.getTime() - Math.max(c.dias, DIAS_AUDITORIA) * DIA);
}

const CLAVE_EVENTOS = 'conservacion';
const CLAVE_CREDENCIALES = 'conservacion-credenciales';

async function leer(clave = CLAVE_EVENTOS): Promise<Conservacion | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, clave));
	return (f?.valor as Conservacion) ?? null;
}

async function guardar(valor: Conservacion, clave = CLAVE_EVENTOS) {
	await db
		.insert(s.ajustes)
		.values({ clave, valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
}

async function vigente(clave: string, dias: number, ahora: Date): Promise<Conservacion> {
	const c = await leer(clave);
	if (c) return c;
	const nuevo = { dias, aPartirDe: new Date(ahora.getTime() + AVISO).toISOString() };
	await guardar(nuevo, clave);
	return nuevo;
}

/* El plazo vigente. La primera vez se fija el de por defecto, con su aviso de 30 días. */
export const conservacion = (ahora = new Date()) => vigente(CLAVE_EVENTOS, DIAS_POR_DEFECTO, ahora);

/* El de las credenciales capturadas, igual. */
export const conservacionCredenciales = (ahora = new Date()) =>
	vigente(CLAVE_CREDENCIALES, DIAS_CREDENCIALES_POR_DEFECTO, ahora);

/*
 * Hasta qué fecha se borran ahora las credenciales, o null si aún no toca. Nunca
 * después que los eventos: con un plazo de eventos más corto, manda ese.
 */
export function limiteDeCredenciales(
	cred: Conservacion,
	eventos: Conservacion,
	ahora: Date
): Date | null {
	if (ahora.getTime() < Date.parse(cred.aPartirDe)) return null;
	return new Date(ahora.getTime() - Math.min(cred.dias, eventos.dias) * DIA);
}

export async function cambiarPlazoCredenciales(quien: string, dias: number) {
	const antes = await conservacionCredenciales();
	await guardar({ ...antes, dias }, CLAVE_CREDENCIALES);
	await auditar(quien, 'captured credentials retention changed', {
		antes: antes.dias,
		ahora: dias
	});
}

/*
 * Borra el sobre de las credenciales de lo recibido antes de «limite» (y la
 * contraseña en claro de las filas de antes de la 0063, si quedara alguna). La
 * línea, su hash, la máscara y la huella no se tocan: la cadena sigue igual.
 */
export async function olvidarCredencialesAntesDe(limite: Date) {
	let n = 0;
	for (;;) {
		const lote = await db.execute<{ id: string }>(sql`
			update ${s.eventos} set credencial = ${CREDENCIAL_CADUCADA}, contrasena = null
			where ${s.eventos.id} in (
				select ${s.eventos.id} from ${s.eventos}
				where ${s.eventos.recibido} < ${limite.toISOString()}
				and (
					(${s.eventos.credencial} is not null and ${s.eventos.credencial} not in ('', ${CREDENCIAL_CADUCADA}))
					or ${s.eventos.contrasena} is not null
				)
				limit ${LOTE}
			)
			returning ${s.eventos.id}
		`);
		if (!lote.length) break;
		n += lote.length;
	}
	return n;
}

export async function cambiarPlazo(quien: string, dias: number) {
	const antes = await conservacion();
	await guardar({ ...antes, dias });
	await auditar(quien, 'retention period changed', { antes: antes.dias, ahora: dias });
}

type Linea = { sensor: string; hash: string; anterior: string | null; recibido: Date };
type Ultima = { recibido: number; lineas: Linea[] };

/*
 * Por sensor, la última entrega borrada (la de «recibido» mayor). Dentro de
 * ella, la cola de la cadena es la línea a la que no apunta ninguna otra.
 *
 * Las balizas que llegaron por el relé se guardan bajo un sensor real pero SIN
 * cadena firmada (hashAnterior vacío; docs/diseno/rele-balizas.md): no son parte
 * de la cadena del sensor, así que no cuentan para el hash de reanudación —si
 * contaran, lo envenenarían con un hash que no encadena nada—. Se borran igual,
 * solo no definen la cola.
 */
function anotar(ultimas: Map<string, Ultima>, lineas: Linea[]) {
	for (const l of lineas) {
		if (l.anterior === '') continue;
		const r = l.recibido.getTime();
		const u = ultimas.get(l.sensor);
		if (!u || r > u.recibido) ultimas.set(l.sensor, { recibido: r, lineas: [l] });
		else if (r === u.recibido) u.lineas.push(l);
	}
}

function colas(ultimas: Map<string, Ultima>) {
	const cadena: Record<string, string[]> = {};
	for (const [sensor, u] of ultimas) {
		const apuntadas = new Set(u.lineas.map((l) => l.anterior));
		const cola = u.lineas.filter((l) => !apuntadas.has(l.hash)).map((l) => l.hash);
		cadena[sensor] = cola.length ? cola : u.lineas.map((l) => l.hash);
	}
	return cadena;
}

/*
 * Borra lo recibido antes de «limite», por lotes y cada lote en su
 * transacción. Con cada evento se va lo que cuelga de él: activaciones, la
 * cola de las salidas y lo que dejó el motor de respuesta; una prueba que lo
 * tenía como su primer evento se queda sin él.
 */
export async function borrarAntesDe(limite: Date) {
	const ultimas = new Map<string, Ultima>();
	let eventos = 0;
	for (;;) {
		const lote = await db.transaction(async (tx) => {
			const filas = await tx
				.select({
					id: s.eventos.id,
					sensor: s.eventos.sensor,
					hash: s.eventos.hash,
					anterior: sql<string | null>`(${s.eventos.linea}::jsonb)->>'hashAnterior'`,
					recibido: s.eventos.recibido
				})
				.from(s.eventos)
				.where(lt(s.eventos.recibido, limite))
				.orderBy(s.eventos.recibido)
				.limit(LOTE);
			if (!filas.length) return filas;
			const ids = filas.map((f) => f.id);
			const aprobadas = tx
				.select({ id: s.aprobaciones.id })
				.from(s.aprobaciones)
				.where(inArray(s.aprobaciones.evento, ids));
			await tx
				.delete(s.ejecuciones)
				.where(
					or(inArray(s.ejecuciones.evento, ids), inArray(s.ejecuciones.aprobacion, aprobadas))
				);
			await tx.delete(s.aprobaciones).where(inArray(s.aprobaciones.evento, ids));
			await tx.delete(s.activaciones).where(inArray(s.activaciones.evento, ids));
			await tx.delete(s.salidasCola).where(inArray(s.salidasCola.evento, ids));
			await tx.update(s.pruebas).set({ evento: null }).where(inArray(s.pruebas.evento, ids));
			await tx.delete(s.eventos).where(inArray(s.eventos.id, ids));
			return filas;
		});
		if (!lote.length) break;
		anotar(ultimas, lote);
		eventos += lote.length;
	}
	let cuarentena = 0;
	for (;;) {
		const lote = await db.execute<Linea>(sql`
			delete from ${s.cuarentena}
			where ${s.cuarentena.id} in (
				select ${s.cuarentena.id} from ${s.cuarentena}
				where ${s.cuarentena.recibido} < ${limite.toISOString()}
				order by ${s.cuarentena.recibido} limit ${LOTE}
			)
			returning sensor, hash, hash_anterior as anterior, recibido
		`);
		if (!lote.length) break;
		anotar(
			ultimas,
			lote.map((l) => ({ ...l, recibido: new Date(l.recibido) }))
		);
		cuarentena += lote.length;
	}
	return { eventos, cuarentena, cadena: colas(ultimas) };
}

/*
 * Las entradas de lista (negra/blanca) con caducidad ya vencida, de una vez. El
 * TTL lo elige el cliente al añadir cada una; esto hace cumplir esa caducidad,
 * igual que edl() y el guard «intocable» ya ignoran lo vencido. No toca lo que
 * no caduca (caduca NULL): listas «para siempre» y globales sin plazo se quedan.
 */
export async function borrarListasVencidasAntesDe(ahora: Date) {
	const [{ n }] = await db.execute<{ n: number }>(sql`
		with borradas as (
			delete from ${s.listas}
			where ${s.listas.caduca} is not null and ${s.listas.caduca} < ${ahora.toISOString()}
			returning 1
		)
		select count(*)::int as n from borradas
	`);
	return n;
}

/*
 * La auditoría anterior a «limite»: dice cuántas entradas, no cuáles. La auditoría
 * no se deja borrar (migración 0058): lo hace auditoria_purgar, con su propio rol,
 * y deja en la cadena la fila «audit log purged» con hasta qué id llegó y el hash
 * de la última que borró, del que cuelga la primera que queda. Solo se va el
 * principio de la cadena: una fila con una fecha del pasado no se lleva las de
 * después.
 */
export async function borrarAuditoriaAntesDe(limite: Date) {
	const [{ n }] = await db.execute<{ n: number }>(
		sql`select auditoria_purgar(${limite.toISOString()}::timestamptz) as n`
	);
	return Number(n);
}

/*
 * Las sesiones que ya no pueden valer: ninguna dura más de ocho horas
 * (auth/sesion.ts), así que una de hace más de una semana solo ocupa. Quién
 * entró y cuándo queda en la auditoría, no aquí.
 */
export const SESIONES_MUERTAS_MS = 7 * 24 * 60 * 60_000;
export async function borrarSesionesMuertas(ahora = new Date()) {
	const limite = new Date(ahora.getTime() - SESIONES_MUERTAS_MS);
	const [{ n }] = await db.execute<{ n: number }>(sql`
		with borradas as (
			delete from ${s.sesiones}
			where ${s.sesiones.creada} < ${limite.toISOString()}
			returning 1
		)
		select count(*)::int as n from borradas
	`);
	return n;
}

/*
 * Lo que corre cada hora (hooks.server.ts). Primero los eventos y su apunte de
 * la cadena; después la auditoría, que nunca alcanza a ese apunte recién hecho.
 */
export async function purgar(ahora = new Date()) {
	/* Las entradas de lista caducadas se van cada hora, con su propio TTL, al
	 * margen del plazo de conservación de eventos (y de su aviso de 30 días). */
	const listas = await borrarListasVencidasAntesDe(ahora);
	if (listas) await auditar('node', 'expired list entries deleted', { entradas: listas });
	await borrarSesionesMuertas(ahora);
	const c = await conservacion(ahora);
	const cc = await conservacionCredenciales(ahora);
	const limiteCred = limiteDeCredenciales(cc, c, ahora);
	const credenciales = limiteCred ? await olvidarCredencialesAntesDe(limiteCred) : 0;
	if (credenciales)
		await auditar(
			'node',
			`captured credentials older than ${Math.min(cc.dias, c.dias)} days deleted`,
			{
				antesDe: limiteCred!.toISOString(),
				eventos: credenciales
			}
		);
	const limite = limiteDeBorrado(c, ahora);
	const limiteAuditoria = limiteDeAuditoria(c, ahora);
	if (!limite || !limiteAuditoria) return { listas, credenciales };
	const r = await borrarAntesDe(limite);
	if (r.eventos || r.cuarentena)
		await auditar('node', `events older than ${c.dias} days deleted`, {
			antesDe: limite.toISOString(),
			...r
		});
	/* La propia purga deja su fila en la auditoría («audit log purged»). */
	const auditoria = await borrarAuditoriaAntesDe(limiteAuditoria);
	/* Lo grabado del soporte se queda lo mismo que la auditoría (soporte-registro.ts). */
	await db.delete(s.soporteRegistro).where(lt(s.soporteRegistro.cuando, limiteAuditoria));
	return { ...r, auditoria, listas, credenciales };
}
