import { eq } from 'drizzle-orm';
import {
	EXPLICACION_NIVEL_MADUREZ,
	NOMBRE_NIVEL_MADUREZ,
	estadoMadurez,
	leerMadurez,
	verificarRelease,
	type Confianza,
	type EstadoMadurez,
	type Madurez,
	type ReleaseFirmada
} from '@sugardaddy/canal';
import { versionFirmadaDe } from './canal';
import { confianza } from './claves';
import { cabecera } from './consultas';
import { db, schema as s } from './db';

/*
 * La madurez de las trampas que enseña el catálogo (D11, paquetes/canal/src/madurez.ts): la
 * que viaja firmada en la versión en la que está el nodo. No se deduce aquí: sin una versión
 * firmada de la de ahora, que se pueda comprobar, el catálogo dice que no sabe el estado.
 * Vale igual en Cloud (la versión llega del panel) y en Community (del repo público).
 */
export type VistaMadurez = { version: string; madurez: Madurez };

/*
 * De las versiones firmadas que tiene el nodo, la de `version` que se verifica con sus
 * claves. undefined: ninguna es de esa versión (hay que pedirla); null: lo es pero no trae
 * madurez (una versión de antes de la D11), o la trae con mala forma.
 */
export function madurezDeFirmadas(
	firmadas: (ReleaseFirmada | null | undefined)[],
	clave: Confianza,
	version: string
): VistaMadurez | null | undefined {
	for (const f of firmadas) {
		if (!f?.release || !f.firma) continue;
		const v = verificarRelease(clave, f);
		if (!v.ok || v.release.version !== version) continue;
		const madurez = leerMadurez(v.release.madurez);
		return madurez ? { version, madurez } : null;
	}
	return undefined;
}

/* Lo último que se supo, por versión del nodo. Sin respuesta, se vuelve a pedir a los 10 min. */
let recuerdo: { version: string; vista: VistaMadurez | null; cuando: number } | null = null;
let pidiendo: Promise<void> | null = null;
const REINTENTO_MS = 10 * 60_000;

/* Para las pruebas. */
export const olvidarMadurez = () => {
	recuerdo = null;
	pidiendo = null;
};

async function guardadas(): Promise<(ReleaseFirmada | null | undefined)[]> {
	const filas = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'release'));
	const act = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'actualizacion'));
	const r = filas[0]?.valor as { firmada?: ReleaseFirmada; completa?: ReleaseFirmada } | undefined;
	const a = act[0]?.valor as { release?: ReleaseFirmada | null } | undefined;
	return [r?.firmada, r?.completa, a?.release];
}

/*
 * La madurez de la versión del nodo. Primero lo que el nodo ya tiene guardado y firmado (la
 * versión que le dio el panel, o la que instaló el actualizador); si no, se pide en segundo
 * plano (al panel o al repo público, versionFirmadaDe) y el catálogo no espera: esa vez dice
 * que no sabe, y la siguiente ya lo enseña.
 */
export async function madurezDelNodo(): Promise<VistaMadurez | null> {
	const version = (await cabecera()).cliente.version;
	if (
		recuerdo?.version === version &&
		(recuerdo.vista || Date.now() - recuerdo.cuando < REINTENTO_MS)
	)
		return recuerdo.vista;
	const clave = confianza();
	if (!clave) return null;
	const local = madurezDeFirmadas(await guardadas(), clave, version);
	if (local !== undefined) {
		recuerdo = { version, vista: local, cuando: Date.now() };
		return local;
	}
	pidiendo ??= versionFirmadaDe(version)
		.then((f) => madurezDeFirmadas([f], clave, version) ?? null)
		.catch(() => null)
		.then((vista) => {
			recuerdo = { version, vista, cuando: Date.now() };
		})
		.finally(() => {
			pidiendo = null;
		});
	return null;
}

/* El estado de un módulo del catálogo; null si no se sabe (sin madurez, o es de un partner). */
export function estadoDe(
	vista: VistaMadurez | null,
	h: { id: string; versionModulo: string; dePartner?: boolean }
): EstadoMadurez | null {
	if (!vista || h.dePartner) return null;
	return estadoMadurez(vista.madurez, vista.version, h.id, h.versionModulo);
}

/* Lo que se manda a la página: el estado y sus textos (la página no importa el canal). */
export function vistaDeMadurez(
	vista: VistaMadurez | null,
	h: { id: string; versionModulo: string; dePartner?: boolean }
) {
	const e = estadoDe(vista, h);
	return e
		? {
				...e,
				etiqueta: NOMBRE_NIVEL_MADUREZ[e.nivel],
				explicacion: EXPLICACION_NIVEL_MADUREZ[e.nivel]
			}
		: null;
}
