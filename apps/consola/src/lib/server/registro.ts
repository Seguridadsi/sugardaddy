/*
 * El registro gratuito de un nodo Community (docs/diseno/registro-community.md).
 *
 * Un solo correo y un solo registro: al confirmarlo, el nodo tiene las trampas de
 * registro y las actualizaciones automáticas. La persona pide el código desde
 * aquí o desde la web, lo recibe tras confirmar su correo y lo pega en Ajustes.
 * El código se verifica aquí contra la clave de publicación: el panel no decide,
 * y sin una licencia auténtica no se desbloquea nada.
 *
 * La renovación manda solo el token, cada varias horas, y nunca para nada más:
 * si falla, la licencia se queda como está hasta que caduque (falla cerrado), y
 * con ella caducada las trampas de registro salen del plan. Cowrie no depende de
 * esto, ni la recepción de eventos.
 */
import { eq } from 'drizzle-orm';
import {
	decodificarCodigo,
	licenciaDeRegistro,
	type Licencia,
	type LicenciaFirmada
} from '@sugardaddy/canal';
import { env } from '$env/dynamic/private';
import { urlPanelValida, gestionadoPorPanel } from './canal';
import { licenciaGuardada } from './candado';
import { auditar, cabecera, guardarAutoActualizar } from './consultas';
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
	renovada: string | null;
	fallo: string | null;
	/* La clave de publicación está: sin ella ningún código puede verificarse. */
	verificable: boolean;
};

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
	const clave = env.PUBLICACION_CLAVE_PUBLICA;
	const r = await guardado();
	const base = {
		correo: r?.correo ?? null,
		renovada: r?.renovada ?? null,
		fallo: r?.fallo ?? null,
		verificable: !!clave
	};
	const lic = r ? await licenciaGuardada() : null;
	if (!r || !lic) return { ...base, estado: 'sin', caduca: null };
	if (!clave) return { ...base, estado: 'invalida', caduca: null };
	const autentica = licenciaDeRegistro(clave, lic, 0);
	if (!autentica.ok) return { ...base, estado: 'invalida', caduca: null };
	const vigente = licenciaDeRegistro(clave, lic, ahora);
	return {
		...base,
		estado: vigente.ok ? 'vigente' : 'caducada',
		caduca: autentica.licencia.caduca
	};
}

/* Solo el correo: la casilla de novedades y las condiciones se aceptan al confirmarlo. */
export async function pedirRegistro(
	correo: string
): Promise<'enviado' | 'no-disponible' | 'demasiados' | 'correo-invalido' | 'sin-conexion'> {
	if (!urlPanelValida(PANEL)) return 'no-disponible';
	const { nombre, nodo, version } = (await cabecera()).cliente;
	try {
		const res = await fetch(`${PANEL}/api/registro`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ correo, nombre, nodo, version, origen: 'consola' }),
			signal: AbortSignal.timeout(10_000)
		});
		if (res.ok) return 'enviado';
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
	if (!esCommunity()) return { ok: false, error: 'El registro es de la edición Community.' };
	if (await gestionadoPorPanel())
		return { ok: false, error: 'Este nodo lo gestiona un panel; no necesita registro.' };
	const clave = env.PUBLICACION_CLAVE_PUBLICA;
	if (!clave)
		return {
			ok: false,
			error:
				'Este nodo no tiene la clave para comprobar el código, así que el registro no está disponible en él.'
		};
	if (estadoClave() !== 'lista')
		return {
			ok: false,
			error:
				'Este nodo no tiene CLAVE_SECRETOS en su .env, y sin ella no se puede guardar el registro.'
		};
	const c = decodificarCodigo(codigo);
	if (!c) return { ok: false, error: 'Eso no parece un código de activación. Cópialo entero.' };
	const v = licenciaDeRegistro(clave, c.licencia, ahora);
	if (!v.ok) {
		const mensaje = /caducad/.test(v.motivo)
			? 'Ese código ha caducado. Pide uno nuevo con tu correo.'
			: 'Ese código no es válido.';
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
	await auditar(quien, 'registro activado', { hasta: v.licencia.caduca });
	return { ok: true, caduca: v.licencia.caduca };
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
	const clave = env.PUBLICACION_CLAVE_PUBLICA;
	const r = await guardado();
	if (!clave || !r) return 'no-toca';
	const actual = await licenciaGuardada();
	const autentica = actual ? licenciaDeRegistro(clave, actual, 0) : null;
	if (!autentica?.ok) return 'no-toca';
	if (!forzar && !tocaRenovar(autentica.licencia, ahora)) return 'no-toca';
	if (!urlPanelValida(PANEL)) return 'no-disponible';
	const d = descifrar(r.token, CONTEXTO);
	if (!d.ok || typeof d.valores.token !== 'string') {
		await escribir({ ...r, fallo: 'No se puede leer el token: pega un código nuevo.' });
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
		await escribir({ ...r, fallo: 'No se ha podido contactar con el panel de SeguridadSI.' });
		return 'sin-conexion';
	}
	if (res.status === 404) {
		await escribir({ ...r, fallo: 'Este registro se ha retirado: pide un código nuevo.' });
		return 'retirado';
	}
	/* Ya se renovó hace poco: no es un fallo, y la que hay sigue valiendo. */
	if (res.status === 429) return 'no-toca';
	if (!res.ok) {
		await escribir({ ...r, fallo: 'La renovación no está disponible ahora mismo.' });
		return 'no-disponible';
	}
	const cuerpo = (await res.json().catch(() => null)) as { licencia?: unknown } | null;
	const nueva = licenciaDeRegistro(clave, cuerpo?.licencia, ahora);
	if (!nueva.ok) {
		await escribir({ ...r, fallo: 'El panel ha devuelto una licencia que no vale.' });
		return 'invalida';
	}
	/* Una que no alarga la vigencia no sustituye a la que hay (p. ej. certificado por renovar). */
	if (Date.parse(nueva.licencia.caduca) <= Date.parse(autentica.licencia.caduca)) return 'no-toca';
	await guardarLicencia(cuerpo!.licencia as LicenciaFirmada);
	await escribir({ ...r, renovada: new Date(ahora).toISOString(), fallo: null });
	await auditar('registro', 'registro renovado', { hasta: nueva.licencia.caduca });
	return 'renovada';
}
