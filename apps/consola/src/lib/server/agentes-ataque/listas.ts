/*
 * Las listas de ThreatDefence (agentic-attack-detections, MIT: LICENCIA-threatdefence.txt)
 * que lleva cada nodo dentro, también los de Community sin registro: se miran aquí, sin
 * preguntar a nadie, y se renuevan con cada versión (herramientas/paneles/threatdefence.py,
 * de un commit fijado). Ver docs/diseno/agentes-ataque-threatdefence.md, punto 6.
 *
 * - consolas: la IP tiene a la vista el panel de un framework de ataque.
 * - informes: un informe con nombre ata la IP a ataques de uno; vale hasta su fecha de
 *   revisión, porque son VPS que se reasignan.
 *
 * Las dos son una pista para el evento, nunca un bloqueo ni un indicador que se comparta.
 *
 * Los informes de ARTEX del paquete MMD-072-2026 de MalwareMustDie (Detection Rule License
 * 1.1, «MalwareMustDie.org - @unixfreaxjp», LICENCIA-mmd.txt) van aparte, en
 * informes-mmd.json (herramientas/paneles/mmd.py), con la misma forma. Si una IP sale en
 * las dos, manda la de ThreatDefence.
 *
 * Las IP de la infraestructura de ARTEX que publicó Cisco Talos (github.com/Cisco-Talos/IOCs,
 * CC0 1.0: LICENCIA-talos.txt) van en informes-talos.json (herramientas/paneles/talos.py):
 * comparten todas la misma fila, así que van como una fila y una lista de IP. Se miran las
 * últimas, después de ThreatDefence y MalwareMustDie, que dicen más de cada IP.
 */
import listas from './listas.json';
import mmd from './informes-mmd.json';
import talos from './informes-talos.json';

type Consola = [agente: string, puerto: number | null, visto: string | null];
type FilaInforme = [
	agentes: string[],
	actor: string,
	fuente: string,
	reportado: string | null,
	revisar: string,
	confianza: string
];
const datos = listas as unknown as {
	fuente: { repo: string; commit: string };
	consolas: Record<string, Consola>;
	informes: Record<string, FilaInforme>;
};
const datosMmd = mmd as unknown as {
	fuente: { repo: string; commit: string; autor: string };
	informes: Record<string, FilaInforme>;
};

const datosTalos = talos as unknown as {
	fuente: { repo: string; commit: string; informe: string };
	fila: FilaInforme;
	ips: string[];
};
const ipsTalos = new Set(datosTalos.ips);

export const FUENTE_LISTAS = datos.fuente;
export const FUENTE_MMD = datosMmd.fuente;
export const FUENTE_TALOS = datosTalos.fuente;

export type ConsolaVista = { agente: string; version: null; visto: string | null };

export function consolaEn(ip: string): ConsolaVista | null {
	const c = Object.hasOwn(datos.consolas, ip) ? datos.consolas[ip] : undefined;
	return c ? { agente: c[0], version: null, visto: c[2] } : null;
}

export type Informe = {
	agentes: string[];
	actor: string;
	fuente: string;
	reportado: string | null;
	confianza: string;
};

/* La IP sale en un informe y aún no ha pasado su fecha de revisión. */
export function informeDe(ip: string, ahora = new Date()): Informe | null {
	const hoy = ahora.toISOString().slice(0, 10);
	for (const informes of [datos.informes, datosMmd.informes]) {
		const f = Object.hasOwn(informes, ip) ? informes[ip] : undefined;
		if (f && f[4] >= hoy) return deFila(f);
	}
	const t = datosTalos.fila;
	return ipsTalos.has(ip) && t[4] >= hoy ? deFila(t) : null;
}

function deFila(f: FilaInforme): Informe {
	return { agentes: f[0], actor: f[1], fuente: f[2], reportado: f[3], confianza: f[5] };
}
