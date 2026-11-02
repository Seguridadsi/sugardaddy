/*
 * «¿Has olvidado la contraseña?» del login local: un código de 6 cifras al
 * correo de recuperación del usuario. El nodo genera el código y guarda solo su
 * hash; lo entrega por correo el panel de SeguridadSI, porque un nodo no tiene
 * cómo mandar correo: por el canal firmado si a este nodo lo gestiona un panel,
 * y por la puerta abierta de community si no.
 *
 * SeguridadSI también puede mandar un código desde su panel al correo de
 * contacto de un cliente de pago (canal.ts lo recibe, solo su hash, en el estado
 * firmado): se canjea aquí igual, con origen «panel».
 *
 * Reglas que no se tocan:
 *  - Nunca se dice si el usuario existe o tiene correo: la respuesta es la misma
 *    y el envío va aparte, para que tampoco lo delate el reloj.
 *  - El código caduca a los 15 minutos y aguanta 5 intentos; pedir otro anula el
 *    anterior. Como mucho uno por minuto y 5 por hora para cada usuario.
 *  - Canjearlo cambia la contraseña y desbloquea la cuenta; queda en la auditoría.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { codigoRecuperacionCorrecto, hashCodigoRecuperacion } from '@sugardaddy/canal';
import { db, schema as s } from '../db';
import { auditar } from '../consultas';
import { mandarCodigoPorCanal, urlPanelValida } from '../canal';
import { cambiarClave, correoValido, loginLocalHabilitado, MIN_CLAVE } from './local';
import type { Identidad } from './entra';

export const MINUTOS_CODIGO = 15;
const INTENTOS = 5;
const POR_HORA = 5;
const ENTRE_PETICIONES_MS = 60_000;

const PANEL = (env.SUGARDADDY_PANEL_URL ?? 'https://sugardaddy-central.azurewebsites.net').replace(
	/\/+$/,
	''
);

const rc = s.recuperacionesClave;
const norma = (u: string) => u.trim().toLowerCase().slice(0, 64);

export const hashCodigo = hashCodigoRecuperacion;
export const codigoCorrecto = codigoRecuperacionCorrecto;

/* Lleva el código al panel para que lo mande. true si el panel dice que lo ha mandado. */
async function mandar(correo: string, codigo: string): Promise<boolean> {
	const porCanal = await mandarCodigoPorCanal(correo, codigo);
	if (porCanal !== null) return porCanal;
	if (!urlPanelValida(PANEL)) return false;
	try {
		const r = await fetch(`${PANEL}/api/recuperacion`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ correo, codigo }),
			signal: AbortSignal.timeout(15_000)
		});
		return r.status === 202;
	} catch {
		return false;
	}
}

async function enviarYApuntar(usuario: string, correo: string, codigo: string) {
	const enviado = await mandar(correo, codigo);
	await auditar('anónimo', 'código de recuperación pedido', {
		usuario,
		resultado: enviado ? 'enviado' : 'no se pudo enviar'
	});
}

/*
 * Pide un código para `usuario`. No devuelve nada a propósito: quien llama
 * contesta siempre lo mismo. El envío no se espera (ver la cabecera).
 */
export async function pedirCodigo(usuario: string): Promise<void> {
	if (!loginLocalHabilitado()) return;
	const nombre = norma(usuario);
	const [u] = nombre
		? await db
				.select({ id: s.usuariosLocales.id, correo: s.usuariosLocales.correo })
				.from(s.usuariosLocales)
				.where(eq(s.usuariosLocales.usuario, nombre))
		: [];
	if (!u || !correoValido(u.correo)) {
		await auditar('anónimo', 'código de recuperación pedido', {
			usuario: nombre,
			resultado: u ? 'sin correo' : 'no existe'
		});
		return;
	}

	const ahora = Date.now();
	const recientes = await db
		.select({ creada: rc.creada })
		.from(rc)
		.where(
			and(
				eq(rc.usuarioId, u.id),
				eq(rc.origen, 'correo'),
				gt(rc.creada, new Date(ahora - 3600_000))
			)
		);
	if (
		recientes.length >= POR_HORA ||
		recientes.some((r) => ahora - r.creada.getTime() < ENTRE_PETICIONES_MS)
	) {
		await auditar('anónimo', 'código de recuperación pedido', {
			usuario: nombre,
			resultado: 'frenado'
		});
		return;
	}

	const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
	await db.transaction(async (tx) => {
		/* Pedir otro anula el que hubiera abierto. */
		await tx
			.update(rc)
			.set({ cerrada: new Date(ahora) })
			.where(and(eq(rc.usuarioId, u.id), eq(rc.origen, 'correo'), isNull(rc.cerrada)));
		await tx.insert(rc).values({
			id: randomUUID(),
			usuarioId: u.id,
			codigoHash: hashCodigo(codigo),
			origen: 'correo',
			caduca: new Date(ahora + MINUTOS_CODIGO * 60_000)
		});
	});
	void enviarYApuntar(nombre, u.correo, codigo).catch(() => {});
}

export type Canje = { ok: true; id: string; identidad: Identidad } | { ok: false; error: string };

const NO_VALE = 'El código no vale o ha caducado. Pide otro.';

/* Canjea el código: si vale, pone la contraseña nueva y cierra todos los códigos abiertos del usuario. */
export async function canjearCodigo(
	usuario: string,
	codigo: string,
	nueva: string
): Promise<Canje> {
	if (!loginLocalHabilitado()) return { ok: false, error: NO_VALE };
	if (nueva.length < MIN_CLAVE)
		return { ok: false, error: `La contraseña necesita al menos ${MIN_CLAVE} caracteres.` };
	const limpio = codigo.replace(/\s+/g, '');
	const nombre = norma(usuario);
	if (!/^\d{6}$/.test(limpio) || !nombre) return { ok: false, error: NO_VALE };

	const [u] = await db
		.select({ id: s.usuariosLocales.id })
		.from(s.usuariosLocales)
		.where(eq(s.usuariosLocales.usuario, nombre));
	if (!u) return { ok: false, error: NO_VALE };

	const abiertas = await db
		.select()
		.from(rc)
		.where(
			and(
				eq(rc.usuarioId, u.id),
				isNull(rc.cerrada),
				gt(rc.caduca, new Date()),
				lt(rc.intentos, INTENTOS)
			)
		);
	const buena = abiertas.find((r) => codigoCorrecto(limpio, r.codigoHash));
	if (!buena) {
		if (abiertas.length)
			await db
				.update(rc)
				.set({ intentos: sql`${rc.intentos} + 1` })
				.where(
					inArray(
						rc.id,
						abiertas.map((a) => a.id)
					)
				);
		await auditar('anónimo', 'código de recuperación fallido', { usuario: nombre });
		return { ok: false, error: NO_VALE };
	}

	/* Se gasta de forma atómica: con dos peticiones a la vez, solo una lo cierra. */
	const [gastada] = await db
		.update(rc)
		.set({ cerrada: new Date() })
		.where(and(eq(rc.id, buena.id), isNull(rc.cerrada)))
		.returning({ id: rc.id });
	if (!gastada) return { ok: false, error: NO_VALE };
	await db
		.update(rc)
		.set({ cerrada: new Date() })
		.where(and(eq(rc.usuarioId, u.id), isNull(rc.cerrada)));

	const r = await cambiarClave(u.id, nueva);
	if (!r.ok) return r;
	await auditar(r.identidad.correo, 'contraseña restablecida con código', {
		usuario: nombre,
		origen: buena.origen
	});
	return { ok: true, id: u.id, identidad: r.identidad };
}
