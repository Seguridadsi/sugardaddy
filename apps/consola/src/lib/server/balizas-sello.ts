/*
 * Las señales selladas del relé, en el nodo (docs/diseno/rele-balizas.md, «Señales
 * selladas: que SeguridadSI no pueda leerlas»).
 *
 * - El nodo tiene una clave X25519 de balizas. La privada no sale de él: se guarda en el
 *   ajuste «claves-sello», cifrada con CLAVE_SECRETOS como los demás secretos.
 * - Cuando el panel dice que su relé sella (releSellado en el estado firmado, que el
 *   nodo guarda en el ajuste «rele-sellado»), los tokens nuevos de las balizas que
 *   pueden volver por el relé llevan la clave pública: «k» + base64url(pública ‖ azar).
 * - El relé sella cada señal de esos tokens hacia esa clave, el panel la encamina por la
 *   ruta sin poder abrirla, y aquí se abre (abrirSeñal) antes de tratarla como siempre.
 *
 * Rotar la clave es acuñar con otra: «claves-sello» guarda las privadas viejas mientras
 * quede alguna baliza con un token suyo (un cebo repartido no se puede cambiar). Hoy no
 * hay nada que rote; la forma ya lo admite.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
	abrirRele,
	claveDeTokenRele,
	esSellada,
	esTokenSellado,
	nuevaClaveSello,
	rutaRele,
	tokenSellado
} from '@sugardaddy/canal';
import { db, schema as s } from './db';
import { cifrar, descifrar, estadoClave } from './secretos';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Bd = Tx | typeof db;

const AJUSTE_CLAVES = 'claves-sello';
const AJUSTE_SELLADO = 'rele-sellado';
/* El dueño del sobre (secretos.ts): no sirve copiarlo a otro sitio. */
const contexto = (publica: string) => `sello-rele:${publica}`;

/* Una clave guardada: la pública en base64url y la privada en su sobre. */
type ClaveGuardada = { publica: string; privada: string; creada: string };
type Claves = { actual: ClaveGuardada; viejas: ClaveGuardada[] };

async function leerClaves(bd: Bd): Promise<Claves | null> {
	const [f] = await bd.select().from(s.ajustes).where(eq(s.ajustes.clave, AJUSTE_CLAVES));
	const v = f?.valor as Claves | undefined;
	return v?.actual?.publica && v.actual.privada
		? { actual: v.actual, viejas: v.viejas ?? [] }
		: null;
}

/* Si el relé que reparte el panel sella (lo último que dijo el estado firmado). */
export async function releSella(bd: Bd = db): Promise<boolean> {
	const [f] = await bd.select().from(s.ajustes).where(eq(s.ajustes.clave, AJUSTE_SELLADO));
	return f?.valor === true;
}

/*
 * Lo que dice el estado firmado. Ausente (panel anterior, o sin el ajuste) no toca nada;
 * true o false se guarda. Dejar de sellar no estropea nada: los tokens ya sellados se
 * siguen encaminando, en claro o sellados, y se siguen abriendo.
 */
export async function guardarReleSellado(valor: boolean | undefined): Promise<void> {
	if (typeof valor !== 'boolean') return;
	if ((await releSella()) === valor) return;
	await db
		.insert(s.ajustes)
		.values({ clave: AJUSTE_SELLADO, valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
}

/*
 * La clave pública de balizas del nodo, creándola la primera vez. null si el nodo no
 * puede guardar la privada (sin CLAVE_SECRETOS, o con una mal formada): entonces se
 * acuña un token de los de antes, que sigue funcionando, sin sello.
 */
async function clavePublica(bd: Bd): Promise<Buffer | null> {
	if (estadoClave() !== 'lista') return null;
	const ya = await leerClaves(bd);
	if (ya) return Buffer.from(ya.actual.publica, 'base64url');
	const { publica, privada } = nuevaClaveSello();
	const pub = publica.toString('base64url');
	const actual: ClaveGuardada = {
		publica: pub,
		privada: cifrar({ privada: privada.toString('base64url') }, contexto(pub)),
		creada: new Date().toISOString()
	};
	/* Dos altas a la vez: gana la primera, y la segunda usa la suya. */
	await bd
		.insert(s.ajustes)
		.values({ clave: AJUSTE_CLAVES, valor: { actual, viejas: [] } })
		.onConflictDoNothing();
	const guardadas = await leerClaves(bd);
	return guardadas ? Buffer.from(guardadas.actual.publica, 'base64url') : null;
}

/* Un token de los de antes: 18 bytes al azar en base64url (24 caracteres). */
const tokenDeAntes = () => randomBytes(18).toString('base64url');

/*
 * El token de una baliza nueva. Sellado si el relé del panel sella y la baliza puede
 * volver por el relé (no una vigía, que nace dentro de la red y solo habla con el
 * receptor); si no, uno de los de antes.
 */
export async function tokenNuevo(bd: Bd, porElRele: boolean): Promise<string> {
	if (!porElRele || !(await releSella(bd))) return tokenDeAntes();
	const publica = await clavePublica(bd);
	return publica ? tokenSellado(publica) : tokenDeAntes();
}

/*
 * Lo que el nodo publica en /api/nodo/balizas: los tokens de antes tal cual y, de los
 * sellados, solo la ruta. El panel encamina las señales por ella sin conocer el token.
 */
export function clavesParaElPanel(tokens: readonly string[]): {
	tokens: string[];
	rutas: string[];
} {
	const deAntes: string[] = [];
	const rutas: string[] = [];
	for (const t of tokens) (esTokenSellado(t) ? rutas : deAntes).push(t);
	return { tokens: deAntes, rutas: rutas.map(rutaRele).sort() };
}

/* Las privadas del nodo en bruto, por clave pública: la actual y las viejas. */
export async function privadasDelNodo(bd: Bd = db): Promise<Map<string, Buffer>> {
	const claves = await leerClaves(bd);
	const mapa = new Map<string, Buffer>();
	if (!claves) return mapa;
	for (const c of [claves.actual, ...claves.viejas]) {
		const d = descifrar(c.privada, contexto(c.publica));
		if (d.ok && d.valores.privada) mapa.set(c.publica, Buffer.from(d.valores.privada, 'base64url'));
	}
	return mapa;
}

/*
 * Lo que trae el panel de una señal: la carga de siempre (en claro) o un sello. Un sello
 * se abre con la privada de la clave que dice su token; lo que no se abre (otra clave,
 * tocado, otra ruta) o no cuadra con su ruta queda en «motivo» y se descarta.
 */
export type CargaAbierta =
	{ ok: true; carga: Record<string, unknown>; sellada: boolean } | { ok: false; motivo: string };

export function abrirSeñal(
	carga: Record<string, unknown>,
	privadas: ReadonlyMap<string, Buffer>
): CargaAbierta {
	if (!esSellada(carga)) return { ok: true, carga, sellada: false };
	if (!privadas.size)
		return { ok: false, motivo: 'sealed signal, but this node has no beacon key' };
	/* No se sabe de qué clave es hasta abrirlo: la ruta es un resumen del token. Se prueban
	 * las del nodo (una, salvo tras rotar). */
	for (const privada of privadas.values()) {
		const claro = abrirRele(carga, privada);
		if (!claro) continue;
		let obj: unknown;
		try {
			obj = JSON.parse(claro.toString('utf8'));
		} catch {
			return { ok: false, motivo: 'sealed signal that is not JSON' };
		}
		if (!obj || typeof obj !== 'object' || Array.isArray(obj))
			return { ok: false, motivo: 'sealed signal that is not an object' };
		const token = (obj as Record<string, unknown>).token;
		/* La ruta va de dato asociado, pero el token de dentro también tiene que ser el de esa
		 * ruta y llevar esta clave: un sello hecho por otro hacia la pública del nodo, con otro
		 * token dentro, no se cree. */
		if (
			typeof token !== 'string' ||
			rutaRele(token) !== carga.r ||
			!claveDeTokenRele(token)?.equals(Buffer.from(publicaDe(privadas, privada), 'base64url'))
		)
			return { ok: false, motivo: 'sealed signal whose token does not match its route' };
		return { ok: true, carga: obj as Record<string, unknown>, sellada: true };
	}
	return { ok: false, motivo: 'sealed signal that this node cannot open' };
}

function publicaDe(privadas: ReadonlyMap<string, Buffer>, privada: Buffer): string {
	for (const [pub, priv] of privadas) if (priv === privada) return pub;
	return '';
}

/* Si un token de una baliza es de los de antes, que el panel puede leer. */
export const tokenSinSello = (token: string): boolean => !esTokenSellado(token);
