/*
 * El registro gratuito de un nodo Community (docs/diseno/registro-community.md).
 *
 * Un solo correo y un solo registro: al confirmarlo, el nodo tiene las trampas de
 * registro y las actualizaciones automáticas. Pedido desde aquí, al correo llega un
 * código corto, sin enlace ni la dirección del panel: la persona lo escribe en
 * Ajustes, acepta allí las condiciones y la consola recoge sola el código de
 * activación (canjear). Pedido desde la web, el código de activación sale en la web
 * y se pega en Ajustes (activar).
 * El código se verifica aquí contra la clave de publicación: el panel no decide,
 * y sin una licencia auténtica no se desbloquea nada.
 *
 * Con las actualizaciones automáticas activas, el nodo dice además al panel en qué
 * versión está cuando mira si hay una nueva (avisarContacto): token y versión, nada
 * más. Quien las apaga deja de contarlo.
 *
 * La renovación manda solo el token, cada varias horas, y nunca para nada más:
 * si falla, la licencia se queda como está hasta que caduque (falla cerrado), y
 * con ella caducada las trampas de registro salen del plan. Cowrie no depende de
 * esto, ni la recepción de eventos.
 */
import { eq } from 'drizzle-orm';
import {
	decodificarCodigo,
	funcionaHastaDe,
	licenciaDeRegistro,
	type Licencia,
	type LicenciaFirmada
} from '@sugardaddy/canal';
import { env } from '$env/dynamic/private';
import { confianza } from './claves';
import { urlPanelValida, gestionadoPorPanel } from './canal';
import { licenciaGuardada } from './candado';
import { auditar, autoActualizar, cabecera, guardarAutoActualizar } from './consultas';
import { db, schema as s } from './db';
import { esCommunity } from './edicion';
import { cifrar, descifrar, estadoClave } from './secretos';

const CONTEXTO = 'registro-community';
const PANEL = (env.SUGARDADDY_PANEL_URL ?? 'https://sugardaddy-central.azurewebsites.net').replace(
	/\/+$/,
	''
);

/* Lo que guarda el nodo de su registro. El token, cifrado con la clave del nodo. */
type Guardado = {
	correo: string;
	token: string;
	activado: string;
	renovada: string | null;
	fallo: string | null;
};

export type EstadoRegistro = {
	estado: 'sin' | 'vigente' | 'caducada' | 'invalida';
	correo: string | null;
	caduca: string | null;
	/* Hasta cuándo siguen funcionando las trampas de registro ya desplegadas (B-06). */
	funcionaHasta: string | null;
	renovada: string | null;
	fallo: string | null;
	/* La clave de publicación está: sin ella ningún código puede verificarse. */
	verificable: boolean;
	/* El correo al que se mandó un código hace menos de un día, para escribirlo aquí. */
	pendiente: string | null;
};

/* Lo pedido desde aquí: a qué correo y cuándo. El código del correo vale un día. */
type Pedido = { correo: string; pedido: string };
const HORAS_PEDIDO = 24;

async function pedido(ahora = Date.now()): Promise<Pedido | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'registro-pedido'));
	const p = f?.valor as Pedido | undefined;
	return p && ahora - Date.parse(p.pedido) < HORAS_PEDIDO * 3600_000 ? p : null;
}

async function apuntarPedido(valor: Pedido | null) {
	if (!valor) {
		await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'registro-pedido'));
		return;
	}
	await db
		.insert(s.ajustes)
		.values({ clave: 'registro-pedido', valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
}

async function guardado(): Promise<Guardado | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'registro'));
	return (f?.valor as Guardado | undefined) ?? null;
}

async function escribir(valor: Guardado) {
	await db
		.insert(s.ajustes)
		.values({ clave: 'registro', valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
}

async function guardarLicencia(valor: LicenciaFirmada) {
	await db
		.insert(s.ajustes)
		.values({ clave: 'licencia', valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
}

export const puedeRegistrarse = async () => esCommunity() && !(await gestionadoPorPanel());

export async function estadoRegistro(ahora = Date.now()): Promise<EstadoRegistro> {
	const clave = confianza();
	const r = await guardado();
	const base = {
		correo: r?.correo ?? null,
		renovada: r?.renovada ?? null,
		fallo: r?.fallo ?? null,
		verificable: !!clave,
		pendiente: (await pedido(ahora))?.correo ?? null
	};
	const lic = r ? await licenciaGuardada() : null;
	if (!r || !lic) return { ...base, estado: 'sin', caduca: null, funcionaHasta: null };
	if (!clave) return { ...base, estado: 'invalida', caduca: null, funcionaHasta: null };
	const autentica = licenciaDeRegistro(clave, lic, 0);
	if (!autentica.ok) return { ...base, estado: 'invalida', caduca: null, funcionaHasta: null };
	const vigente = licenciaDeRegistro(clave, lic, ahora);
	return {
		...base,
		estado: vigente.ok ? 'vigente' : 'caducada',
		caduca: autentica.licencia.caduca,
		funcionaHasta: funcionaHastaDe(autentica.licencia)
	};
}

/*
 * Solo el correo: la casilla de novedades y las condiciones se aceptan al escribir el
 * código. «entrega: codigo» pide el código corto en lugar del enlace (un panel
 * anterior lo ignora y manda el enlace, que sigue sirviendo).
 */
export async function pedirRegistro(
	correo: string,
	ahora = Date.now()
): Promise<'enviado' | 'no-disponible' | 'demasiados' | 'correo-invalido' | 'sin-conexion'> {
	if (!urlPanelValida(PANEL)) return 'no-disponible';
	const { nombre, nodo, version } = (await cabecera()).cliente;
	try {
		const res = await fetch(`${PANEL}/api/registro`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ correo, nombre, nodo, version, origen: 'consola', entrega: 'codigo' }),
			signal: AbortSignal.timeout(10_000)
		});
		if (res.ok) {
			await apuntarPedido({ correo, pedido: new Date(ahora).toISOString() });
			return 'enviado';
		}
		if (res.status === 503) return 'no-disponible';
		if (res.status === 429) return 'demasiados';
		if (res.status === 400) return 'correo-invalido';
		return 'no-disponible';
	} catch {
		return 'sin-conexion';
	}
}

export type Activacion = { ok: true; caduca: string } | { ok: false; error: string };

/* Pegar el código en Ajustes. Solo cuenta lo que verifica la cadena de firmas. */
export async function activar(
	quien: string,
	codigo: string,
	ahora = Date.now()
): Promise<Activacion> {
	if (!esCommunity()) return { ok: false, error: 'Registration is part of the Community edition.' };
	if (await gestionadoPorPanel())
		return {
			ok: false,
			error: 'This node is managed by a Central; it does not need registration.'
		};
	const clave = confianza();
	if (!clave)
		return {
			ok: false,
			error:
				'This node does not have the key to verify the code, so registration is not available on it.'
		};
	if (estadoClave() !== 'lista')
		return {
			ok: false,
			error:
				'This node has no CLAVE_SECRETOS in its .env file, and without it the registration cannot be saved.'
		};
	const c = decodificarCodigo(codigo);
	if (!c)
		return { ok: false, error: 'That does not look like an activation code. Copy the whole code.' };
	const v = licenciaDeRegistro(clave, c.licencia, ahora);
	if (!v.ok) {
		const mensaje = /caducad|expired/i.test(v.motivo)
			? 'That code has expired. Request a new one with your email.'
			: 'That code is not valid.';
		return { ok: false, error: mensaje };
	}
	const momento = new Date(ahora).toISOString();
	await escribir({
		correo: c.correo,
		token: cifrar({ token: c.token }, CONTEXTO),
		activado: momento,
		renovada: null,
		fallo: null
	});
	await guardarLicencia(c.licencia);
	/* El mismo registro da las actualizaciones automáticas: no hay un segundo correo. */
	await guardarAutoActualizar(quien, {
		decidido: true,
		activo: true,
		correo: c.correo,
		consentimiento: momento
	});
	await auditar(quien, 'registration activated', { hasta: v.licencia.caduca });
	return { ok: true, caduca: v.licencia.caduca };
}

/*
 * Escribir el código del correo: el panel lo cambia por el código de activación, que
 * se activa como si se hubiera pegado (se verifica aquí igual). Las condiciones las
 * acepta la persona en este formulario; sin eso no se manda nada.
 */
export async function canjear(
	quien: string,
	datos: { codigo: string; condiciones: boolean; novedades: boolean },
	ahora = Date.now()
): Promise<Activacion> {
	if (!(await puedeRegistrarse()))
		return { ok: false, error: 'This node does not need registration.' };
	if (!datos.condiciones)
		return { ok: false, error: 'To activate your registration you must accept the terms.' };
	const p = await pedido(ahora);
	if (!p) return { ok: false, error: 'The code has expired. Request a new one with your email.' };
	if (!urlPanelValida(PANEL))
		return { ok: false, error: 'Registration is not available right now.' };
	let res: Response;
	try {
		res = await fetch(`${PANEL}/api/registro/canjear`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				correo: p.correo,
				codigo: datos.codigo,
				condiciones: true,
				novedades: datos.novedades
			}),
			signal: AbortSignal.timeout(10_000)
		});
	} catch {
		return {
			ok: false,
			error: 'Could not reach the SeguridadSI Central. Check that the node has internet access.'
		};
	}
	const cuerpo = (await res.json().catch(() => null)) as { codigo?: unknown } | null;
	if (res.ok && typeof cuerpo?.codigo === 'string') {
		const r = await activar(quien, cuerpo.codigo, ahora);
		if (r.ok) await apuntarPedido(null);
		return r;
	}
	if (res.status === 410)
		return {
			ok: false,
			error:
				'That code is not valid. Check it against the email; after several wrong attempts, request a new one.'
		};
	if (res.status === 429) return { ok: false, error: 'Too many attempts. Try again in a while.' };
	return { ok: false, error: 'Registration is not available right now.' };
}

/* Toca renovar en el último tercio de su vida, o si ya ha caducado. */
function tocaRenovar(l: Licencia, ahora: number) {
	const emitida = Date.parse(l.emitida);
	const caduca = Date.parse(l.caduca);
	return ahora >= caduca - (caduca - emitida) / 3;
}

export type Renovacion =
	'no-toca' | 'renovada' | 'no-disponible' | 'retirado' | 'sin-conexion' | 'invalida';

/*
 * Renueva sin intervención. Nunca lanza por la red ni bloquea nada; lo que el
 * panel devuelva se verifica igual que el código pegado: si no es una licencia de
 * registro auténtica, vigente y más larga que la que hay, se ignora.
 */
export async function renovar(ahora = Date.now(), forzar = false): Promise<Renovacion> {
	if (!(await puedeRegistrarse())) return 'no-toca';
	const clave = confianza();
	const r = await guardado();
	if (!clave || !r) return 'no-toca';
	const actual = await licenciaGuardada();
	const autentica = actual ? licenciaDeRegistro(clave, actual, 0) : null;
	if (!autentica?.ok) return 'no-toca';
	if (!forzar && !tocaRenovar(autentica.licencia, ahora)) return 'no-toca';
	if (!urlPanelValida(PANEL)) return 'no-disponible';
	const d = descifrar(r.token, CONTEXTO);
	if (!d.ok || typeof d.valores.token !== 'string') {
		await escribir({ ...r, fallo: 'The token cannot be read: paste a new code.' });
		return 'invalida';
	}
	let res: Response;
	try {
		res = await fetch(`${PANEL}/api/registro/renovar`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token: d.valores.token }),
			signal: AbortSignal.timeout(10_000)
		});
	} catch {
		await escribir({ ...r, fallo: 'Could not reach the SeguridadSI Central.' });
		return 'sin-conexion';
	}
	if (res.status === 404) {
		await escribir({ ...r, fallo: 'This registration has been withdrawn: request a new code.' });
		return 'retirado';
	}
	/* Ya se renovó hace poco: no es un fallo, y la que hay sigue valiendo. */
	if (res.status === 429) return 'no-toca';
	if (!res.ok) {
		await escribir({ ...r, fallo: 'Renewal is not available right now.' });
		return 'no-disponible';
	}
	const cuerpo = (await res.json().catch(() => null)) as { licencia?: unknown } | null;
	const nueva = licenciaDeRegistro(clave, cuerpo?.licencia, ahora);
	if (!nueva.ok) {
		await escribir({ ...r, fallo: 'Central returned a license that is not valid.' });
		return 'invalida';
	}
	/* Una que no alarga la vigencia no sustituye a la que hay (p. ej. certificado por renovar). */
	if (Date.parse(nueva.licencia.caduca) <= Date.parse(autentica.licencia.caduca)) return 'no-toca';
	await guardarLicencia(cuerpo!.licencia as LicenciaFirmada);
	await escribir({ ...r, renovada: new Date(ahora).toISOString(), fallo: null });
	await auditar('registration', 'registration renewed', { hasta: nueva.licencia.caduca });
	return 'renovada';
}

/*
 * Un nodo registrado y con las actualizaciones automáticas activas cuenta al panel en qué
 * versión está, cada vez que mira si hay una nueva. Manda el token del registro y la
 * versión, nada más: ni eventos, ni honeypots, ni nombre de la máquina. Nunca lanza ni
 * bloquea nada, y lo que conteste el panel no cambia nada aquí.
 */
export async function avisarContacto(): Promise<'no-toca' | 'avisado' | 'sin-conexion'> {
	if (!(await puedeRegistrarse())) return 'no-toca';
	if (!(await autoActualizar()).activo) return 'no-toca';
	const r = await guardado();
	if (!r || !urlPanelValida(PANEL)) return 'no-toca';
	const d = descifrar(r.token, CONTEXTO);
	if (!d.ok || typeof d.valores.token !== 'string') return 'no-toca';
	try {
		const res = await fetch(`${PANEL}/api/registro/contacto`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token: d.valores.token, version: (await cabecera()).cliente.version }),
			signal: AbortSignal.timeout(10_000)
		});
		return res.ok ? 'avisado' : 'sin-conexion';
	} catch {
		return 'sin-conexion';
	}
}

/*
 * Lo mismo que panelesPorCanal para un nodo de Community registrado: manda el token del
 * registro y las IP públicas que lo han atacado, nada más. null si no está registrado o
 * no hay respuesta.
 */
export async function panelesPorRegistro(
	ips: string[]
): Promise<Record<
	string,
	{ agente: string; version: string | null; visto: string | null }
> | null> {
	if (!(await puedeRegistrarse())) return null;
	const r = await guardado();
	if (!r || !urlPanelValida(PANEL)) return null;
	const d = descifrar(r.token, CONTEXTO);
	if (!d.ok || typeof d.valores.token !== 'string') return null;
	try {
		const res = await fetch(`${PANEL}/api/registro/paneles`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token: d.valores.token, ips }),
			signal: AbortSignal.timeout(10_000)
		});
		if (!res.ok) return null;
		const c = (await res.json()) as { paneles?: unknown };
		return c?.paneles && typeof c.paneles === 'object' ? (c.paneles as never) : null;
	} catch {
		return null;
	}
}
