/*
 * El lado del nodo del canal con el panel central. El nodo abre todas las
 * conexiones: se da de alta una vez con un código, y después late cada minuto
 * y recibe en la respuesta su estado deseado firmado.
 *
 * La clave privada del nodo se genera aquí y no sale nunca. La clave pública
 * del panel se fija en el alta: un estado firmado por cualquier otra clave se
 * rechaza, aunque llegue por la misma dirección.
 *
 * El cliente puede cortar el canal cuando quiera. Cortado, el nodo deja de
 * latir y de aceptar estados; sigue detectando y respondiendo en local.
 */
import { createHash } from 'node:crypto';
import { and, eq, gte, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import {
	compararVersiones,
	firmarPeticion,
	generarClaves,
	huella,
	verificarEstado,
	verificarListaTor,
	verificarRelease,
	type EstadoDeseado,
	type Latido,
	type LicenciaFirmada,
	type ReleaseFirmada
} from '@sugardaddy/canal';
import { cuentaActivas } from './colocacion';
import { db, schema as s } from './db';
import { auditar, autoActualizar, cabecera, comparticion } from './consultas';
import {
	aplicarLista,
	indicadoresPendientes,
	marcarSubidos,
	retirarListaGlobal
} from './inteligencia';
import { paraLatido, recibirSolicitud } from './soporte';
import { guardarTor, huellaTor, quitarTor } from './tor';

type Canal = {
	panel: string;
	nodo: string;
	cliente: string;
	clavePrivada: string;
	clavePublica: string;
	clavePublicaPanel: string;
	cortado: boolean;
	ultimoContacto: string | null;
	error: string | null;
	estado: EstadoDeseado | null;
};

async function leer(): Promise<Canal | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'canal'));
	return (f?.valor as Canal) ?? null;
}

/* ¿Este nodo lo gestiona un panel? = está dado de alta (existe Canal). Un nodo
 * community NO tiene Canal, aunque tenga la clave pública para verificar. No es
 * lo mismo que «tiene PUBLICACION_CLAVE_PUBLICA». */
export async function gestionadoPorPanel() {
	return (await leer()) !== null;
}

async function guardar(c: Canal) {
	await db
		.insert(s.ajustes)
		.values({ clave: 'canal', valor: c })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: c } });
}

/* Lo que se enseña en Ajustes. Nunca la clave privada. */
export async function estadoCanal() {
	const c = await leer();
	if (!c) return null;
	return {
		panel: c.panel,
		nodo: c.nodo,
		cliente: c.cliente,
		huellaNodo: huella(c.clavePublica),
		huellaPanel: huella(c.clavePublicaPanel),
		cortado: c.cortado,
		ultimoContacto: c.ultimoContacto,
		error: c.error,
		estado: c.estado
	};
}

/*
 * https siempre, salvo en la propia máquina para desarrollo. PANEL_HTTP_PERMITIDO
 * admite más nombres sin TLS (p. ej. host.docker.internal al probar el nodo en
 * contenedores contra un panel de desarrollo); en producción no se pone.
 */
export function urlPanelValida(u: string) {
	try {
		const url = new URL(u);
		const permitidos = (env.PANEL_HTTP_PERMITIDO ?? '')
			.split(',')
			.map((x) => x.trim())
			.filter(Boolean);
		const local = ['localhost', '127.0.0.1', '[::1]', ...permitidos].includes(url.hostname);
		return (url.protocol === 'https:' || (local && url.protocol === 'http:')) && !url.username;
	} catch {
		return false;
	}
}

export async function darDeAlta(quien: string, panel: string, codigo: string) {
	if (await leer()) return { ok: false, motivo: 'Este nodo ya está dado de alta en un panel.' };
	const { nodo } = (await cabecera()).cliente;
	const claves = generarClaves();
	const base = panel.replace(/\/+$/, '');
	let r: Response;
	try {
		r = await fetch(`${base}/api/nodo/alta`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ codigo, nodo, clavePublica: claves.publica }),
			signal: AbortSignal.timeout(15_000)
		});
	} catch {
		return { ok: false, motivo: 'No se ha podido contactar con el panel.' };
	}
	if (!r.ok) {
		const m = (await r.json().catch(() => null))?.message;
		return { ok: false, motivo: `El panel ha rechazado el alta: ${m ?? r.status}` };
	}
	const b = await r.json();
	await guardar({
		panel: base,
		nodo,
		cliente: String(b.cliente),
		clavePrivada: claves.privada,
		clavePublica: claves.publica,
		clavePublicaPanel: String(b.clavePublicaPanel),
		cortado: false,
		ultimoContacto: null,
		error: null,
		estado: null
	});
	await auditar(quien, 'nodo dado de alta en el panel central', {
		panel: base,
		huellaPanel: huella(String(b.clavePublicaPanel))
	});
	await latir();
	return { ok: true };
}

/* ---------- actualizaciones ---------- */

export type Actualizacion = {
	estado: 'al-dia' | 'pendiente' | 'aplicando' | 'fallida';
	version: string | null;
	release: ReleaseFirmada | null;
	detalle: string | null;
};

const SIN_ACTUALIZACION: Actualizacion = {
	estado: 'al-dia',
	version: null,
	release: null,
	detalle: null
};

export async function actualizacion(): Promise<Actualizacion> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'actualizacion'));
	return (f?.valor as Actualizacion) ?? SIN_ACTUALIZACION;
}

async function guardarActualizacion(a: Actualizacion) {
	await db
		.insert(s.ajustes)
		.values({ clave: 'actualizacion', valor: a })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: a } });
}

/*
 * Lo que el panel ofrece no se acepta a ciegas: la versión tiene que venir
 * firmada con la clave de publicación fijada en este nodo (no con la del
 * panel), ser la que el estado dice, ser mayor que la actual y no haber
 * fallado ya aquí.
 */
async function considerar(estado: EstadoDeseado, nodo: string) {
	if (!estado.release) return;
	const clave = env.PUBLICACION_CLAVE_PUBLICA;
	if (!clave) return;
	const actual = (await cabecera()).cliente.version;
	const previa = await actualizacion();
	const v = verificarRelease(clave, estado.release);
	const rechazo = !v.ok
		? v.motivo
		: v.release.version !== estado.versionObjetivo
			? 'la versión firmada no es la que pide el estado'
			: compararVersiones(v.release.version, actual) <= 0
				? `no se baja de versión (${actual} → ${v.release.version})`
				: null;
	if (rechazo) {
		await auditar(`nodo ${nodo}`, 'versión rechazada', { motivo: rechazo });
		return;
	}
	if (!v.ok) return;
	if (previa.version === v.release.version && previa.estado !== 'al-dia') return;
	await guardarActualizacion({
		estado: 'pendiente',
		version: v.release.version,
		release: estado.release,
		detalle: null
	});
	await auditar(`nodo ${nodo}`, 'versión pendiente de instalar', { version: v.release.version });
}

/*
 * Auto-actualización de la edición community (nodos SIN panel): si la persona la
 * activó en Ajustes, la consola baja el ultima-community.json FIRMADO del repo
 * público, lo verifica con la clave pública fijada en el nodo —la MISMA
 * verificación que el camino de pago— y, si es una versión mayor, lo deja
 * pendiente. El actualizador lo aplica igual que una release del panel.
 * Best-effort: sin panel-no aplica, sin clave, sin opt-in, sin red o sin
 * novedad, no hace nada.
 */
const URL_RELEASE_COMMUNITY =
	env.ACTUALIZACIONES_RELEASE_URL ??
	'https://raw.githubusercontent.com/Seguridadsi/sugardaddy/main/ultima-community.json';

export async function considerarCommunity() {
	if (await gestionadoPorPanel()) return;
	const clave = env.PUBLICACION_CLAVE_PUBLICA;
	if (!clave) return;
	if (!(await autoActualizar()).activo) return;
	let firmada: ReleaseFirmada;
	try {
		const res = await fetch(URL_RELEASE_COMMUNITY, { signal: AbortSignal.timeout(10_000) });
		if (!res.ok) return;
		firmada = (await res.json()) as ReleaseFirmada;
	} catch {
		return;
	}
	if (!firmada?.release || !firmada?.firma) return;
	const v = verificarRelease(clave, firmada);
	if (!v.ok) {
		await auditar('auto-actualización', 'release community rechazada', { motivo: v.motivo });
		return;
	}
	const actual = (await cabecera()).cliente.version;
	if (compararVersiones(v.release.version, actual) <= 0) return;
	const previa = await actualizacion();
	if (previa.version === v.release.version && previa.estado !== 'al-dia') return;
	await guardarActualizacion({
		estado: 'pendiente',
		version: v.release.version,
		release: firmada,
		detalle: null
	});
	await auditar('auto-actualización', 'versión community pendiente', {
		version: v.release.version
	});
}

/* ---------- configuración firmada del nodo (desde la 0.12) ---------- */

export type EstadoConfiguracion = {
	version: string;
	estado: 'aplicando' | 'aplicada' | 'fallida';
	detalle: string | null;
	cuando: string;
};

/* Cuánto dura como mucho la retención mientras se aplica una configuración. */
const RETENCION_MS = 30 * 60_000;

export async function configuracion(): Promise<EstadoConfiguracion | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'configuracion'));
	return (f?.valor as EstadoConfiguracion | undefined) ?? null;
}

async function guardarAjuste(clave: string, valor: unknown) {
	await db
		.insert(s.ajustes)
		.values({ clave, valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
}

type Relevo = { sensor: string; remoto: boolean; desde: string };

/* Relevos que puede intentar un sensor para una misma versión: ni uno comprometido retiene más. */
const MAX_RELEVOS = 5;

export async function relevoEnCurso(): Promise<Relevo | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'relevo'));
	const r = f?.valor as Relevo | undefined;
	return r && Date.now() - Date.parse(r.desde) < RETENCION_MS ? r : null;
}

/*
 * Mientras un auxiliar aplica la configuración, no se ofrecen versiones nuevas
 * al actualizador de esa máquina: el viejo (0.11) podría empezar a cambiar
 * imágenes a la vez. El relevo de un sensor remoto solo retiene a ese sensor;
 * el del sensor local, al actualizador del nodo. Dura como mucho 30 minutos
 * desde que empezó, por si el resultado no llega nunca.
 */
export async function retenido(sensor?: string) {
	const r = await relevoEnCurso();
	if (r && (sensor ? r.sensor === sensor : !r.remoto)) return true;
	const c = await configuracion();
	return !sensor && c?.estado === 'aplicando' && Date.now() - Date.parse(c.cuando) < RETENCION_MS;
}

/*
 * Si un sensor puede ya pasar su máquina a la configuración firmada de la
 * versión del nodo (el relevo de la 0.11). El sensor local, solo con el nodo al
 * día y sin esa configuración aplicada; uno remoto, solo si ya está en la
 * versión del nodo. Y nunca con otro relevo en curso.
 */
export async function relevoPermitido(sensor: {
	id: string;
	remoto: boolean;
	version: string | null;
	configuracion: EstadoConfiguracion | null;
}) {
	if (await relevoEnCurso()) return null;
	const version = (await cabecera()).cliente.version;
	if (sensor.remoto) {
		if (sensor.version !== version) return null;
		if (sensor.configuracion?.version === version && sensor.configuracion.estado !== 'fallida')
			return null;
	} else {
		if ((await actualizacion()).estado !== 'al-dia') return null;
		const c = await configuracion();
		if (c?.version === version && c.estado !== 'fallida') return null;
	}
	let r;
	try {
		r = await releaseDelNodo();
	} catch {
		return null;
	}
	if (r.release.version !== version) return null;
	if (!(sensor.remoto ? r.release.sensorRemoto : r.release.nodo)) return null;
	return { version, release: r.firmada };
}

/*
 * El cerrojo del relevo se toma al decir «aplicando», no al dar permiso: de
 * forma atómica y solo si no hay otro relevo vivo. Nunca se renueva: caduca a
 * los 30 minutos del primer «aplicando». Y cada sensor tiene un número de
 * intentos por versión.
 */
export async function tomarCerrojo(sensor: string, remoto: boolean, version: string) {
	const r = await relevoEnCurso();
	if (r) return r.sensor === sensor;
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'relevo-intentos'));
	const intentos = (f?.valor ?? {}) as Record<string, { version: string; n: number }>;
	const previos = intentos[sensor]?.version === version ? intentos[sensor].n : 0;
	if (previos >= MAX_RELEVOS) return false;
	const valor: Relevo = { sensor, remoto, desde: new Date().toISOString() };
	const tomado = await db
		.insert(s.ajustes)
		.values({ clave: 'relevo', valor })
		.onConflictDoUpdate({
			target: s.ajustes.clave,
			set: { valor },
			setWhere: sql`(${s.ajustes.valor}->>'desde')::timestamptz < now() - make_interval(secs => ${RETENCION_MS / 1000})`
		})
		.returning({ clave: s.ajustes.clave });
	if (!tomado.length) return false;
	await guardarAjuste('relevo-intentos', { ...intentos, [sensor]: { version, n: previos + 1 } });
	return true;
}

/* Suelta el cerrojo, solo si es de ese sensor. */
export async function soltarRelevo(sensor: string) {
	await db
		.delete(s.ajustes)
		.where(and(eq(s.ajustes.clave, 'relevo'), sql`${s.ajustes.valor}->>'sensor' = ${sensor}`));
}

/*
 * Lo que dice el sensor de su relevo. false: no se acepta (sin cerrojo, o el
 * cerrojo es de otro).
 */
export async function informarRelevo(
	sensor: Parameters<typeof relevoPermitido>[0],
	estado: 'aplicando' | 'fallida' | 'cancelado',
	detalle: string
) {
	const version = (await cabecera()).cliente.version;
	if (estado === 'aplicando') {
		const r = await relevoEnCurso();
		if (r && r.sensor !== sensor.id) return false;
		if (!r && !(await relevoPermitido(sensor))) return false;
		if (!(await tomarCerrojo(sensor.id, sensor.remoto, version))) return false;
	} else {
		if ((await relevoEnCurso())?.sensor !== sensor.id) return false;
		await soltarRelevo(sensor.id);
	}
	const { id, remoto } = sensor;
	if (estado === 'fallida') {
		const c: EstadoConfiguracion = {
			version,
			estado: 'fallida',
			detalle: detalle.slice(0, 2000),
			cuando: new Date().toISOString()
		};
		if (remoto) await db.update(s.sensores).set({ configuracion: c }).where(eq(s.sensores.id, id));
		else await guardarAjuste('configuracion', c);
	}
	await auditar(`sensor ${id}`, `relevo ${estado}`, {
		version,
		detalle: detalle.slice(0, 500)
	});
	return true;
}

/* El resultado del auxiliar en un sensor remoto. */
export async function resultadoConfiguracionRemota(
	sensor: string,
	version: string,
	estado: 'aplicando' | 'aplicada' | 'fallida',
	detalle: string
) {
	const c: EstadoConfiguracion = {
		version,
		estado,
		detalle: detalle.slice(0, 2000) || null,
		cuando: new Date().toISOString()
	};
	await db
		.update(s.sensores)
		.set({ configuracion: c, ...(estado === 'aplicada' ? { version } : {}) })
		.where(eq(s.sensores.id, sensor));
	if (estado !== 'aplicando') await soltarRelevo(sensor);
	await auditar(`sensor ${sensor}`, `configuración ${estado}`, {
		version,
		detalle: detalle.slice(0, 500)
	});
}

/*
 * Lo que informa el actualizador (o el auxiliar). Solo él, con su token,
 * llega aquí. tipo 'configuracion': el resultado del auxiliar, que vale para
 * la versión pendiente (entonces también la da por instalada o fallida) o
 * para la versión en la que ya está el nodo (el relevo de la 0.11).
 */
export async function resultadoActualizacion(
	version: string,
	estado: 'aplicando' | 'aplicada' | 'fallida',
	detalle: string,
	tipo: 'version' | 'configuracion' = 'version'
) {
	const a = await actualizacion();
	if (tipo === 'configuracion') {
		const actual = (await cabecera()).cliente.version;
		if (a.version !== version && actual !== version) return false;
		await guardarAjuste('configuracion', {
			version,
			estado,
			detalle: detalle.slice(0, 2000) || null,
			cuando: new Date().toISOString()
		} satisfies EstadoConfiguracion);
		// Solo suelta el relevo del sensor local: el de un remoto es de su máquina.
		if (estado !== 'aplicando')
			await db
				.delete(s.ajustes)
				.where(
					and(
						eq(s.ajustes.clave, 'relevo'),
						sql`coalesce(${s.ajustes.valor}->>'remoto', 'false') <> 'true'`
					)
				);
		await auditar('actualizador', `configuración ${estado}`, {
			version,
			detalle: detalle.slice(0, 500)
		});
		if (a.version !== version) return true;
	}
	if (a.version !== version) return false;
	if (estado === 'aplicada') {
		if (a.release) await guardarRelease(version, a.release);
		const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'nodo'));
		const nodo = { ...(f.valor as Record<string, unknown>), version };
		await db.update(s.ajustes).set({ valor: nodo }).where(eq(s.ajustes.clave, 'nodo'));
		await guardarActualizacion(SIN_ACTUALIZACION);
	} else {
		await guardarActualizacion({ ...a, estado, detalle: detalle.slice(0, 500) });
	}
	await auditar('actualizador', `actualización ${estado}`, {
		version,
		detalle: detalle.slice(0, 500)
	});
	return true;
}

async function latido(): Promise<Latido> {
	const ahora = Date.now();
	const sensores = await db.select().from(s.sensores);
	/* Activas: las comprobadas que ve el cliente (§8.2), lo mismo que cuenta Inicio. */
	const trampas = await cuentaActivas();
	const [cifras] = await db
		.select({
			eventos: sql<number>`count(*)::int`,
			criticos: sql<number>`count(*) filter (where ${s.eventos.severidad} = 'critica')::int`
		})
		.from(s.eventos)
		.where(gte(s.eventos.cuando, new Date(ahora - 86_400_000)));
	const cab = await cabecera();
	return {
		version: cab.cliente.version,
		sensores: {
			total: sensores.length,
			vivos: sensores.filter((x) => x.ultimoLatido && ahora - x.ultimoLatido.getTime() < 5 * 60_000)
				.length
		},
		trampas: { total: trampas.total, activos: trampas.activas },
		eventos24h: cifras.eventos,
		criticos24h: cifras.criticos,
		pendientes: cab.pendientes,
		comparticion: await comparticion(),
		actualizacion: {
			estado: (await actualizacion()).estado,
			version: (await actualizacion()).version
		},
		soporte: await paraLatido(),
		...(await (async () => {
			const c = await configuracion();
			return c
				? { configuracion: { version: c.version, estado: c.estado, detalle: c.detalle } }
				: {};
		})())
	};
}

async function enviar(c: Canal, ruta: string, cuerpo: string) {
	return fetch(`${c.panel}${ruta}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...firmarPeticion(c.clavePrivada, c.nodo, 'POST', ruta, cuerpo)
		},
		body: cuerpo,
		signal: AbortSignal.timeout(15_000)
	});
}

/* Un latido. Lo llama el reloj de hooks.server.ts; los fallos se guardan, no se lanzan. */
export async function latir() {
	const c = await leer();
	if (!c || c.cortado) return;
	try {
		const r = await enviar(c, '/api/nodo/latido', JSON.stringify(await latido()));
		if (!r.ok) throw new Error(`el panel responde ${r.status}`);
		const v = verificarEstado(c.clavePublicaPanel, c.cliente, await r.json());
		if (!v.ok) {
			/* Esto no es un fallo de red: alguien que no es el panel está respondiendo. */
			await auditar(`nodo ${c.nodo}`, 'estado deseado rechazado', { motivo: v.motivo });
			throw new Error(`estado deseado rechazado: ${v.motivo}`);
		}
		await guardar({
			...c,
			estado: v.estado,
			ultimoContacto: new Date().toISOString(),
			error: null
		});
		await considerar(v.estado, c.nodo);
		await recibirSolicitud(v.estado.soporte);
		await guardarAutorizados(v.estado.modulos);
		await guardarLicencia(v.estado.licencia);
		if (v.estado.logo !== undefined) await sincronizarLogo(c, v.estado.logo);
		if (v.estado.tor !== undefined) await sincronizarTor(c, v.estado.tor);
		await intercambiarInteligencia(c);
	} catch (e) {
		await guardar({ ...c, error: (e as Error).message });
	}
}

/*
 * Después de cada latido: sube los indicadores nuevos si el cliente comparte,
 * y trae la lista global si la recibe. Cada sentido depende de su interruptor.
 */
async function intercambiarInteligencia(c: Canal) {
	const { compartir, recibir } = await comparticion();
	if (compartir) {
		const { indicadores, hasta } = await indicadoresPendientes();
		if (indicadores.length) {
			const r = await enviar(c, '/api/nodo/indicadores', JSON.stringify({ indicadores }));
			if (!r.ok) throw new Error(`el panel no acepta los indicadores: ${r.status}`);
		}
		await marcarSubidos(hasta);
	}
	if (recibir) {
		const r = await enviar(c, '/api/nodo/lista', '{}');
		if (!r.ok) throw new Error(`el panel no entrega la lista global: ${r.status}`);
		await aplicarLista(c.clavePublicaPanel, await r.json(), c.nodo);
	} else {
		await retirarListaGlobal();
	}
}

/* Los módulos autorizados, tal como vienen en el estado firmado. Si cambian, queda en la auditoría. */
async function guardarAutorizados(modulos: string[]) {
	if (!Array.isArray(modulos)) return;
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'modulos'));
	const antes = (f?.valor as string[] | undefined) ?? null;
	if (JSON.stringify(antes) === JSON.stringify(modulos)) return;
	await db
		.insert(s.ajustes)
		.values({ clave: 'modulos', valor: modulos })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: modulos } });
	await auditar('panel central', 'módulos autorizados cambiados', { antes, ahora: modulos });
}

/*
 * La licencia de pago, tal como viene en el estado firmado. Se guarda opaca (no
 * es secreta: es un permiso firmado); quien la comprueba de verdad es cada
 * trampa de pago al arrancar. La consola la pasa al sensor en el plan y, además,
 * la coteja en el plan como defensa en profundidad (ver candado.ts).
 * Nula o ausente: el nodo es de edición gratis y se borra la que quedara.
 */
async function guardarLicencia(licencia: LicenciaFirmada | null | undefined) {
	if (licencia === undefined) return;
	if (licencia === null) {
		await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'licencia'));
		return;
	}
	await db
		.insert(s.ajustes)
		.values({ clave: 'licencia', valor: licencia })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: licencia } });
}

/*
 * Alta automática: el instalador deja PANEL_URL y PANEL_ALTA_CODIGO. La primera
 * vez que arranca, el nodo se da de alta solo; si el panel no responde, lo
 * vuelve a intentar. Si ya está dado de alta, no hace nada.
 */
export async function altaAutomatica() {
	const panel = env.PANEL_URL;
	const codigo = env.PANEL_ALTA_CODIGO;
	if (!panel || !codigo || (await leer())) return true;
	if (!urlPanelValida(panel) || !/^[A-Za-z0-9_-]{32}$/.test(codigo)) {
		console.error('[alta] PANEL_URL o PANEL_ALTA_CODIGO no son válidos');
		return true;
	}
	const r = await darDeAlta('instalador', panel, codigo);
	if (!r.ok) console.error(`[alta] ${r.motivo}`);
	else console.log('[alta] nodo dado de alta en el panel central');
	return r.ok;
}

/* El botón rojo del cliente: el panel deja de saber nada de este nodo. */
export async function cortar(quien: string) {
	const c = await leer();
	if (!c || c.cortado) return;
	await enviar(c, '/api/nodo/corte', '{}').catch(() => null);
	await guardar({ ...c, cortado: true });
	await auditar(quien, 'canal con el panel central cortado');
}

export async function reanudar(quien: string) {
	const c = await leer();
	if (!c || !c.cortado) return;
	await guardar({ ...c, cortado: false });
	await auditar(quien, 'canal con el panel central reanudado');
	await latir();
}

/* ---------- sensores en otras máquinas ---------- */

type Descarga = { registro: string; usuario: string; token: string };

async function guardarRelease(version: string, firmada: ReleaseFirmada) {
	const valor = { version, firmada };
	await db
		.insert(s.ajustes)
		.values({ clave: 'release', valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
}

/*
 * Pide al panel lo que hace falta para un sensor remoto: la versión firmada
 * en la que está el nodo (que se vuelve a verificar aquí con la clave de
 * publicación, como cualquier versión) y, si se da un sensor, su credencial
 * de descarga de imágenes.
 */
async function pedirAlPanel(sensor?: string) {
	const c = await leer();
	if (!c) throw new Error('El nodo no está dado de alta en el panel central.');
	if (c.cortado) throw new Error('El canal con el panel está cortado.');
	const version = (await cabecera()).cliente.version;
	const r = await enviar(c, '/api/nodo/sensor-remoto', JSON.stringify({ sensor, version }));
	if (!r.ok) throw new Error(`el panel responde ${r.status}: ${(await r.text()).slice(0, 200)}`);
	const b = (await r.json()) as { descarga: Descarga | null; release: ReleaseFirmada };
	const clave = env.PUBLICACION_CLAVE_PUBLICA;
	const v = clave ? verificarRelease(clave, b.release) : null;
	if (!v?.ok || v.release.version !== version)
		throw new Error('La versión que entrega el panel no es auténtica o no es la del nodo.');
	await guardarRelease(version, b.release);
	return { descarga: b.descarga, firmada: b.release, release: v.release };
}

/* La versión firmada en la que está el nodo: la que tienen que llevar sus sensores remotos. */
export async function releaseDelNodo() {
	const version = (await cabecera()).cliente.version;
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'release'));
	const guardada = f?.valor as { version: string; firmada: ReleaseFirmada } | undefined;
	const clave = env.PUBLICACION_CLAVE_PUBLICA;
	if (guardada?.version === version && clave) {
		const v = verificarRelease(clave, guardada.firmada);
		if (v.ok) return { firmada: guardada.firmada, release: v.release };
	}
	const p = await pedirAlPanel();
	return { firmada: p.firmada, release: p.release };
}

export async function credencialSensorRemoto(sensor: string) {
	const p = await pedirAlPanel(sensor);
	if (!p.descarga) throw new Error('El panel no ha dado credencial de descarga.');
	return { descarga: p.descarga, firmada: p.firmada, release: p.release };
}

/* ---------- logotipo del cliente ---------- */

/*
 * El estado firmado trae solo la huella del logotipo; si no es la que hay,
 * se pide la imagen y se acepta solo si su sha256 coincide con la firmada.
 */
async function sincronizarLogo(c: Canal, huellaFirmada: string | null) {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'logo'));
	const actual = (f?.valor as { huella?: string } | undefined)?.huella ?? null;
	if (actual === huellaFirmada) return;
	if (!huellaFirmada) {
		await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'logo'));
		return;
	}
	const r = await enviar(c, '/api/nodo/logo', '{}');
	if (!r.ok) return;
	const l = (await r.json()) as { tipo: string; datos: string };
	const b = Buffer.from(l.datos ?? '', 'base64');
	if (createHash('sha256').update(b).digest('hex') !== huellaFirmada) return;
	if (!['image/png', 'image/jpeg', 'image/webp'].includes(l.tipo)) return;
	const valor = { huella: huellaFirmada, tipo: l.tipo, datos: l.datos };
	await db
		.insert(s.ajustes)
		.values({ clave: 'logo', valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
}

export async function logo() {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'logo'));
	return (f?.valor as { huella: string; tipo: string; datos: string } | undefined) ?? null;
}

/* ---------- nodos de salida de Tor ---------- */

/* Como el logotipo: el estado trae la huella; la lista se pide si cambia y se verifica entera. */
async function sincronizarTor(c: Canal, huellaFirmada: string | null) {
	if (!huellaFirmada) {
		if (await huellaTor()) await quitarTor();
		return;
	}
	if ((await huellaTor()) === huellaFirmada) return;
	const r = await enviar(c, '/api/nodo/tor', '{}');
	if (!r.ok) return;
	const f = (await r.json()) as { lista: string; firma: string };
	if (
		createHash('sha256')
			.update(f.lista ?? '')
			.digest('hex') !== huellaFirmada
	)
		return;
	const v = verificarListaTor(c.clavePublicaPanel, f);
	if (!v.ok) {
		await auditar(`nodo ${c.nodo}`, 'lista de Tor rechazada', { motivo: v.motivo });
		return;
	}
	await guardarTor(huellaFirmada, v.lista);
}
