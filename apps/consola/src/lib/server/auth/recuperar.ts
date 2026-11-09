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
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { codigoRecuperacionCorrecto, hashCodigoRecuperacion } from '@sugardaddy/canal';
import { db, schema as s } from '../db';
import { auditar } from '../consultas';
import { mandarCodigoPorCanal, urlPanelValida } from '../canal';
import { Freno, claveIp } from './freno';
import { cambiarClave, correoValido, loginLocalHabilitado, MIN_CLAVE } from './local';
import type { Identidad } from './entra';

export const MINUTOS_CODIGO = 15;
const INTENTOS = 5;
const POR_HORA = 5;
/*
 * Tope de códigos por usuario y día: con 5 intentos por código, como mucho
 * 50 intentos al día sobre un millón de códigos, y cada uno llega por correo a
 * su dueño.
 */
const POR_DIA = 10;
const ENTRE_PETICIONES_MS = 60_000;

/*
 * Frenos por IP, aparte de los de cada usuario y cada código: quien prueba
 * códigos o pide muchos desde una misma dirección se para ahí, sea cual sea el
 * usuario. No hay uno global: con unas pocas IP cualquiera lo gastaría y nadie
 * podría recuperar su cuenta. Lo que se adivina desde muchas IP ya lo acotan los
 * cinco intentos de cada código y los diez códigos al día de cada usuario.
 */
const PEDIR_POR_IP = new Freno(10, 3600_000);
const CANJE_POR_IP = new Freno(10, 15 * 60_000);
export const DEMASIADOS = 'Too many attempts. Wait a few minutes and try again.';

/* Para las pruebas. */
export function _olvidarFrenos() {
	PEDIR_POR_IP.olvidar();
	CANJE_POR_IP.olvidar();
}

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
	await auditar('anonymous', 'recovery code requested', {
		usuario,
		resultado: enviado ? 'sent' : 'could not be sent'
	});
}

/*
 * Pide un código para `usuario`. No devuelve nada a propósito: quien llama
 * contesta siempre lo mismo. El envío no se espera (ver la cabecera).
 */
export async function pedirCodigo(usuario: string, ip?: string | null): Promise<void> {
	if (!loginLocalHabilitado()) return;
	const nombre = norma(usuario);
	if (ip !== undefined && !PEDIR_POR_IP.pasa(claveIp(ip))) {
		await auditar('anonymous', 'recovery code requested', {
			usuario: nombre,
			resultado: 'throttled by address'
		});
		return;
	}
	const [u] = nombre
		? await db
				.select({ id: s.usuariosLocales.id, correo: s.usuariosLocales.correo })
				.from(s.usuariosLocales)
				.where(eq(s.usuariosLocales.usuario, nombre))
		: [];
	if (!u || !correoValido(u.correo)) {
		await auditar('anonymous', 'recovery code requested', {
			usuario: nombre,
			resultado: u ? 'no email' : 'does not exist'
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
				gt(rc.creada, new Date(ahora - 86_400_000))
			)
		);
	const enLaHora = recientes.filter((r) => ahora - r.creada.getTime() < 3600_000);
	if (
		recientes.length >= POR_DIA ||
		enLaHora.length >= POR_HORA ||
		recientes.some((r) => ahora - r.creada.getTime() < ENTRE_PETICIONES_MS)
	) {
		await auditar('anonymous', 'recovery code requested', {
			usuario: nombre,
			resultado: 'throttled'
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

const NO_VALE = 'The code is not valid or has expired. Request another.';

/* Canjea el código: si vale, pone la contraseña nueva y cierra todos los códigos abiertos del usuario. */
export async function canjearCodigo(
	usuario: string,
	codigo: string,
	nueva: string,
	ip?: string | null
): Promise<Canje> {
	if (!loginLocalHabilitado()) return { ok: false, error: NO_VALE };
	if (ip !== undefined && !CANJE_POR_IP.pasa(claveIp(ip))) {
		await auditar('anonymous', 'recovery code failed', {
			usuario: norma(usuario),
			resultado: 'throttled by address'
		});
		return { ok: false, error: DEMASIADOS };
	}
	if (nueva.length < MIN_CLAVE)
		return { ok: false, error: `The password needs at least ${MIN_CLAVE} characters.` };
	const limpio = codigo.replace(/\s+/g, '');
	const nombre = norma(usuario);
	if (!/^\d{6}$/.test(limpio) || !nombre) return { ok: false, error: NO_VALE };

	const [u] = await db
		.select({ id: s.usuariosLocales.id })
		.from(s.usuariosLocales)
		.where(eq(s.usuariosLocales.usuario, nombre));
	if (!u) return { ok: false, error: NO_VALE };

	/*
	 * El intento se gasta ANTES de comparar, en la misma sentencia que mira si
	 * quedan: con peticiones a la vez, Postgres vuelve a evaluar el «intentos < 5»
	 * de cada una tras la anterior, así que entre todas no pasan de 5 por código.
	 * Leer primero y sumar después dejaba comparar sin límite en paralelo.
	 */
	const abiertas = await db
		.update(rc)
		.set({ intentos: sql`${rc.intentos} + 1` })
		.where(
			and(
				eq(rc.usuarioId, u.id),
				isNull(rc.cerrada),
				gt(rc.caduca, new Date()),
				lt(rc.intentos, INTENTOS)
			)
		)
		.returning({ id: rc.id, codigoHash: rc.codigoHash, origen: rc.origen });
	const buena = abiertas.find((r) => codigoCorrecto(limpio, r.codigoHash));
	if (!buena) {
		await auditar('anonymous', 'recovery code failed', { usuario: nombre });
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
	await auditar(r.identidad.correo, 'password reset with code', {
		usuario: nombre,
		origen: buena.origen
	});
	return { ok: true, id: u.id, identidad: r.identidad };
}
