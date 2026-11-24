/*
 * El lado del nodo del canal con el panel central. El nodo abre todas las
 * conexiones: se da de alta una vez con un código, y después late cada minuto
 * y recibe en la respuesta su estado deseado firmado.
 *
 * La clave privada del nodo se genera aquí y no sale nunca. Las claves públicas
 * del panel se fijan en el alta: un estado firmado por cualquier otra clave se
 * rechaza, aunque llegue por la misma dirección. Esa lista solo la cambia una
 * versión firmada con la clave de publicación (clavesPanel), nunca el panel
 * (docs/diseno/panel-endurecido.md).
 *
 * El cliente puede cortar el canal cuando quiera. Cortado, el nodo deja de
 * latir y de aceptar estados; sigue detectando y respondiendo en local.
 */
import { createHash } from 'node:crypto';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { confianza } from './claves';
import {
	aislamientoMasDebil,
	discoMasDebil,
	compararVersiones,
	edicionDeRelease,
	firmarPeticion,
	generarClaves,
	huella,
	verificarEstado,
	ultimoEmitidoTras,
	verificarListaTor,
	verificarOrden,
	verificarRelease,
	clavePanelValida,
	motivoOrdenPanelAqui,
	clavesPanelTras,
	type EstadoDeseado,
	type EstadoMarcaNodo,
	type MarcaFirmada,
	type Release,
	type Latido,
	type LicenciaFirmada,
	type RecuperacionPanel,
	type ReleaseFirmada
} from '@sugardaddy/canal';
import { recibirBalizasRele, type BalizaRele } from './balizas-rele';
import { clavesParaElPanel, guardarReleSellado } from './balizas-sello';
import { juntarRevocaciones, revocacionesGuardadas } from './candado';
import { cuentaActivas } from './colocacion';
import {
	aplicarAtenciones,
	borradoEnElPanel,
	corteSinAvisar,
	incidentesPorSubir,
	marcarIncidentesSubidos,
	paraLatido as vigilanciaParaLatido,
	vigilancia,
	volverASubir
} from './vigilancia';
import { db, schema as s } from './db';
import { auditar, autoActualizar, cabecera, comparticion, latidoMinimo } from './consultas';
import { anfitrionParaLatido } from './anfitrion';
import { entregaParaLatido, integridadParaLatido } from './integridad-latido';
import { saludParaLatido } from './salud-maquina';
import { mantenimientoParaLatido } from './mantenimiento';
import { esperaActual } from './politica-actualizacion';
import {
	aplicarLista,
	indicadoresPendientes,
	marcarSubidos,
	retirarListaGlobal
} from './inteligencia';
import { cerrarYa, paraLatido, recibirSolicitud } from './soporte';
import { configActiva } from './auth/entra-propio';
import { estadoB2B } from './auth/b2b';
import { selloParaLatido } from './auditoria-cadena';
import { salidaParaLatido } from './salida';
import { guardarTor, huellaTor, quitarTor } from './tor';
import {
	guardarCatalogoPartner,
	huellaCatalogoPartner,
	partnerDelNodo,
	retirarCatalogoPartner
} from './catalogo-partner';
import { validarDescarga } from './script-sensor';

type Canal = {
	panel: string;
	nodo: string;
	cliente: string;
	clavePrivada: string;
	clavePublica: string;
	/* La que se fijó en el alta (la principal del panel). */
	clavePublicaPanel: string;
	/*
	 * Las claves del panel en las que se confía, si el alta o una versión firmada han dado una
	 * lista; sin ella, solo clavePublicaPanel. versionClavesPanel: la versión que la dio (una
	 * versión más vieja no la cambia).
	 */
	clavesPanel?: string[];
	versionClavesPanel?: string;
	cortado: boolean;
	ultimoContacto: string | null;
	error: string | null;
	estado: EstadoDeseado | null;
	/*
	 * El `emitido` del último estado tipado aceptado (auditoría 2026-11-14): uno anterior es una
	 * repetición y no vale (verificarEstado). Ausente en los nodos que vienen de antes de la 0.32.
	 */
	ultimoEmitido?: string | null;
	/*
	 * Cuándo aceptó el nodo por última vez algo firmado a la antigua, sin `tipo` (un panel
	 * anterior a la 0.32). Para saber cuándo ha acabado la transición.
	 */
	firmasAntiguas?: { estado?: string; lista?: string };
};

/* Las claves del panel con las que se comprueba lo que baja. */
export const clavesDelPanel = (c: Pick<Canal, 'clavePublicaPanel' | 'clavesPanel'>) =>
	c.clavesPanel?.length ? c.clavesPanel : [c.clavePublicaPanel];

async function leer(): Promise<Canal | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'canal'));
	return (f?.valor as Canal) ?? null;
}

/* ¿Este nodo lo gestiona un panel? = está dado de alta (existe Canal). Un nodo
 * community NO tiene Canal, aunque tenga la clave pública para verificar. No es
 * lo mismo que «tiene claves de publicación». */
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
		huellasPanel: clavesDelPanel(c).map(huella),
		/* Cuándo llegó por última vez algo firmado por un panel anterior a la 0.32. */
		firmasAntiguas: c.firmasAntiguas ?? null,
		ordenPanel: await ordenPanelAplicada(),
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
	if (await leer()) return { ok: false, motivo: 'This node is already enrolled in a Central.' };
	const { nodo } = (await cabecera()).cliente;
	const claves = generarClaves();
	const base = panel.replace(/\/+$/, '');
	let r: Response;
	try {
		r = await fetch(`${base}/api/nodo/alta`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ codigo, nodo, clavePublica: claves.publica }),
			/* Lleva el código de alta: una redirección no se sigue. */
			redirect: 'manual',
			signal: AbortSignal.timeout(15_000)
		});
	} catch {
		return { ok: false, motivo: 'Could not reach Central.' };
	}
	if (!r.ok) {
		const m = (await r.json().catch(() => null))?.message;
		return { ok: false, motivo: `Central rejected the enrollment: ${m ?? r.status}` };
	}
	const b = await r.json();
	/* La lista entera, si el panel la da y es buena; si no, solo la principal, como antes. */
	const lista =
		Array.isArray(b.clavesPanel) &&
		b.clavesPanel.length <= 8 &&
		b.clavesPanel.every(clavePanelValida) &&
		b.clavesPanel.includes(String(b.clavePublicaPanel))
			? [...new Set(b.clavesPanel as string[])]
			: undefined;
	await guardar({
		panel: base,
		nodo,
		cliente: String(b.cliente),
		clavePrivada: claves.privada,
		clavePublica: claves.publica,
		clavePublicaPanel: String(b.clavePublicaPanel),
		...(lista && lista.length > 1 ? { clavesPanel: lista } : {}),
		cortado: false,
		ultimoContacto: null,
		error: null,
		estado: null
	});
	await auditar(quien, 'node enrolled in Central', {
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

/* Los estados se guardan en español; en la auditoría se leen en inglés. */
const ESTADO_TXT: Record<string, string> = {
	aplicando: 'applying',
	aplicada: 'applied',
	fallida: 'failed',
	cancelado: 'cancelled'
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

/*
 * Las claves del panel que trae una versión firmada con la clave de publicación (panel.ts del
 * canal): solo si es para este panel y no es más vieja que la que dio la lista actual.
 */
export async function adoptarClavesPanel(r: Release) {
	if (!r.clavesPanel) return;
	const c = await leer();
	if (!c) return;
	if (c.versionClavesPanel && compararVersiones(r.version, c.versionClavesPanel) < 0) return;
	const nuevas = clavesPanelTras(clavesDelPanel(c), r.clavesPanel);
	if (!nuevas) return;
	await guardar({ ...c, clavesPanel: nuevas, versionClavesPanel: r.version });
	await auditar(`node ${c.nodo}`, 'Central keys renewed by a signed version', {
		version: r.version,
		antes: clavesDelPanel(c).map(huella),
		ahora: nuevas.map(huella)
	});
}

/*
 * La versión que trae las claves nuevas la instala una consola anterior, que no las
 * entiende, y el panel ya no la vuelve a mandar. En cada latido se miran las versiones
 * firmadas que el nodo tiene guardadas (la última que le llegó y la de su sensor remoto).
 */
async function adoptarDeLoGuardado() {
	const clave = confianza();
	if (!clave) return;
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'release'));
	const guardada = (f?.valor as { firmada?: ReleaseFirmada } | undefined)?.firmada;
	for (const firmada of [(await actualizacion()).release, guardada]) {
		if (!firmada) continue;
		const v = verificarRelease(clave, firmada);
		if (v.ok && edicionDeRelease(v.release) !== 'community') await adoptarClavesPanel(v.release);
	}
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
	const clave = confianza();
	if (!clave) return;
	const actual = (await cabecera()).cliente.version;
	const previa = await actualizacion();
	const v = verificarRelease(clave, estado.release);
	const rechazo = !v.ok
		? v.motivo
		: v.release.version !== estado.versionObjetivo
			? 'the signed version is not the one the state asks for'
			: compararVersiones(v.release.version, actual) <= 0
				? `downgrades are not allowed (${actual} → ${v.release.version})`
				: edicionDeRelease(v.release) === 'community'
					? 'it is a Community release (images on ghcr.io): a node managed by Central only installs Cloud releases'
					: null;
	/* Una versión auténtica de su edición puede traer las claves del panel, aunque no se instale. */
	if (v.ok && edicionDeRelease(v.release) !== 'community') await adoptarClavesPanel(v.release);
	if (rechazo) {
		await auditar(`node ${nodo}`, 'version rejected', { motivo: rechazo });
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
	await auditar(`node ${nodo}`, 'version pending installation', { version: v.release.version });
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

/* Qué pasó al mirar: `version` es la publicada y firmada, si se llegó a leer y era buena. */
export type ResultadoCommunity =
	| { visto: 'no-aplica' }
	| { visto: 'sin-red' }
	| { visto: 'rechazada'; motivo: string }
	| { visto: 'al-dia' | 'pendiente'; version: string };

export async function considerarCommunity(): Promise<ResultadoCommunity> {
	if (await gestionadoPorPanel()) return { visto: 'no-aplica' };
	const clave = confianza();
	if (!clave) return { visto: 'no-aplica' };
	if (!(await autoActualizar()).activo) return { visto: 'no-aplica' };
	let firmada: ReleaseFirmada;
	try {
		const res = await fetch(URL_RELEASE_COMMUNITY, { signal: AbortSignal.timeout(10_000) });
		if (!res.ok) return { visto: 'sin-red' };
		firmada = (await res.json()) as ReleaseFirmada;
	} catch {
		return { visto: 'sin-red' };
	}
	if (!firmada?.release || !firmada?.firma)
		return { visto: 'rechazada', motivo: 'it is not a signed version' };
	const v = verificarRelease(clave, firmada);
	if (!v.ok) {
		await auditar('auto-update', 'community release rejected', { motivo: v.motivo });
		return { visto: 'rechazada', motivo: v.motivo };
	}
	/* Una de Cloud (imágenes del registro privado) no es para este nodo (SUP-3). */
	if (edicionDeRelease(v.release) === 'cloud') {
		const motivo = 'it is a Cloud release (images on azurecr.io)';
		await auditar('auto-update', 'community release rejected', { motivo });
		return { visto: 'rechazada', motivo };
	}
	const version = v.release.version;
	const actual = (await cabecera()).cliente.version;
	if (compararVersiones(version, actual) <= 0) return { visto: 'al-dia', version };
	const previa = await actualizacion();
	if (previa.version === version && previa.estado !== 'al-dia')
		return { visto: 'pendiente', version };
	await guardarActualizacion({
		estado: 'pendiente',
		version,
		release: firmada,
		detalle: null
	});
	await auditar('auto-update', 'community version pending', {
		version
	});
	return { visto: 'pendiente', version };
}

/* ---------- marca de tiempo (docs/diseno/firmas-raiz.md) ---------- */

/*
 * La marca que reparte el panel se guarda tal cual para el actualizador, que es quien la
 * comprueba (con sus claves) y la compara con la copia estática. Aquí solo se mira la forma:
 * la consola no decide nada con ella.
 */
async function guardarMarcaDelPanel(m: MarcaFirmada | null) {
	if (
		m !== null &&
		(typeof m !== 'object' ||
			typeof m.marca !== 'string' ||
			typeof m.firma !== 'string' ||
			m.marca.length > 64 * 1024)
	)
		return;
	/* null: el panel no tiene marca que repartir. «ajustes.valor» no admite nulos: se olvida la que hubiera. */
	if (m === null) await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'marca-panel'));
	else await guardarAjuste('marca-panel', m);
}

export async function marcaDelPanel(): Promise<MarcaFirmada | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'marca-panel'));
	return (f?.valor as MarcaFirmada | undefined) ?? null;
}

const ESTADOS_MARCA = ['al-dia', 'sin-marca', 'caducada', 'retenida'] as const;
const textoCorto = (x: unknown, max: number) =>
	typeof x === 'string' && x !== '' ? x.slice(0, max) : null;

/* Lo que dice el actualizador, validado: es lo que va en el latido y en el aviso. */
export function leerEstadoMarca(b: unknown): EstadoMarcaNodo | null {
	const x = b as Record<string, unknown> | null;
	if (!x || !(ESTADOS_MARCA as readonly unknown[]).includes(x.estado)) return null;
	return {
		estado: x.estado as EstadoMarcaNodo['estado'],
		detalle: textoCorto(x.detalle, 500) ?? '',
		ultima: textoCorto(x.ultima, 20),
		caduca: textoCorto(x.caduca, 40),
		origen: textoCorto(x.origen, 20),
		registro: textoCorto(x.registro, 300)
	};
}

export async function estadoMarca(): Promise<EstadoMarcaNodo | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'marca-estado'));
	return (f?.valor as EstadoMarcaNodo | undefined) ?? null;
}

export async function guardarEstadoMarca(e: EstadoMarcaNodo) {
	const previo = await estadoMarca();
	await guardarAjuste('marca-estado', e);
	if (previo?.estado !== e.estado && (e.estado === 'caducada' || e.estado === 'retenida'))
		await auditar('updater', 'release timestamp warning', { estado: e.estado, detalle: e.detalle });
	if (e.registro && previo?.registro !== e.registro)
		await auditar('updater', 'transparency log warning', { detalle: e.registro });
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
	await auditar(`sensor ${id}`, `handover ${ESTADO_TXT[estado] ?? estado}`, {
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
	await auditar(`sensor ${sensor}`, `configuration ${ESTADO_TXT[estado] ?? estado}`, {
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
		await auditar('updater', `configuration ${ESTADO_TXT[estado] ?? estado}`, {
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
	await auditar('updater', `update ${ESTADO_TXT[estado] ?? estado}`, {
		version,
		detalle: detalle.slice(0, 500)
	});
	return true;
}

/*
 * Lo que va en todo latido, también en el mínimo: lo que el panel necesita para la licencia,
 * las actualizaciones y los anillos, y lo que el cliente ha encendido a mano (compartir, el
 * soporte, la vigilancia de sus incidentes).
 */
async function latidoComun(soporteLatido: Latido['soporte']) {
	const cab = await cabecera();
	return {
		version: cab.cliente.version,
		comparticion: await comparticion(),
		actualizacion: await (async () => {
			const a = await actualizacion();
			/* Esperar por la política del cliente no frena los anillos (politica-actualizacion.ts). */
			const e = await esperaActual(a);
			return { estado: a.estado, version: a.version, ...(e.motivo ? { espera: e.motivo } : {}) };
		})(),
		soporte: soporteLatido,
		...(await (async () => {
			const c = await leer();
			return c ? { clavesPanel: clavesDelPanel(c).map(huella) } : {};
		})()),
		/* Si llegó aquí por una orden firmada de dirección del panel: cuál (su fecha). */
		...(await (async () => {
			const o = await ordenPanelAplicada();
			return o ? { ordenPanel: { emitida: o.emitida, origen: o.origen } } : {};
		})()),
		/* Solo si el cliente comparte sus incidentes o tiene abierto el soporte. */
		...(await vigilanciaParaLatido(soporteLatido.estado === 'abierto')),
		/*
		 * Una ventana de mantenimiento en curso (mantenimiento.ts): el panel no da por caído el
		 * nodo ni sus sensores parados por ella. También en el mínimo: es gobierno de la flota.
		 */
		...(await mantenimientoParaLatido()),
		...(await (async () => {
			const m = await estadoMarca();
			return m ? { marca: m } : {};
		})()),
		...(await (async () => {
			const c = await configuracion();
			return c
				? { configuracion: { version: c.version, estado: c.estado, detalle: c.detalle } }
				: {};
		})())
	};
}

async function latido(panel: string | null = null): Promise<Latido> {
	const soporteLatido = await paraLatido();
	const comun = await latidoComun(soporteLatido);
	/*
	 * Latido mínimo (Ajustes → Central): ni siquiera se calculan las cifras ni lo demás. Lo
	 * decide el nodo, no el panel: un panel cambiado no puede pedir más.
	 */
	if (await latidoMinimo()) return { ...comun, minimo: true };
	const ahora = Date.now();
	/* Los retirados no cuentan: el panel los daría por sensores caídos. */
	const sensores = await db.select().from(s.sensores).where(isNull(s.sensores.retirado));
	const vivos = sensores.filter(
		(x) => x.ultimoLatido && ahora - x.ultimoLatido.getTime() < 5 * 60_000
	);
	/* Activas: las comprobadas que ve el cliente (§8.2), lo mismo que cuenta Inicio. */
	const trampas = await cuentaActivas();
	const [cifras] = await db
		.select({
			eventos: sql<number>`count(*)::int`,
			criticos: sql<number>`count(*) filter (where ${s.eventos.severidad} = 'critica')::int`
		})
		.from(s.eventos)
		.where(and(gte(s.eventos.cuando, new Date(ahora - 86_400_000)), isNull(s.eventos.escaner)));
	const cab = await cabecera();
	/* Con qué se aíslan las trampas: el más débil de los sensores vivos que lo dicen. */
	const aislamiento = aislamientoMasDebil(
		vivos.map((x) => x.capacidades?.hechos?.['motor.aislamiento']?.valor)
	);
	/* El disco de datos del appliance (disco.cifrado y disco.tpm): el más débil que se sepa. */
	const disco = discoMasDebil(vivos.map((x) => x.capacidades?.hechos));
	/* Desde la 0.30: si sale por un proxy y a qué destinos llega (salida.ts). */
	const salida = salidaParaLatido(panel);
	return {
		...comun,
		sensores: { total: sensores.length, vivos: vivos.length },
		trampas: { total: trampas.total, activos: trampas.activas },
		eventos24h: cifras.eventos,
		criticos24h: cifras.criticos,
		pendientes: cab.pendientes,
		acceso: {
			modo: (await configActiva())?.modo ?? 'local',
			b2b: await estadoB2B()
		},
		/* El último sello de la auditoría: fuera del nodo, nadie lo puede rehacer. */
		...(await selloParaLatido()),
		...(aislamiento ? { aislamiento } : {}),
		...(disco ? { disco } : {}),
		...(salida ? { salida } : {}),
		/* Desde la 0.32: la máquina del nodo, resumida (anfitrion.ts). */
		...(await anfitrionParaLatido()),
		/*
		 * La última comprobación de integridad (cuándo y cuántas desviaciones, sin el detalle)
		 * y lo que sus sensores apartaron de la entrega. No en el mínimo, como el sello.
		 */
		...(await integridadParaLatido()),
		...entregaParaLatido(sensores.map((x) => x.capacidades?.hechos)),
		/* La salud de las máquinas de los sensores, resumida (salud-maquina.ts). */
		...(await saludParaLatido().catch(() => ({})))
	};
}

async function enviar(c: Canal, ruta: string, cuerpo: string, espera = 15_000) {
	return fetch(`${c.panel}${ruta}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...firmarPeticion(c.clavePrivada, c.nodo, 'POST', ruta, cuerpo)
		},
		body: cuerpo,
		signal: AbortSignal.timeout(espera)
	});
}

/*
 * Cuáles de estas IP (públicas, que han atacado al nodo) alojan el panel de un agente de
 * IA de ataque, según la central (paneles-ataque.ts). Por el canal firmado; null si este
 * nodo no lo gestiona un panel, está cortado o no hay respuesta.
 */
export async function panelesPorCanal(
	ips: string[]
): Promise<Record<
	string,
	{ agente: string; version: string | null; visto: string | null }
> | null> {
	const c = await leer();
	if (!c || c.cortado) return null;
	try {
		const r = await enviar(c, '/api/nodo/paneles', JSON.stringify({ ips }), 10_000);
		if (!r.ok) return null;
		const d = (await r.json()) as { paneles?: unknown };
		return d?.paneles && typeof d.paneles === 'object' ? (d.paneles as never) : null;
	} catch {
		return null;
	}
}

/*
 * La credencial de descarga de un sensor la crea el panel en el registro de Azure al
 * pedirla: un token nuevo, esperar a que Azure lo dé por listo (el panel espera hasta
 * 60 s) y su contraseña. Con los 15 s de siempre, el primer alta de un sensor fallaba a
 * menudo. El que instala está esperando con su curl abierto, que no corta.
 */
const ESPERA_CREDENCIAL_SENSOR = 120_000;

/*
 * Lleva al panel el código para recuperar una contraseña, para que lo mande por
 * correo (auth/recuperar.ts). Por el canal firmado si a este nodo lo gestiona un
 * panel y no está cortado; null si no (entonces va por la puerta de community).
 */
export async function mandarCodigoPorCanal(
	correo: string,
	codigo: string
): Promise<boolean | null> {
	const c = await leer();
	if (!c || c.cortado) return null;
	try {
		const r = await enviar(c, '/api/nodo/recuperacion', JSON.stringify({ correo, codigo }));
		return r.status === 202;
	} catch {
		return false;
	}
}

/*
 * Un incidente al que nadie ha contestado, a SeguridadSI (servicio de pago:
 * solo si el cliente lo marcó en Incidentes y el nodo lo gestiona un panel).
 * Nada de lo que escribió el atacante: el origen, el motivo y las cuentas.
 */
export type Escalado = {
	origen: string;
	motivo: string;
	severidad: string;
	eventos: number;
	puntos: number;
	trampas: number;
	abierto: string;
	minutos: number;
};

export async function escalarAlPanel(d: Escalado): Promise<boolean> {
	const c = await leer();
	if (!c || c.cortado) return false;
	try {
		const r = await enviar(c, '/api/nodo/escalado', JSON.stringify(d));
		if (r.status !== 202) throw new Error(`Central responded ${r.status}`);
		return true;
	} catch (e) {
		console.error('[escalado] did not reach Central', e);
		return false;
	}
}

/*
 * Algo firmado por el panel a la antigua, sin `tipo` (auditoría 2026-11-14): un panel anterior a
 * la 0.32. Se acepta durante la transición y se cuenta: queda en el canal (`firmasAntiguas`, que
 * devuelve estadoCanal) y sale en el registro una vez al día.
 */
const DIA_MS = 86_400_000;

function avisarFirmaAntigua(clase: 'estado' | 'lista', anterior: string | undefined) {
	if (anterior && Date.now() - Date.parse(anterior) < DIA_MS) return;
	console.warn(
		`[canal] Central signed the ${clase === 'estado' ? 'desired state' : 'global list'} the old way (no type)`
	);
}

async function anotarFirmaAntigua(clase: 'estado' | 'lista') {
	const c = await leer();
	if (!c) return;
	avisarFirmaAntigua(clase, c.firmasAntiguas?.[clase]);
	await guardar({
		...c,
		firmasAntiguas: { ...c.firmasAntiguas, [clase]: new Date().toISOString() }
	});
}

/* Un latido. Lo llama el reloj de hooks.server.ts; los fallos se guardan, no se lanzan. */
export async function latir() {
	const c = await leer();
	if (!c) return;
	if (c.cortado) {
		await avisarDelCorte(c);
		return;
	}
	try {
		const r = await enviar(c, '/api/nodo/latido', JSON.stringify(await latido(c.panel)));
		if (!r.ok) throw new Error(`Central responded ${r.status}`);
		const v = verificarEstado(clavesDelPanel(c), c.cliente, await r.json(), Date.now(), {
			ultimoEmitido: c.ultimoEmitido
		});
		if (!v.ok) {
			/* Esto no es un fallo de red: alguien que no es el panel está respondiendo. */
			await auditar(`node ${c.nodo}`, 'desired state rejected', { motivo: v.motivo });
			throw new Error(`desired state rejected: ${v.motivo}`);
		}
		const ahora = new Date().toISOString();
		if (v.legado) avisarFirmaAntigua('estado', c.firmasAntiguas?.estado);
		await guardar({
			...c,
			estado: v.estado,
			ultimoEmitido: ultimoEmitidoTras(c.ultimoEmitido, v),
			...(v.legado ? { firmasAntiguas: { ...c.firmasAntiguas, estado: ahora } } : {}),
			ultimoContacto: ahora,
			error: null
		});
		/*
		 * Antes que el resto, y sin depender de él: apagar la compartición y lo que atiende el
		 * panel no pueden esperar a que vaya bien otra cosa. Su fallo se apunta al final.
		 */
		let falloVigilancia: unknown = null;
		await aplicarAtenciones(v.estado.atenciones)
			.then(() => subirIncidentes(c))
			.catch((e) => (falloVigilancia = e));
		/*
		 * Y un cebo que ha saltado fuera de la red tampoco puede esperar a que el panel
		 * acepte los indicadores o sirva el logotipo: es una alerta.
		 */
		let falloRele: unknown = null;
		const apuntarFallo = (e: unknown) => {
			falloRele ??= e;
		};
		await guardarDireccionRele(v.estado.rele, c.nodo, v.estado.releFirmado).catch(apuntarFallo);
		await guardarReleSellado(v.estado.releSellado).catch(apuntarFallo);
		await publicarBalizasRele(c).catch(apuntarFallo);
		if (v.estado.releBalizas) await drenarBalizasRele(c).catch(apuntarFallo);
		await considerar(v.estado, c.nodo);
		await adoptarDeLoGuardado().catch((e) => console.error('[canal] Central keys', e));
		await recibirSolicitud(v.estado.soporte);
		await guardarAutorizados(v.estado.modulos);
		await guardarLicencia(v.estado.licencia);
		await guardarRevocaciones(v.estado.revocaciones);
		if (v.estado.logo !== undefined) await sincronizarLogo(c, v.estado.logo);
		if (v.estado.tor !== undefined) await sincronizarTor(c, v.estado.tor);
		if (v.estado.catalogoPartner !== undefined)
			await sincronizarCatalogoPartner(c, v.estado.catalogoPartner);
		await intercambiarInteligencia(c);
		await guardarRecuperacionPanel(v.estado.recuperacion, v.estado.recuperacionFirmada, c.cliente);
		if (v.estado.marca !== undefined) await guardarMarcaDelPanel(v.estado.marca);
		/* Lo último: puede cambiar la dirección del panel para el siguiente latido. */
		if (v.estado.panelFirmado !== undefined)
			await aplicarOrdenPanel(v.estado.panelFirmado, 'panel').catch(apuntarFallo);
		if (falloVigilancia) throw falloVigilancia;
		if (falloRele) throw falloRele;
	} catch (e) {
		/* Sobre lo último guardado: un fallo aquí no deshace el contacto, que sí ha habido. */
		await guardar({ ...((await leer()) ?? c), error: (e as Error).message });
		/* Sin panel desde hace rato: ¿lo ha movido SeguridadSI a otra dirección? */
		await buscarOrdenPanel().catch((x) => console.error('[canal] Central address order', x));
	}
}

/* ---------- la dirección del panel por orden firmada (pérdida de la región) ---------- */

/*
 * El nodo fija la dirección del panel en el alta. Si el panel se pierde con su región, uno
 * levantado en otra no lo encuentra nadie. La orden `panel` (ordenes.ts del canal), firmada
 * con una clave de publicación de uso delegaciones que no vive en el panel, mueve a otra
 * dirección los nodos que estén en una de las de `antes`, dentro de su ventana. Llega por dos
 * caminos: en el estado deseado (un traslado planificado) o, con el panel caído, en un fichero
 * del repo público que el nodo mira solo si el panel no le contesta desde hace media hora. Una
 * orden más vieja (o igual) que la aplicada no vale: no se puede volver a una dirección
 * retirada. Un canal cortado no sigue ninguna (lo cortó el cliente).
 * docs/administrador/panel/perder-la-region.md.
 */
const URL_ORDEN_PANEL =
	env.PANEL_ORDEN_URL ??
	'https://raw.githubusercontent.com/Seguridadsi/sugardaddy/main/transparencia/panel.json';
const SIN_PANEL_MS = 30 * 60_000;
const CADA_BUSQUEDA_MS = 30 * 60_000;
let ultimaBusqueda = 0;

type OrdenPanelAplicada = {
	emitida: string;
	direccion: string;
	antes: string;
	origen: 'panel' | 'estatica';
	cuando: string;
};

export async function ordenPanelAplicada(): Promise<OrdenPanelAplicada | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'panel-orden'));
	return (f?.valor as OrdenPanelAplicada | undefined) ?? null;
}

export async function aplicarOrdenPanel(
	firmada: unknown,
	origen: 'panel' | 'estatica',
	ahora = Date.now()
): Promise<'aplicada' | 'no-aplica' | 'rechazada'> {
	const c = await leer();
	if (!c || c.cortado) return 'no-aplica';
	const clave = confianza();
	const v = clave
		? verificarOrden(clave, firmada, 'panel')
		: ({ ok: false, motivo: 'there is no trusted publication key' } as const);
	if (!v.ok) {
		/* Una vez por texto: el fichero estático se mira cada media hora mientras no haya panel. */
		const texto = createHash('sha256').update(JSON.stringify(firmada)).digest('hex');
		const [ya] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'panel-orden-mala'));
		if ((ya?.valor as { texto?: string } | undefined)?.texto !== texto) {
			await guardarAjuste('panel-orden-mala', { texto });
			await auditar(`node ${c.nodo}`, 'Central address order rejected', {
				origen,
				motivo: v.motivo
			});
		}
		return 'rechazada';
	}
	/* Fuera de su ventana, para otro panel o ya aplicada: no es un fallo, no se apunta. */
	if (motivoOrdenPanelAqui(v.orden, c.panel, ahora)) return 'no-aplica';
	const previa = await ordenPanelAplicada();
	if (previa && Date.parse(v.orden.emitida) <= Date.parse(previa.emitida)) return 'no-aplica';
	const nuevas = v.orden.clavesPanel
		? clavesPanelTras(clavesDelPanel(c), v.orden.clavesPanel)
		: null;
	await guardar({
		...c,
		panel: v.orden.direccion,
		...(nuevas ? { clavesPanel: nuevas } : {}),
		error: null
	});
	await guardarAjuste('panel-orden', {
		emitida: v.orden.emitida,
		direccion: v.orden.direccion,
		antes: c.panel,
		origen,
		cuando: new Date(ahora).toISOString()
	} satisfies OrdenPanelAplicada);
	await auditar('SeguridadSI', 'Central address changed by a signed order', {
		antes: c.panel,
		ahora: v.orden.direccion,
		origen,
		emitida: v.orden.emitida,
		...(nuevas ? { clavesPanel: nuevas.map(huella) } : {})
	});
	return 'aplicada';
}

/* Con el panel callado más de media hora, mira el fichero del repo público (como mucho cada media hora). */
export async function buscarOrdenPanel(ahora = Date.now()) {
	const c = await leer();
	if (!c || c.cortado) return;
	const contacto = c.ultimoContacto ? Date.parse(c.ultimoContacto) : 0;
	if (ahora - contacto < SIN_PANEL_MS || ahora - ultimaBusqueda < CADA_BUSQUEDA_MS) return;
	ultimaBusqueda = ahora;
	let firmada: unknown;
	try {
		const r = await fetch(URL_ORDEN_PANEL, {
			redirect: 'error',
			signal: AbortSignal.timeout(10_000)
		});
		/* Sin fichero (404) no hay orden: lo normal. */
		if (!r.ok) return;
		const texto = await r.text();
		if (texto.length > 16 * 1024) return;
		firmada = JSON.parse(texto);
	} catch {
		return;
	}
	if ((await aplicarOrdenPanel(firmada, 'estatica', ahora)) === 'aplicada') await latir();
}

/* Para las pruebas: que la siguiente búsqueda no espere. */
export const _olvidarBusquedaOrdenPanel = () => (ultimaBusqueda = 0);

/*
 * Los incidentes, si el cliente los comparte (vigilancia.ts): lo que el panel no tiene. Si
 * los ha dejado de compartir, antes que nada que los borre. Lo que no llegue, al siguiente.
 */
async function subirIncidentes(c: Canal) {
	const v = await vigilancia();
	if (v.borrar) {
		const r = await enviar(c, '/api/nodo/incidentes', JSON.stringify({ borrar: true }));
		if (!r.ok) throw new Error(`Central did not delete the incidents: ${r.status}`);
		await borradoEnElPanel();
	}
	if (!v.incidentes) return;
	const { incidentes, marcas } = await incidentesPorSubir(v);
	if (!incidentes.length) return;
	const r = await enviar(c, '/api/nodo/incidentes', JSON.stringify({ incidentes }));
	if (!r.ok) throw new Error(`Central did not accept the incidents: ${r.status}`);
	await marcarIncidentesSubidos(marcas);
	/* Fila a fila: lo que no acepta no bloquea lo demás, y aquí queda constancia. */
	const { descartadas } = (await r.json().catch(() => ({}))) as { descartadas?: number };
	if (descartadas) await auditar(`node ${c.nodo}`, 'Central discarded incidents', { descartadas });
}

/* Se cortó sin que el panel se enterase: tiene que borrar sus incidentes igualmente. */
async function avisarDelCorte(c: Canal) {
	if (!(await vigilancia()).corte) return;
	const r = await enviar(c, '/api/nodo/corte', '{}').catch(() => null);
	if (r?.ok) await corteSinAvisar(false);
}

/* ---------- balizas que vuelven por el relé público (docs/diseno/rele-balizas.md) ---------- */

/*
 * La dirección del relé. Desde los frenos del nodo (docs/diseno/frenos-del-nodo.md) la firma de
 * la clave del panel no basta: solo se cambia con la orden `releFirmado`, firmada además con una
 * clave de publicación (uso delegaciones o la de legado), que no vive en el panel. El `rele` sin
 * firmar, que sigue llegando para los nodos de antes, ya no cambia nada aquí: se apunta una vez en
 * la auditoría y se sigue con la que había. Una orden más vieja que la aplicada no vale (no se
 * puede volver a una dirección retirada). null en la orden: no hay relé, se olvida. El ajuste
 * «rele» solo lo escribe esto. Los cebos ya sembrados no cambian: llevan la suya.
 */
export async function guardarDireccionRele(
	direccion: string | null | undefined,
	nodo: string,
	firmada?: unknown
) {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'rele'));
	const antes = (f?.valor as string | undefined) ?? null;
	if (firmada === undefined) {
		if (direccion === undefined || direccion === antes) return;
		/* Una vez por dirección pedida: no en cada latido. */
		const [ya] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'rele-sin-firma'));
		if ((ya?.valor as { direccion?: unknown } | undefined)?.direccion === direccion) return;
		await guardarAjuste('rele-sin-firma', { direccion });
		await auditar(`node ${nodo}`, 'relay address change ignored: not signed by SeguridadSI', {
			antes,
			pedida: String(direccion)
		});
		return;
	}
	const c = confianza();
	const v = c
		? verificarOrden(c, firmada, 'rele')
		: ({ ok: false, motivo: 'there is no trusted publication key' } as const);
	if (!v.ok) {
		await auditar(`node ${nodo}`, 'relay address rejected', { motivo: v.motivo });
		return;
	}
	const [o] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'rele-orden'));
	const aplicada = (o?.valor as { emitida?: string } | undefined)?.emitida;
	if (aplicada && Date.parse(v.orden.emitida) < Date.parse(aplicada)) {
		await auditar(`node ${nodo}`, 'relay address rejected', {
			motivo: 'older than the order in use'
		});
		return;
	}
	if (aplicada !== v.orden.emitida) await guardarAjuste('rele-orden', { emitida: v.orden.emitida });
	const ahora = v.orden.direccion;
	if (antes === ahora) return;
	if (ahora === null) await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'rele'));
	else await guardarAjuste('rele', ahora);
	await auditar('SeguridadSI', 'relay address changed', { antes, ahora });
}

/*
 * El nodo publica en el panel su conjunto VIGENTE de tokens de baliza para que
 * el panel pueda rutear a este cliente los eventos externos que lleguen por el
 * relé (token→cliente, /api/nodo/balizas). Solo cuando el conjunto cambia: se
 * guarda su huella y, si es la misma, no se vuelve a mandar (como el logo o la
 * lista de Tor), para que miles de nodos con tokens estables no reenvíen lo
 * mismo cada minuto. Un nodo sin balizas y que nunca publicó no manda nada.
 */
async function publicarBalizasRele(c: Canal) {
	const filas = await db.select({ token: s.balizas.token }).from(s.balizas);
	/* De los sellados, solo la ruta: el panel no llega a conocer el token (balizas-sello.ts). */
	const { tokens, rutas } = clavesParaElPanel(filas.map((f) => f.token).sort());
	/* Sin sellados, la misma huella que antes: un nodo que se pone al día no republica. */
	const huella = createHash('sha256')
		.update(JSON.stringify(rutas.length ? { tokens, rutas } : tokens))
		.digest('hex');
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'balizas-rele-huella'));
	const previa = (f?.valor as { huella?: string } | undefined)?.huella ?? null;
	if (huella === previa) return;
	if (!tokens.length && !rutas.length && previa === null) return; // nunca tuvo balizas: nada que registrar aún
	const r = await enviar(
		c,
		'/api/nodo/balizas',
		JSON.stringify(rutas.length ? { tokens, rutas } : { tokens })
	);
	if (!r.ok) throw new Error(`Central did not accept the beacon tokens: ${r.status}`);
	await db
		.insert(s.ajustes)
		.values({ clave: 'balizas-rele-huella', valor: { huella } })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: { huella } } });
}

/*
 * El nodo recoge del panel las balizas pendientes del relé (eventos externos ya
 * ruteados a este cliente) y las ingiere. Confirma cada tanda y pide la
 * siguiente hasta vaciar; la confirmación viaja en la petición de la tanda
 * siguiente, así que la última se confirma en la vuelta que ya no trae nada. Lo
 * no confirmado se vuelve a dar (el ingreso deduplica por la huella). Acotado a
 * un número de tandas por latido: si queda más, el flag del siguiente latido lo
 * trae otra vez.
 */
const MAX_TANDAS_RELE = 50;

async function drenarBalizasRele(c: Canal) {
	let ack: number[] = [];
	for (let tanda = 0; tanda < MAX_TANDAS_RELE; tanda++) {
		const r = await enviar(c, '/api/nodo/rele', JSON.stringify({ ack }));
		if (!r.ok) throw new Error(`Central did not deliver the relay beacons: ${r.status}`);
		const { eventos } = (await r.json()) as { eventos?: BalizaRele[] };
		if (!Array.isArray(eventos) || !eventos.length) break;
		await recibirBalizasRele(eventos);
		ack = eventos.map((e) => e.id);
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
			if (!r.ok) throw new Error(`Central did not accept the indicators: ${r.status}`);
		}
		await marcarSubidos(hasta);
	}
	if (recibir) {
		const r = await enviar(c, '/api/nodo/lista', '{}');
		if (!r.ok) throw new Error(`Central did not deliver the global list: ${r.status}`);
		await aplicarLista(clavesDelPanel(c), await r.json(), c.nodo, new Date(), () =>
			anotarFirmaAntigua('lista')
		);
	} else {
		await retirarListaGlobal();
	}
}

/*
 * Un código de recuperación que SeguridadSI ha mandado desde su panel al correo de contacto del
 * cliente: aquí solo llega su hash. Se guarda una vez (el id es el del panel) para ese usuario
 * local y se canjea en /sign-in/recover como uno pedido desde la entrada (auth/recuperar.ts).
 *
 * Desde los frenos del nodo (docs/diseno/frenos-del-nodo.md) solo vale la orden
 * `recuperacionFirmada`, firmada además con una clave de publicación y para este cliente: con la
 * clave del panel sola, un panel tomado podría cambiar la contraseña de administrador de todas
 * las consolas que lo permiten. La `recuperacion` sin firmar, que sigue llegando para los nodos de
 * antes, se ignora y se apunta una vez.
 */
export async function guardarRecuperacionPanel(
	plana: RecuperacionPanel | null | undefined,
	firmada?: unknown,
	cliente?: string
) {
	let r: RecuperacionPanel | null = null;
	if (firmada !== undefined) {
		const c = confianza();
		const v = c
			? verificarOrden(c, firmada, 'recuperacion')
			: ({ ok: false, motivo: 'there is no trusted publication key' } as const);
		if (!v.ok || v.orden.cliente !== cliente) {
			await auditar('Central', 'recovery code from Central rejected', {
				motivo: v.ok ? 'the order is for another customer' : v.motivo
			});
			return;
		}
		r = {
			id: v.orden.id,
			usuario: v.orden.usuario,
			codigoHash: v.orden.codigoHash,
			caduca: v.orden.caduca
		};
	} else if (plana && typeof plana.id === 'string') {
		const [ya] = await db
			.select({ valor: s.ajustes.valor })
			.from(s.ajustes)
			.where(eq(s.ajustes.clave, 'recuperacion-sin-firma'));
		if ((ya?.valor as { id?: string } | undefined)?.id !== plana.id) {
			await guardarAjuste('recuperacion-sin-firma', { id: plana.id });
			await auditar('Central', 'recovery code from Central ignored: not signed by SeguridadSI', {
				usuario: String(plana.usuario)
			});
		}
		return;
	}
	if (!r) return;
	/*
	 * Solo si el cliente lo ha permitido en Ajustes (SUP-12). Por defecto, no: aunque venga
	 * firmada por SeguridadSI, abrir la consola desde fuera lo decide el cliente.
	 */
	if (!(await recuperacionPanelActiva())) {
		const [ya] = await db
			.select({ id: s.recuperacionesClave.id })
			.from(s.recuperacionesClave)
			.where(eq(s.recuperacionesClave.id, `panel:${r.id}`));
		if (!ya)
			await auditar('Central', 'recovery code from Central ignored: not allowed in Settings', {
				usuario: r.usuario
			});
		return;
	}
	const caduca = new Date(r.caduca);
	if (!(caduca.getTime() > Date.now())) return;
	if (!/^sha256\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(r.codigoHash)) return;
	const [u] = await db
		.select({ id: s.usuariosLocales.id })
		.from(s.usuariosLocales)
		.where(eq(s.usuariosLocales.usuario, r.usuario.trim().toLowerCase()));
	if (!u) return;
	const [nueva] = await db
		.insert(s.recuperacionesClave)
		.values({
			id: `panel:${r.id}`,
			usuarioId: u.id,
			codigoHash: r.codigoHash,
			origen: 'panel',
			caduca
		})
		.onConflictDoNothing()
		.returning({ id: s.recuperacionesClave.id });
	if (nueva)
		await auditar('Central', 'recovery code received from Central', {
			usuario: r.usuario
		});
}

/* Si el cliente deja que SeguridadSI le mande un código de recuperación desde el panel. */
export async function recuperacionPanelActiva(): Promise<boolean> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'recuperacion-panel'));
	return (f?.valor as { activa?: boolean } | undefined)?.activa === true;
}

export async function guardarRecuperacionPanelActiva(quien: string, activa: boolean) {
	const valor = { activa };
	await db
		.insert(s.ajustes)
		.values({ clave: 'recuperacion-panel', valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
	await auditar(
		quien,
		activa ? 'recovery from Central allowed' : 'recovery from Central not allowed',
		{}
	);
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
	await auditar('Central', 'authorized modules changed', { antes, ahora: modulos });
}

/*
 * La licencia de pago, tal como viene en el estado firmado. Se guarda opaca (no
 * es secreta: es un permiso firmado); quien la comprueba de verdad es cada
 * trampa de pago al arrancar. La consola la pasa al sensor en el plan y, además,
 * la coteja en el plan como defensa en profundidad (ver candado.ts).
 * Nula o ausente: no se toca la que hubiera. Que el panel deje de mandarla (un
 * fallo suyo, una baja) no para lo desplegado: lo para una revocación firmada
 * (docs/diseno/licencias-de-pago.md, DORA art. 30.3.f, B-06).
 */
async function guardarLicencia(licencia: LicenciaFirmada | null | undefined) {
	if (!licencia) return;
	await db
		.insert(s.ajustes)
		.values({ clave: 'licencia', valor: licencia })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: licencia } });
}

/*
 * Las revocaciones de licencias que entrega el panel. Solo entran las firmadas con la
 * clave de licencias, y nunca se quita ninguna: el panel puede dejar de mandarlas, pero
 * no deshacerlas. Una que alcance a la licencia del nodo saca del plan sus trampas de
 * pago, y la trampa tampoco arranca con ella (va en el fichero de la licencia).
 */
async function guardarRevocaciones(llegan: unknown) {
	if (!Array.isArray(llegan) || !llegan.length) return;
	const { lista, nuevas } = juntarRevocaciones(await revocacionesGuardadas(), llegan);
	if (!nuevas.length) return;
	await db
		.insert(s.ajustes)
		.values({ clave: 'revocaciones', valor: lista })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: lista } });
	await auditar('Central', 'license revoked', {
		revocaciones: nuevas.map((r) => JSON.parse(r.revocacion))
	});
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
		console.error('[alta] PANEL_URL or PANEL_ALTA_CODIGO is not valid');
		return true;
	}
	const r = await darDeAlta('installer', panel, codigo);
	if (!r.ok) console.error(`[alta] ${r.motivo}`);
	else console.log('[alta] node enrolled in Central');
	return r.ok;
}

/* El botón rojo del cliente: el panel deja de saber nada de este nodo. */
export async function cortar(quien: string) {
	const c = await leer();
	if (!c || c.cortado) return;
	const r = await enviar(c, '/api/nodo/corte', '{}').catch(() => null);
	await guardar({ ...c, cortado: true });
	await corteSinAvisar(!r?.ok);
	/* Quien corta deja de confiar en el panel: el soporte no se queda abierto. */
	await cerrarYa(quien);
	await auditar(quien, 'channel with Central cut');
}

export async function reanudar(quien: string) {
	const c = await leer();
	if (!c || !c.cortado) return;
	await guardar({ ...c, cortado: false });
	await auditar(quien, 'channel with Central resumed');
	/* Al cortar, el panel borró sus incidentes. */
	await corteSinAvisar(false);
	await volverASubir();
	await latir();
}

/* ---------- sensores en otras máquinas ---------- */

async function guardarRelease(version: string, firmada: ReleaseFirmada, completa?: ReleaseFirmada) {
	const valor = { version, firmada, ...(completa ? { completa } : {}) };
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
	if (!c) throw new Error('The node is not enrolled in Central.');
	if (c.cortado) throw new Error('The channel with Central is cut.');
	const version = (await cabecera()).cliente.version;
	const r = await enviar(
		c,
		'/api/nodo/sensor-remoto',
		JSON.stringify({ sensor, version }),
		sensor ? ESPERA_CREDENCIAL_SENSOR : undefined
	);
	if (!r.ok) throw new Error(`Central responded ${r.status}: ${(await r.text()).slice(0, 200)}`);
	/* descarga viene sin firma: credencialSensorRemoto la acota antes de darla (script-sensor.ts). */
	const b = (await r.json()) as {
		descarga: unknown;
		release: ReleaseFirmada;
		completa?: ReleaseFirmada;
	};
	const clave = confianza();
	const v = clave ? verificarRelease(clave, b.release) : null;
	if (!v?.ok || v.release.version !== version)
		throw new Error(
			'The version delivered by Central is not authentic or is not the node version.'
		);
	/*
	 * Desde la 0.32.1 el panel da a los nodos la versión sin el instalador (releaseParaNodos)
	 * y, aparte, la completa: la que hace falta para instalar un sensor verificado. Se
	 * comprueba igual; si no vale o no viene, la de siempre.
	 */
	const vc = b.completa && clave ? verificarRelease(clave, b.completa) : null;
	const completa =
		vc?.ok && vc.release.version === version
			? { firmada: b.completa!, release: vc.release }
			: { firmada: b.release, release: v.release };
	await guardarRelease(version, b.release, completa.firmada);
	await adoptarClavesPanel(v.release);
	return { descarga: b.descarga, firmada: b.release, release: v.release, completa };
}

/*
 * La versión firmada de una versión concreta, si es la del nodo: la que deja el actualizador
 * para el sensor cuando una instalación nueva no la trajo (SEN-3, A1 de la revisión). En un
 * nodo de un panel, la que guardó o pide al panel; en Community, la publicada en el repo
 * público, solo si es esa misma versión. null si no la hay. El actualizador la vuelve a
 * comprobar con sus propias claves: aquí no se decide nada.
 */
export async function versionFirmadaDe(version: string): Promise<ReleaseFirmada | null> {
	if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
	if (await gestionadoPorPanel()) {
		try {
			const { firmada, release } = await releaseDelNodo();
			return release.version === version ? firmada : null;
		} catch {
			return null;
		}
	}
	const clave = confianza();
	if (!clave) return null;
	try {
		const res = await fetch(URL_RELEASE_COMMUNITY, { signal: AbortSignal.timeout(10_000) });
		if (!res.ok) return null;
		const firmada = (await res.json()) as ReleaseFirmada;
		const v = verificarRelease(clave, firmada);
		return v.ok && v.release.version === version ? firmada : null;
	} catch {
		return null;
	}
}

/* La versión firmada en la que está el nodo: la que tienen que llevar sus sensores remotos. */
export async function releaseDelNodo() {
	const version = (await cabecera()).cliente.version;
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'release'));
	const guardada = f?.valor as { version: string; firmada: ReleaseFirmada } | undefined;
	const clave = confianza();
	if (guardada?.version === version && clave) {
		const v = verificarRelease(clave, guardada.firmada);
		if (v.ok) return { firmada: guardada.firmada, release: v.release };
	}
	const p = await pedirAlPanel();
	return { firmada: p.firmada, release: p.release };
}

/*
 * La versión completa en la que está el nodo, con su instalador: la que necesita la
 * instalación de un sensor verificado (la que reciben los nodos no lo lleva desde la 0.32.1).
 */
export async function releaseCompletaDelNodo() {
	const version = (await cabecera()).cliente.version;
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'release'));
	const guardada = f?.valor as
		{ version: string; firmada: ReleaseFirmada; completa?: ReleaseFirmada } | undefined;
	const clave = confianza();
	if (guardada?.version === version && clave) {
		for (const firmada of [guardada.completa, guardada.firmada]) {
			if (!firmada) continue;
			const v = verificarRelease(clave, firmada);
			if (v.ok && v.release.instalador) return { firmada, release: v.release };
		}
	}
	return (await pedirAlPanel()).completa;
}

export async function credencialSensorRemoto(sensor: string) {
	const p = await pedirAlPanel(sensor);
	if (!p.descarga) throw new Error('Central did not provide a download credential.');
	/*
	 * Lo único de la respuesta que no viene firmado con la clave de publicación: va al
	 * instalador que corre como root en otra máquina, así que se acota su forma (C03).
	 */
	return {
		descarga: validarDescarga(p.descarga),
		firmada: p.completa.firmada,
		release: p.completa.release
	};
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
	const v = verificarListaTor(clavesDelPanel(c), f);
	if (!v.ok) {
		await auditar(`node ${c.nodo}`, 'Tor list rejected', { motivo: v.motivo });
		return;
	}
	await guardarTor(huellaFirmada, v.lista);
}

/* ---------- trampas del partner ---------- */

/*
 * Como la lista de Tor: el estado trae la huella del paquete y se pide si cambia. Lo que
 * llega se comprueba entero (catalogo-partner.ts) con las claves de publicación, no con la
 * del panel: la central de un partner solo lo entrega. Uno que no vale no sustituye al que hay.
 */
async function sincronizarCatalogoPartner(c: Canal, huellaFirmada: string | null) {
	if (!partnerDelNodo()) return;
	if (!huellaFirmada) {
		if (await huellaCatalogoPartner()) await retirarCatalogoPartner();
		return;
	}
	if ((await huellaCatalogoPartner()) === huellaFirmada) return;
	const r = await enviar(c, '/api/nodo/catalogo-partner', '{}');
	if (!r.ok) return;
	const motivo = await guardarCatalogoPartner(huellaFirmada, await r.text());
	if (motivo) await auditar(`node ${c.nodo}`, 'Partner honeypot catalog rejected', { motivo });
}

/* Solo para las pruebas. */
export const _adoptarDeLoGuardado = adoptarDeLoGuardado;
