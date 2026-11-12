/*
 * Acceso a la consola por IP de origen (docs/diseno/acceso-consola.md).
 *
 * La lista vive en el ajuste «acceso-consola». El actualizador la recoge y pone
 * la regla en el cortafuegos de la máquina; lo que aplicó de verdad, con la
 * huella de la lista, vuelve al ajuste «acceso-consola-cortafuegos». Además,
 * con la lista activa, la consola no contesta a lo que llega por Caddy desde
 * fuera de ella (segunda barrera).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { aCidrs, contenidaEn, rango } from '@sugardaddy/canal';
import { db, schema as s } from './db';
import { normalizarIp } from './pruebas';

export type EntradaAcceso = {
	/* Una IP (10.0.5.20) o una red CIDR (192.168.10.0/24), en forma canónica. */
	red: string;
	nota: string;
	/* La de un sensor remoto: entra al darlo de alta y sale al borrarlo. */
	sensor?: string;
};

export type EstadoAcceso = 'pendiente' | 'restringida' | 'abierta';

export type Acceso = {
	estado: EstadoAcceso;
	entradas: EntradaAcceso[];
	cambiado: string | null;
	quien: string | null;
	/* Abierta desde la propia máquina con el fichero de emergencia. */
	emergencia?: boolean;
	/* Sube con cada cambio: un formulario viejo no pisa lo que cambió mientras tanto. */
	version?: number;
	/*
	 * Desde cuándo es esta la lista que tiene que aplicar el cortafuegos (cambió su
	 * huella): durante un par de minutos, que aún no la confirme es lo normal y no
	 * un fallo (cortafuegosAplicando).
	 */
	listaDesde?: string;
};

export type EstadoCortafuegos = 'aplicada' | 'abierta' | 'sin-docker-user' | 'error';
export type Cortafuegos = {
	estado: EstadoCortafuegos;
	detalle: string;
	cuando: string;
	/* La huella de la lista que aplicó: una confirmación de otra lista no vale. */
	huella?: string;
};

const CLAVE = 'acceso-consola';
const CLAVE_CORTAFUEGOS = 'acceso-consola-cortafuegos';
export const MAX_ENTRADAS = 100;
const MAX_NOTA = 80;
/* El actualizador vuelve a aplicar e informar cada dos minutos: más de diez sin noticias, no está. */
const CONFIRMACION_VALE_MS = 10 * 60_000;
/*
 * Lo que tarda como mucho en llegar al cortafuegos un cambio de la lista: el
 * actualizador la recoge en su siguiente vuelta (medio minuto), lanza su
 * auxiliar y lo cuenta. Pasado esto sin confirmación, ya no es una espera.
 */
export const PLAZO_APLICAR_MS = 3 * 60_000;
const ESTADOS_CORTAFUEGOS: EstadoCortafuegos[] = [
	'aplicada',
	'abierta',
	'sin-docker-user',
	'error'
];

/*
 * Una IP o red tal como se guarda: la IP sola sin máscara, la red con la base
 * alineada. null si no es válida, si deja entrar a todo el mundo (/0) o si es
 * una red IPv4 escrita como IPv6 (::ffff:…/n): el cortafuegos y la consola la
 * leerían distinto, así que se pide en IPv4.
 */
export function entradaValida(texto: string): string | null {
	const t = texto.trim().toLowerCase();
	if (!t) return null;
	const ip = normalizarIp(t);
	if (ip) return ip;
	if (t.includes('::ffff:') || /^::\d/.test(t)) return null;
	const r = rango(t);
	if (!r) return null;
	if (r.desde === 0n && r.hasta === (r.familia === 4 ? 2n ** 32n : 2n ** 128n) - 1n) return null;
	const [cidr] = aCidrs(r);
	return cidr?.endsWith(r.familia === 4 ? '/32' : '/128') ? cidr.split('/')[0] : (cidr ?? null);
}

/* La lista que trae el instalador en CONSOLA_ACCESO (separada por comas o espacios). */
function delInstalador(): EntradaAcceso[] {
	return (env.CONSOLA_ACCESO ?? '')
		.split(/[\s,]+/)
		.map(entradaValida)
		.filter((r): r is string => !!r)
		.map((red) => ({ red, nota: 'Installer' }));
}

/* La IP que propone el instalador (la de la sesión SSH desde la que se instaló). */
export function propuestaDelInstalador(): string | null {
	return normalizarIp(env.CONSOLA_ACCESO_PROPUESTA);
}

let cache: { valor: Acceso; hasta: number } | null = null;

/* Sin ajuste guardado: la lista del instalador si la hay; si no, pendiente de decidir. */
function inicial(): Acceso {
	const entradas = delInstalador();
	return {
		estado: entradas.length ? 'restringida' : 'pendiente',
		entradas,
		cambiado: null,
		quien: entradas.length ? 'installer' : null,
		version: 0
	};
}

export async function leerAcceso(): Promise<Acceso> {
	if (cache && cache.hasta > Date.now()) return cache.valor;
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, CLAVE));
	const valor = (f?.valor as Acceso | undefined) ?? inicial();
	/* Lo mira cada petición (la segunda barrera): unos segundos en memoria. */
	cache = { valor, hasta: Date.now() + 5_000 };
	return valor;
}

/* Para las pruebas, y tras escribir: la próxima lectura va a la base. */
export function _olvidarAcceso() {
	cache = null;
}

class Cambiada extends Error {}

/*
 * Escribe el ajuste a partir de lo que hay en la base en ese momento, con la
 * fila bloqueada: dos cambios a la vez (una alta de sensor y un formulario) no
 * se pisan. Con `esperada`, si la versión ya no es esa, no escribe nada.
 */
async function cambiar(
	quien: string,
	accion: string,
	detalle: Record<string, unknown>,
	nuevo: (antes: Acceso) => Acceso | null,
	esperada?: number
): Promise<Acceso | null> {
	const r = await db.transaction(async (tx) => {
		const [f] = await tx.select().from(s.ajustes).where(eq(s.ajustes.clave, CLAVE)).for('update');
		const antes = (f?.valor as Acceso | undefined) ?? inicial();
		if (esperada !== undefined && (antes.version ?? 0) !== esperada) throw new Cambiada();
		const valor = nuevo(antes);
		if (!valor) return null;
		valor.version = (antes.version ?? 0) + 1;
		/* Si cambia lo que tiene que aplicar el cortafuegos, se apunta desde cuándo. */
		valor.listaDesde =
			!f || huellaLista(valor) !== huellaLista(antes) ? new Date().toISOString() : antes.listaDesde;
		await tx
			.insert(s.ajustes)
			.values({ clave: CLAVE, valor })
			.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
		await tx.insert(s.auditoria).values({ quien, accion, detalle });
		return valor;
	});
	cache = null;
	return r;
}

/* Los sensores remotos cuya máquina no entra con esa lista (los que se sabe desde dónde llegan). */
export async function sensoresFuera(
	entradas: EntradaAcceso[]
): Promise<{ id: string; nombre: string; direccion: string }[]> {
	const remotos = await db
		.select({ id: s.sensores.id, nombre: s.sensores.nombre, direccion: s.sensores.direccion })
		.from(s.sensores)
		.where(and(eq(s.sensores.remoto, true), isNotNull(s.sensores.direccion)));
	const redes = entradas.map((e) => e.red);
	return remotos.flatMap((r) =>
		r.direccion && !contenidaEn(r.direccion, redes) ? [{ ...r, direccion: r.direccion }] : []
	);
}

/* Los sensores remotos que aún no han llegado desde esta versión: no se sabe su IP. */
export async function sensoresSinDireccion(): Promise<{ id: string; nombre: string }[]> {
	const remotos = await db
		.select({ id: s.sensores.id, nombre: s.sensores.nombre, direccion: s.sensores.direccion })
		.from(s.sensores)
		/* Uno retirado no va a llegar: no hay dirección que esperar de él. */
		.where(and(eq(s.sensores.remoto, true), isNull(s.sensores.retirado)));
	return remotos.filter((r) => !r.direccion).map(({ id, nombre }) => ({ id, nombre }));
}

export type ResultadoGuardar = { ok: true; acceso: Acceso } | { ok: false; error: string };

/*
 * Guarda la lista y limita el acceso a ella. `ip` es la del navegador de quien
 * guarda; `local`, si está en la propia máquina (ahí siempre se entra). Sin
 * eso, una lista que no cubre su IP lo dejaría fuera nada más guardar. Tampoco
 * se guarda, salvo que se diga (`cortarSensores`), una que deja fuera a un
 * sensor remoto que ya conecta.
 */
export async function guardarAcceso(
	quien: string,
	filas: { red: string; nota?: string; sensor?: string }[],
	ip: string | null,
	local: boolean,
	opciones: { version?: number; cortarSensores?: boolean } = {}
): Promise<ResultadoGuardar> {
	if (filas.length > MAX_ENTRADAS)
		return { ok: false, error: `At most ${MAX_ENTRADAS} addresses or networks.` };
	const entradas: EntradaAcceso[] = [];
	for (const f of filas) {
		if (!f.red.trim()) continue;
		const red = entradaValida(f.red);
		if (!red)
			return {
				ok: false,
				error: `"${f.red.trim().slice(0, 60)}" is not an IP address or a network in CIDR form (0.0.0.0/0 and ::/0 are not a list; write IPv4 networks as IPv4).`
			};
		if (entradas.some((e) => e.red === red)) continue;
		const nota = (f.nota ?? '').trim().slice(0, MAX_NOTA);
		entradas.push({ red, nota, ...(f.sensor ? { sensor: f.sensor } : {}) });
	}
	if (!entradas.length) return { ok: false, error: 'Add at least one IP address or network.' };
	if (!local) {
		if (!ip)
			return {
				ok: false,
				error: 'The console cannot tell your IP address, so it cannot check that you keep access.'
			};
		if (
			!contenidaEn(
				ip,
				entradas.map((e) => e.red)
			)
		)
			return {
				ok: false,
				error: `Your current IP address (${ip}) is not in the list: saving it would lock you out. Add it, or the network it belongs to.`
			};
	}
	const fuera = await sensoresFuera(entradas);
	if (fuera.length && !opciones.cortarSensores)
		return {
			ok: false,
			error: `These remote sensors connect from addresses outside the list and would stop reaching the console: ${fuera
				.map((f) => `${f.nombre} (${f.direccion})`)
				.join(', ')}. Add them, or confirm that you want to cut them off.`
		};
	try {
		const valor = await cambiar(
			quien,
			'console access limited',
			{ redes: entradas.map((e) => e.red) },
			() => ({ estado: 'restringida', entradas, cambiado: new Date().toISOString(), quien }),
			opciones.version
		);
		return { ok: true, acceso: valor! };
	} catch (e) {
		if (e instanceof Cambiada)
			return {
				ok: false,
				error:
					'The list changed while you were editing it (for example, a remote sensor was added). Review it and save again.'
			};
		throw e;
	}
}

/* Dejarla abierta a todos, a propósito. Las entradas se conservan para volver a limitarla. */
export async function dejarAbierta(quien: string): Promise<void> {
	await cambiar(quien, 'console access left open', {}, (antes) => ({
		...antes,
		estado: 'abierta',
		emergencia: undefined,
		cambiado: new Date().toISOString(),
		quien
	}));
}

/* El actualizador ha abierto el puerto con el fichero de emergencia de la máquina. */
export async function abiertaPorEmergencia(): Promise<void> {
	await cambiar('machine', 'console access opened from the machine', {}, (antes) =>
		antes.estado === 'abierta' && antes.emergencia
			? null
			: {
					...antes,
					estado: 'abierta',
					emergencia: true,
					cambiado: new Date().toISOString(),
					quien: 'machine'
				}
	);
}

/*
 * La IP de la máquina de un sensor remoto entra en la lista: si no, con el
 * acceso limitado no podría ni instalarse. Si la lista ya la cubre (la red de
 * la sede, o la misma IP que otra entrada), no se añade nada: así, al borrar el
 * sensor, no se lleva por delante una entrada que no era suya.
 */
export async function anadirSensorAlAcceso(
	quien: string,
	sensor: string,
	nombre: string,
	ip: string
): Promise<string | null> {
	const red = entradaValida(ip);
	if (!red || red.includes('/')) return 'Enter the IP address of the sensor machine.';
	let error: string | null = null;
	await cambiar(quien, 'console access: remote sensor added', { sensor, red }, (antes) => {
		const otras = antes.entradas.filter((e) => e.sensor !== sensor);
		if (
			contenidaEn(
				red,
				otras.map((e) => e.red)
			)
		) {
			/* Ya entra por otra: solo se quita la vieja de este sensor, si la había. */
			return otras.length === antes.entradas.length ? null : { ...antes, entradas: otras };
		}
		if (otras.length + 1 > MAX_ENTRADAS) {
			error = `The console access list already has ${MAX_ENTRADAS} entries.`;
			return null;
		}
		return {
			...antes,
			entradas: [...otras, { red, nota: `Remote sensor ${nombre}`.slice(0, MAX_NOTA), sensor }]
		};
	});
	return error;
}

/*
 * Al borrar un sensor remoto sale su entrada. Nunca deja la lista vacía (sería
 * abrirla, o no dejar entrar a nadie) ni deja fuera a quien lo borra: en esos
 * casos la entrada se queda, ya sin el sensor.
 */
export async function quitarSensorDelAcceso(
	quien: string,
	sensor: string,
	ip: string | null = null,
	local = false
): Promise<void> {
	await db.update(s.sensores).set({ direccion: null }).where(eq(s.sensores.id, sensor));
	await cambiar(quien, 'console access: remote sensor removed', { sensor }, (antes) => {
		if (!antes.entradas.some((e) => e.sensor === sensor)) return null;
		const sin = antes.entradas.filter((e) => e.sensor !== sensor);
		const dentroAntes =
			!!ip &&
			contenidaEn(
				ip,
				antes.entradas.map((e) => e.red)
			);
		const dentroDespues =
			!!ip &&
			contenidaEn(
				ip,
				sin.map((e) => e.red)
			);
		const queda =
			!sin.length || (antes.estado === 'restringida' && !local && dentroAntes && !dentroDespues);
		const entradas = queda
			? antes.entradas.map((e) => (e.sensor === sensor ? { red: e.red, nota: e.nota } : e))
			: sin;
		return { ...antes, entradas };
	});
}

/* Apunta desde qué IP llega un sensor remoto, solo si cambió. */
export async function apuntarDireccionSensor(
	sensor: string,
	getClientAddress: () => string
): Promise<void> {
	let ip: string | null = null;
	try {
		ip = normalizarIp(getClientAddress());
	} catch {
		return;
	}
	if (!ip) return;
	await db
		.update(s.sensores)
		.set({ direccion: ip })
		.where(and(eq(s.sensores.id, sensor), sql`${s.sensores.direccion} is distinct from ${ip}`));
}

/* La huella de lo que tiene que aplicar el cortafuegos: estado y redes. */
export function huellaLista(a: Pick<Acceso, 'estado' | 'entradas'>): string {
	const redes = a.estado === 'restringida' ? a.entradas.map((e) => e.red) : [];
	return createHash('sha256')
		.update(JSON.stringify({ estado: a.estado, redes }))
		.digest('hex')
		.slice(0, 32);
}

/* Lo que pide el actualizador: si está limitada, a qué redes y la huella que tiene que devolver. */
export async function paraElCortafuegos(): Promise<{
	estado: EstadoAcceso;
	redes: string[];
	huella: string;
}> {
	const a = await leerAcceso();
	return {
		estado: a.estado,
		redes: a.estado === 'restringida' ? a.entradas.map((e) => e.red) : [],
		huella: huellaLista(a)
	};
}

export async function cortafuegos(): Promise<Cortafuegos | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, CLAVE_CORTAFUEGOS));
	return (f?.valor as Cortafuegos | undefined) ?? null;
}

export async function guardarCortafuegos(
	estado: string,
	detalle: string,
	huella: string | null = null
): Promise<boolean> {
	if (!ESTADOS_CORTAFUEGOS.includes(estado as EstadoCortafuegos)) return false;
	const valor: Cortafuegos = {
		estado: estado as EstadoCortafuegos,
		detalle: String(detalle ?? '').slice(0, 300),
		cuando: new Date().toISOString(),
		...(huella && /^[0-9a-f]{32}$/.test(huella) ? { huella } : {})
	};
	await db
		.insert(s.ajustes)
		.values({ clave: CLAVE_CORTAFUEGOS, valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
	confirmada = null;
	return true;
}

/*
 * Si el cortafuegos de la máquina aplica de verdad la lista de ahora: lo dijo
 * para esta misma lista y hace poco. Si no, la consola lo avisa y la segunda
 * barrera no se fía de nada que llegue como «la propia máquina».
 */
export function cortafuegosConfirma(a: Acceso, c: Cortafuegos | null, ahora = Date.now()): boolean {
	return (
		a.estado === 'restringida' &&
		!!c &&
		c.estado === 'aplicada' &&
		c.huella === huellaLista(a) &&
		ahora - new Date(c.cuando).getTime() < CONFIRMACION_VALE_MS
	);
}

/*
 * La lista acaba de cambiar y el cortafuegos aún no ha tenido tiempo de
 * aplicarla: no es que no la aplique. Sin esto, añadir la IP de un sensor remoto
 * (o guardar la lista) encendía durante medio minuto el aviso rojo de que el
 * cortafuegos de la máquina no aplica la lista, cuando solo estaba en ello.
 *
 * No es una espera si ya contestó para esta lista y no la aplicó, ni si lo
 * último que dijo, antes del cambio, ya era que no puede (sin DOCKER-USER, o
 * un error): eso sigue siendo verdad y se sigue avisando.
 */
export function cortafuegosAplicando(
	a: Acceso,
	c: Cortafuegos | null,
	ahora = Date.now()
): boolean {
	if (a.estado !== 'restringida' || !a.listaDesde || cortafuegosConfirma(a, c, ahora)) return false;
	const desde = new Date(a.listaDesde).getTime();
	if (!(ahora - desde < PLAZO_APLICAR_MS)) return false;
	if (!c) return true;
	const fallo = c.estado === 'error' || c.estado === 'sin-docker-user';
	if (c.huella === huellaLista(a)) return c.estado === 'aplicada';
	return !fallo;
}

let confirmada: { valor: Cortafuegos | null; hasta: number } | null = null;
/* Para la segunda barrera, que lo mira en cada petición: unos segundos en memoria. */
export async function cortafuegosReciente(): Promise<Cortafuegos | null> {
	if (confirmada && confirmada.hasta > Date.now()) return confirmada.valor;
	const valor = await cortafuegos();
	confirmada = { valor, hasta: Date.now() + 5_000 };
	return valor;
}

/*
 * La puerta de enlace de la red de Docker de la consola: lo que entra por el
 * 443 desde la propia máquina llega a Caddy con esa IP de origen. null si no
 * se sabe (fuera de Linux).
 */
let puerta: string | null | undefined;
function puertaDeEnlace(): string | null {
	if (puerta !== undefined) return puerta;
	puerta = null;
	try {
		for (const l of readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
			const [, destino, enlace] = l.trim().split(/\s+/);
			if (destino === '00000000' && enlace && enlace !== '00000000') {
				const n = parseInt(enlace, 16);
				puerta = [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255].join('.');
				break;
			}
		}
	} catch {
		/* sin /proc: se queda en null */
	}
	return puerta;
}

/* Para las pruebas: qué puerta de enlace se toma. */
export function _ponerPuertaDeEnlace(ip: string | null | undefined) {
	puerta = ip;
}

/* Si la IP es de la propia máquina: el bucle local o la puerta de enlace de Docker. */
export function esLocal(ip: string | null): boolean {
	if (!ip) return false;
	return contenidaEn(ip, ['127.0.0.0/8', '::1']) || ip === puertaDeEnlace();
}

/*
 * La segunda barrera: si quien llega por Caddy desde esa IP puede ver la
 * consola. La puerta de enlace de Docker solo cuenta como «la propia máquina»
 * con el cortafuegos confirmado: sin él, por ahí llega también lo que Docker
 * reenvía con su proxy (IPv6, máquinas sin DOCKER-USER) o enmascara.
 */
export function puedeEntrar(ip: string | null, a: Acceso, confirmado: boolean): boolean {
	if (a.estado !== 'restringida') return true;
	if (!ip) return false;
	if (contenidaEn(ip, ['127.0.0.0/8', '::1'])) return true;
	if (confirmado && ip === puertaDeEnlace()) return true;
	return contenidaEn(
		ip,
		a.entradas.map((e) => e.red)
	);
}
