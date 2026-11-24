/*
 * ¿La IP que ha atacado aloja el panel de control de un agente de IA de ataque?
 * Primero se mira la lista de ThreatDefence que lleva el propio nodo
 * (agentes-ataque/listas.ts), sin red. Lo que no está ahí se pregunta a la central, que
 * tiene la lista de Shodan y no la reparte (su paneles-ataque.ts): el nodo
 * pregunta solo por las IP públicas que ya han tocado sus trampas, y guarda la
 * respuesta en memoria un día. Va por el canal firmado si a este nodo lo gestiona un
 * panel, o con el token del registro si es un Community registrado; si no, no
 * pregunta y no hay pista.
 *
 * Nunca espera a la central: lo que no sabe aún lo pide aparte y sale en la próxima
 * carga. Es una pista, no una prueba, y no se comparte (no va a los indicadores).
 */
import { esIpPublica } from '@sugardaddy/canal';
import { consolaEn } from './agentes-ataque/listas';

export type PanelAtaque = { agente: string; version: string | null; visto: string | null };

const DIA = 86_400_000;
/* Tras un fallo de la central, no se vuelve a preguntar en 10 minutos. */
const PAUSA_FALLO = 10 * 60_000;
const POR_LOTE = 500;
const MAXIMO_EN_MEMORIA = 50_000;

const sabido = new Map<string, { p: PanelAtaque | null; hasta: number }>();
const pendientes = new Set<string>();
let enCurso = false;
let pausaHasta = 0;

type Preguntar = (ips: string[]) => Promise<Record<string, PanelAtaque> | null>;

/* Por qué vía se pregunta; se cambia en las pruebas. */
let preguntar: Preguntar = async (ips) => {
	const { panelesPorCanal } = await import('./canal');
	const porCanal = await panelesPorCanal(ips);
	if (porCanal) return porCanal;
	const { panelesPorRegistro } = await import('./registro');
	return panelesPorRegistro(ips);
};

export function _probar(p: Preguntar | null) {
	sabido.clear();
	pendientes.clear();
	enCurso = false;
	pausaHasta = 0;
	if (p) preguntar = p;
}

const valida = (p: unknown): p is PanelAtaque =>
	!!p &&
	typeof p === 'object' &&
	typeof (p as PanelAtaque).agente === 'string' &&
	/^[\w .-]{1,40}$/.test((p as PanelAtaque).agente);

async function vaciar() {
	if (enCurso || !pendientes.size || Date.now() < pausaHasta) return;
	enCurso = true;
	try {
		while (pendientes.size) {
			const lote = [...pendientes].slice(0, POR_LOTE);
			const r = await preguntar(lote);
			if (!r) {
				pausaHasta = Date.now() + PAUSA_FALLO;
				break;
			}
			if (sabido.size > MAXIMO_EN_MEMORIA) sabido.clear();
			const hasta = Date.now() + DIA;
			for (const ip of lote) {
				const p = r[ip];
				sabido.set(ip, {
					p: valida(p)
						? {
								agente: p.agente,
								version: typeof p.version === 'string' ? p.version.slice(0, 40) : null,
								visto: typeof p.visto === 'string' ? p.visto.slice(0, 30) : null
							}
						: null,
					hasta
				});
				pendientes.delete(ip);
			}
		}
	} catch {
		pausaHasta = Date.now() + PAUSA_FALLO;
	} finally {
		enCurso = false;
	}
}

/*
 * De estas IP, las que se sabe que alojan un panel. Las que aún no se saben quedan
 * pedidas y se contestan en una carga siguiente.
 */
export function panelesDe(ips: Iterable<string>): Map<string, PanelAtaque> {
	const r = new Map<string, PanelAtaque>();
	const ahora = Date.now();
	for (const ip of ips) {
		if (!esIpPublica(ip)) continue;
		const local = consolaEn(ip);
		if (local) {
			r.set(ip, local);
			continue;
		}
		const s = sabido.get(ip);
		if (s && s.hasta > ahora) {
			if (s.p) r.set(ip, s.p);
		} else pendientes.add(ip);
	}
	void vaciar();
	return r;
}

/* Para las pruebas: espera a que termine lo que se está preguntando. */
export async function _esperar() {
	while (enCurso) await new Promise((r) => setTimeout(r, 5));
	await vaciar();
}
