/*
 * La máquina del nodo (docs/diseno/cortafuegos-anfitrion.md, plan de fortificación
 * §1.1, §1.3, §1.5 y §1.6).
 *
 * - El cortafuegos estricto: una tabla nftables que deniega por defecto. Se enciende
 *   en Ajustes → Host; sin tocarlo, está encendido en el appliance y con el perfil
 *   bancario. El actualizador pregunta (GET /api/actualizador/anfitrion), lo aplica
 *   con interruptor de hombre muerto y cuenta cómo ha quedado.
 * - Lo que el actualizador ve de la máquina: quién entra por SSH (usuarios y huellas
 *   de sus claves, nunca las claves), las reglas de auditd y la versión de Docker
 *   frente a la que fija la versión firmada.
 * - Los eventos de auditd de la máquina (claves sd-*).
 *
 * Todo lo que cambia se apunta en la auditoría como «host change: …» o «host
 * firewall …», y de ahí sale al SIEM del cliente como integridad.anfitrion
 * (salidas/auditoria.ts).
 */
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db, schema as s } from './db';
import { entradaValida, leerAcceso, paraElCortafuegos } from './acceso';
import { destinos as destinosSalida } from './salida';
import { estadoBanca } from './banca';

/* Las acciones de la auditoría: su clase en el SIEM depende de este principio exacto. */
import { PREFIJO_CAMBIO, PREFIJO_CORTAFUEGOS } from './anfitrion-acciones';
export { PREFIJO_CAMBIO, PREFIJO_CORTAFUEGOS };

const CLAVE_AJUSTE = 'cortafuegos-anfitrion';
const CLAVE_HECHOS = 'anfitrion-hechos';
const CLAVE_ESTADO = 'anfitrion-cortafuegos';

export const MAX_REDES = 64;
export const MAX_DESTINOS = 64;
export const PLAZO_INFORME_MS = 10 * 60_000;

export type AjusteAnfitrion = {
	/* undefined: lo de serie (encendido en el appliance y con el perfil bancario). */
	estricto?: boolean;
	ssh: { puerto: number; redes: string[] };
	salida: { restringida: boolean; destinos: string[] };
	por?: string;
	cuando?: string;
	version?: number;
};

export type UsuarioSSH = { usuario: string; uid: number; claves: number; huellas: string[] };
export type HechosAnfitrion = {
	appliance: boolean;
	ssh: { activo: boolean; usuarios: UsuarioSSH[] };
	auditd: { estado: string; detalle: string | null };
	docker: {
		version: string | null;
		fijada: string | null;
		desfasada: boolean;
		actualizacion: string | null;
		detalle: string | null;
	};
	detalle: string | null;
	recibido: string;
};

export const ESTADOS_ESTRICTO = [
	'aplicada',
	'quitada',
	'revertida',
	'conflicto',
	'sin-nft',
	'suspendida',
	'error'
] as const;
export type EstadoEstricto = (typeof ESTADOS_ESTRICTO)[number];
export type InformeEstricto = {
	estado: EstadoEstricto;
	detalle: string;
	huella: string | null;
	recibido: string;
};

const inicial = (): AjusteAnfitrion => ({
	ssh: { puerto: 22, redes: [] },
	salida: { restringida: false, destinos: [] }
});

async function leerClave<T>(clave: string): Promise<T | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, clave));
	return (f?.valor as T | undefined) ?? null;
}

async function escribirClave(clave: string, valor: unknown) {
	await db
		.insert(s.ajustes)
		.values({ clave, valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
}

export async function ajusteAnfitrion(): Promise<AjusteAnfitrion> {
	return { ...inicial(), ...((await leerClave<AjusteAnfitrion>(CLAVE_AJUSTE)) ?? {}) };
}

export async function hechosAnfitrion(): Promise<HechosAnfitrion | null> {
	return leerClave<HechosAnfitrion>(CLAVE_HECHOS);
}

export async function estadoEstricto(): Promise<InformeEstricto | null> {
	return leerClave<InformeEstricto>(CLAVE_ESTADO);
}

/*
 * Si el modo estricto está encendido de verdad: lo que diga el ajuste y, si nadie lo
 * ha tocado, encendido en el appliance y con el perfil bancario completo.
 */
export async function estrictoEfectivo(
	a?: AjusteAnfitrion
): Promise<{ activo: boolean; deSerie: boolean; motivo: string | null }> {
	const ajuste = a ?? (await ajusteAnfitrion());
	if (ajuste.estricto !== undefined)
		return { activo: ajuste.estricto, deSerie: false, motivo: null };
	if ((await hechosAnfitrion())?.appliance)
		return { activo: true, deSerie: true, motivo: 'appliance' };
	if ((await estadoBanca()).completo) return { activo: true, deSerie: true, motivo: 'banking' };
	return { activo: false, deSerie: true, motivo: null };
}

/* host:puerto, con el nombre o la IP que acepte el actualizador (Go: net.SplitHostPort). */
export function destinoValido(texto: string): string | null {
	const t = texto.trim().toLowerCase();
	const v6 = /^\[([0-9a-f:.]+)\]:(\d{1,5})$/.exec(t);
	const m = v6 ?? /^([a-z0-9.-]{1,253}):(\d{1,5})$/.exec(t);
	if (!m) return null;
	const puerto = Number(m[2]);
	if (puerto < 1 || puerto > 65535) return null;
	if (!v6 && (m[1].startsWith('.') || m[1].endsWith('.') || m[1].includes('..'))) return null;
	return v6 ? `[${m[1]}]:${puerto}` : `${m[1]}:${puerto}`;
}

/* La URL de un proxy (HTTPS_PROXY), como host:puerto, sin usuario ni contraseña. */
export function destinoDeProxy(url: string | undefined): string | null {
	if (!url) return null;
	try {
		const u = new URL(url);
		const puerto = u.port || (u.protocol === 'https:' ? '443' : '80');
		return destinoValido(`${u.hostname}:${puerto}`);
	} catch {
		return null;
	}
}

async function urlPanel(): Promise<string | null> {
	const c = await leerClave<{ panel?: string }>('canal');
	return c?.panel ?? null;
}

/*
 * Los repositorios de paquetes del appliance (Ubuntu y Docker): con la salida
 * restringida, sin ellos no llegarían los parches.
 */
export const DESTINOS_APPLIANCE = [
	'archive.ubuntu.com:443',
	'security.ubuntu.com:443',
	'download.docker.com:443'
];

/*
 * La salida que se deja con la salida restringida. Con proxy, solo el proxy: todo lo
 * demás sale por él. Sin proxy, lo que usa el nodo (panel, registro, Entra), los
 * repositorios del appliance y lo que añada el cliente (sus SIEM, su correo…).
 */
export async function destinosEfectivos(
	a: AjusteAnfitrion,
	e: Record<string, string | undefined> = env
): Promise<{ destinos: string[]; comprobar: string[] }> {
	const proxy = destinoDeProxy(e.HTTPS_PROXY || e.https_proxy);
	const propios = destinosSalida(await urlPanel(), e).map((d) => {
		const u = new URL(d.url);
		return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
	});
	const comprobar = proxy ? [proxy] : propios.slice(0, 1);
	const todos = proxy
		? [proxy, ...a.salida.destinos]
		: [
				...propios,
				...((await hechosAnfitrion())?.appliance ? DESTINOS_APPLIANCE : []),
				...a.salida.destinos
			];
	return { destinos: [...new Set(todos)].slice(0, MAX_DESTINOS * 2), comprobar };
}

/* Lo que contesta GET /api/actualizador/anfitrion. */
export async function paraElActualizador(e: Record<string, string | undefined> = env) {
	const a = await ajusteAnfitrion();
	const { activo } = await estrictoEfectivo(a);
	const consola = await paraElCortafuegos();
	const acceso = await leerAcceso();
	const salida = a.salida.restringida
		? { restringida: true, ...(await destinosEfectivos(a, e)) }
		: { restringida: false, destinos: [], comprobar: [] };
	return {
		estricto: activo,
		emergencia: acceso.estado === 'abierta' && !!acceso.emergencia,
		consola: { estado: consola.estado, redes: consola.redes },
		ssh: a.ssh,
		salida
	};
}

export type ResultadoAjuste = { ok: true } | { ok: false; error: string };

/* Guarda el ajuste desde Ajustes → Host. */
export async function guardarAjusteAnfitrion(
	quien: string,
	pedido: {
		estricto: boolean | null;
		sshPuerto: number;
		sshRedes: string[];
		restringida: boolean;
		destinos: string[];
	}
): Promise<ResultadoAjuste> {
	if (!Number.isInteger(pedido.sshPuerto) || pedido.sshPuerto < 1 || pedido.sshPuerto > 65535)
		return { ok: false, error: 'The SSH port must be between 1 and 65535.' };
	if (pedido.sshRedes.length > MAX_REDES)
		return { ok: false, error: `At most ${MAX_REDES} SSH networks.` };
	const redes: string[] = [];
	for (const r of pedido.sshRedes) {
		const v = entradaValida(r);
		if (!v) return { ok: false, error: `Not a valid IP address or network: ${r}` };
		if (!redes.includes(v)) redes.push(v);
	}
	if (pedido.destinos.length > MAX_DESTINOS)
		return { ok: false, error: `At most ${MAX_DESTINOS} outbound destinations.` };
	const destinos: string[] = [];
	for (const d of pedido.destinos) {
		const v = destinoValido(d);
		if (!v) return { ok: false, error: `Not a valid destination (host:port): ${d}` };
		if (!destinos.includes(v)) destinos.push(v);
	}
	const antes = await ajusteAnfitrion();
	const valor: AjusteAnfitrion = {
		...(pedido.estricto === null ? {} : { estricto: pedido.estricto }),
		ssh: { puerto: pedido.sshPuerto, redes },
		salida: { restringida: pedido.restringida, destinos },
		por: quien,
		cuando: new Date().toISOString(),
		version: (antes.version ?? 0) + 1
	};
	await db.transaction(async (tx) => {
		await tx
			.insert(s.ajustes)
			.values({ clave: CLAVE_AJUSTE, valor })
			.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
		await tx.insert(s.auditoria).values({
			quien,
			accion: `${PREFIJO_CORTAFUEGOS}setting changed`,
			detalle: {
				estricto: pedido.estricto ?? 'default',
				ssh: valor.ssh,
				salida: valor.salida
			}
		});
	});
	return { ok: true };
}

/* El perfil bancario enciende el modo estricto (sin tocar el SSH ni la salida). */
export async function encenderEstricto(quien: string): Promise<boolean> {
	const a = await ajusteAnfitrion();
	if (a.estricto === true) return false;
	await escribirClave(CLAVE_AJUSTE, {
		...a,
		estricto: true,
		por: quien,
		cuando: new Date().toISOString(),
		version: (a.version ?? 0) + 1
	});
	return true;
}

/* ---------- Lo que manda el actualizador ---------- */

const texto = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);

/* POST /api/actualizador/anfitrion, validado; null si no tiene forma. */
export function leerHechos(b: unknown): Omit<HechosAnfitrion, 'recibido'> | null {
	if (!b || typeof b !== 'object') return null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- se valida campo a campo
	const x = b as Record<string, any>;
	const d = x.docker;
	if (!d || typeof d !== 'object' || typeof d.desfasada !== 'boolean') return null;
	const m = x.maquina && typeof x.maquina === 'object' ? x.maquina : null;
	const usuarios: UsuarioSSH[] = [];
	for (const u of Array.isArray(m?.ssh?.usuarios) ? m.ssh.usuarios.slice(0, 50) : []) {
		if (!u || typeof u.usuario !== 'string' || !Number.isInteger(u.uid)) return null;
		usuarios.push({
			usuario: u.usuario.slice(0, 64),
			uid: u.uid,
			claves: Number.isInteger(u.claves) ? Math.min(u.claves, 10_000) : 0,
			huellas: (Array.isArray(u.huellas) ? u.huellas : [])
				.filter((h: unknown) => typeof h === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/.test(h))
				.slice(0, 20)
		});
	}
	return {
		appliance: m?.appliance === true,
		ssh: { activo: m?.ssh?.activo === true, usuarios },
		auditd: {
			estado: texto(m?.auditd?.estado, 20) ?? 'desconocido',
			detalle: texto(m?.auditd?.detalle, 300)
		},
		docker: {
			version: texto(d.version, 40) || texto(m?.docker?.version, 40) || null,
			fijada: texto(d.fijada, 40) || null,
			desfasada: d.desfasada,
			actualizacion: texto(m?.docker?.actualizacion, 20),
			detalle: texto(m?.docker?.detalle, 300)
		},
		detalle: texto(x.detalle, 300)
	};
}

const clavesDe = (h: Pick<HechosAnfitrion, 'ssh'> | null) =>
	(h?.ssh.usuarios ?? []).flatMap((u) => u.huellas.map((x) => `${u.usuario} ${x}`)).sort();

/* Guarda lo que ha visto el actualizador y apunta en la auditoría lo que cambia. */
export async function recibirHechos(h: Omit<HechosAnfitrion, 'recibido'>): Promise<string[]> {
	const antes = await hechosAnfitrion();
	const valor: HechosAnfitrion = { ...h, recibido: new Date().toISOString() };
	const cambios: { accion: string; detalle: Record<string, unknown> }[] = [];
	if (antes) {
		const [a, d] = [clavesDe(antes), clavesDe(h)];
		const nuevas = d.filter((k) => !a.includes(k));
		const quitadas = a.filter((k) => !d.includes(k));
		if (nuevas.length || quitadas.length)
			cambios.push({ accion: `${PREFIJO_CAMBIO}SSH keys`, detalle: { nuevas, quitadas } });
		if (antes.ssh.activo !== h.ssh.activo)
			cambios.push({
				accion: `${PREFIJO_CAMBIO}SSH service ${h.ssh.activo ? 'running' : 'stopped'}`,
				detalle: {}
			});
		if (antes.auditd.estado !== h.auditd.estado)
			cambios.push({
				accion: `${PREFIJO_CAMBIO}audit rules ${h.auditd.estado}`,
				detalle: { detalle: h.auditd.detalle }
			});
	} else if (h.ssh.activo || h.ssh.usuarios.length) {
		cambios.push({
			accion: `${PREFIJO_CAMBIO}SSH access found`,
			detalle: { activo: h.ssh.activo, claves: clavesDe(h) }
		});
	}
	if (h.docker.desfasada && !antes?.docker.desfasada)
		cambios.push({
			accion: `${PREFIJO_CAMBIO}Docker older than the signed version`,
			detalle: { version: h.docker.version, fijada: h.docker.fijada }
		});
	await db.transaction(async (tx) => {
		await tx
			.insert(s.ajustes)
			.values({ clave: CLAVE_HECHOS, valor })
			.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
		for (const c of cambios)
			await tx
				.insert(s.auditoria)
				.values({ quien: 'node machine', accion: c.accion, detalle: c.detalle });
	});
	return cambios.map((c) => c.accion);
}

/* POST /api/actualizador/anfitrion/cortafuegos. */
export async function recibirEstricto(b: unknown): Promise<boolean> {
	if (!b || typeof b !== 'object') return false;
	const { estado, detalle, huella } = b as Record<string, unknown>;
	if (!ESTADOS_ESTRICTO.includes(estado as EstadoEstricto)) return false;
	const antes = await estadoEstricto();
	const valor: InformeEstricto = {
		estado: estado as EstadoEstricto,
		detalle: texto(detalle, 500) ?? '',
		huella: typeof huella === 'string' && /^[0-9a-f]{64}$/.test(huella) ? huella : null,
		recibido: new Date().toISOString()
	};
	await db.transaction(async (tx) => {
		await tx
			.insert(s.ajustes)
			.values({ clave: CLAVE_ESTADO, valor })
			.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
		if (
			antes?.estado !== valor.estado ||
			(valor.estado === 'aplicada' && antes?.huella !== valor.huella)
		)
			await tx.insert(s.auditoria).values({
				quien: 'node machine',
				accion: `${PREFIJO_CORTAFUEGOS}${valor.estado}`,
				detalle: { detalle: valor.detalle, huella: valor.huella }
			});
	});
	return true;
}

export const CATEGORIAS_AUDITD = [
	'docker',
	'nodo',
	'sudoers',
	'ssh',
	'usuarios',
	'auditoria'
] as const;
const NOMBRE_CATEGORIA: Record<(typeof CATEGORIAS_AUDITD)[number], string> = {
	docker: 'Docker',
	nodo: 'node folder',
	sudoers: 'sudoers',
	ssh: 'SSH configuration or keys',
	usuarios: 'users and groups',
	auditoria: 'audit configuration'
};
const MAX_EVENTOS = 200;

/* POST /api/actualizador/anfitrion/auditoria: cada evento, una fila de la auditoría. */
export async function recibirAuditd(b: unknown): Promise<number | null> {
	if (!b || typeof b !== 'object') return null;
	const { eventos, omitidos, saltado } = b as Record<string, unknown>;
	if (!Array.isArray(eventos)) return null;
	const filas: { quien: string; accion: string; detalle: Record<string, unknown> }[] = [];
	for (const e of eventos.slice(0, MAX_EVENTOS)) {
		if (!e || typeof e !== 'object') return null;
		const x = e as Record<string, unknown>;
		const cat = x.categoria as (typeof CATEGORIAS_AUDITD)[number];
		if (!CATEGORIAS_AUDITD.includes(cat)) continue;
		const usuario = texto(x.usuario, 64);
		filas.push({
			quien: usuario ? `node machine (${usuario})` : 'node machine',
			accion: `${PREFIJO_CAMBIO}${NOMBRE_CATEGORIA[cat]}`,
			detalle: {
				cuando: texto(x.cuando, 40),
				serie: texto(x.serie, 40),
				tipo: texto(x.tipo, 30),
				usuario,
				programa: texto(x.programa, 200),
				ruta: texto(x.ruta, 300),
				exito: texto(x.exito, 10)
			}
		});
	}
	const n = Number.isInteger(omitidos) ? Math.max(0, omitidos as number) : 0;
	if (n > 0 || saltado === true)
		filas.push({
			quien: 'node machine',
			accion: `${PREFIJO_CAMBIO}audit events not sent (too many in one round)`,
			detalle: { omitidos: n, saltado: saltado === true }
		});
	if (!filas.length) return 0;
	await db.insert(s.auditoria).values(filas);
	return filas.length;
}

/* ---------- Lo que se enseña ---------- */

/*
 * El aviso de arriba: Docker por detrás de la versión firmada, o el cortafuegos estricto
 * encendido que no ha quedado puesto (revertido, en conflicto, sin nftables…).
 */
export async function avisoAnfitrion(): Promise<{
	appliance: boolean;
	docker: { version: string; fijada: string } | null;
	estricto: string | null;
} | null> {
	const h = await hechosAnfitrion();
	const docker =
		h?.docker.desfasada && h.docker.version && h.docker.fijada
			? { version: h.docker.version, fijada: h.docker.fijada }
			: null;
	let estricto: string | null = null;
	if ((await estrictoEfectivo()).activo) {
		const e = await estadoEstricto();
		if (e && ['revertida', 'conflicto', 'sin-nft', 'error'].includes(e.estado))
			estricto = `${e.estado} (${e.detalle})`;
	}
	if (!docker && !estricto) return null;
	return { appliance: !!h?.appliance, docker, estricto };
}

/* Lo que va en el latido al panel: un resumen, sin usuarios ni huellas. */
export async function anfitrionParaLatido(): Promise<{
	anfitrion?: {
		estricto: EstadoEstricto | 'apagado';
		auditd: string;
		ssh: { activo: boolean; usuarios: number; claves: number };
		docker: { version: string | null; fijada: string | null; desfasada: boolean };
	};
}> {
	const h = await hechosAnfitrion();
	if (!h) return {};
	const est = await estadoEstricto();
	const { activo } = await estrictoEfectivo();
	const viejo = !est || Date.now() - new Date(est.recibido).getTime() > PLAZO_INFORME_MS;
	return {
		anfitrion: {
			estricto: !activo ? 'apagado' : viejo || !est ? 'error' : est.estado,
			auditd: h.auditd.estado,
			ssh: {
				activo: h.ssh.activo,
				usuarios: h.ssh.usuarios.length,
				claves: h.ssh.usuarios.reduce((n, u) => n + u.claves, 0)
			},
			docker: {
				version: h.docker.version,
				fijada: h.docker.fijada,
				desfasada: h.docker.desfasada
			}
		}
	};
}
