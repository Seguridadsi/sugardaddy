/*
 * El dominio del cliente, que se pide al entrar por primera vez en la consola y con el
 * que las trampas toman nombres de su red (lib/camuflaje.ts). Queda en `ajustes`.
 *
 * decidido: ya ha contestado, aunque sea «ahora no»; no se le vuelve a preguntar, y lo
 * puede poner cuando quiera en Ajustes. semilla: al azar de esta instalación, para que
 * los nombres no se puedan calcular sabiendo solo el dominio. aplicados: lo que el nodo
 * ha puesto en cada trampa, para poder cambiarlo si se corrige el dominio.
 *
 * Las trampas de cara a internet no toman el dominio: un RDP en una IP pública que
 * anuncia el nombre de la empresa la señala ante quien rastrea internet.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Honeycosa } from '@sugardaddy/contrato';
import { cambiosDeFabrica, propuestas, tituloDe } from '$lib/camuflaje';
import { modificarConElector } from './alta';
import { honeycosas } from './catalogo';
import { db, schema as s } from './db';

export type Identidad = {
	decidido: boolean;
	dominio: string | null;
	semilla?: string;
	aplicados?: Record<string, Record<string, string>>;
};

const CLAVE = 'identidad';

export async function identidad(): Promise<Identidad> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, CLAVE));
	return (f?.valor as Identidad | undefined) ?? { decidido: false, dominio: null };
}

async function escribir(valor: Identidad) {
	await db
		.insert(s.ajustes)
		.values({ clave: CLAVE, valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
}

export async function guardarIdentidad(
	quien: string,
	v: { decidido: boolean; dominio: string | null }
): Promise<void> {
	const antes = await identidad();
	await escribir({ ...antes, ...v, semilla: antes.semilla ?? randomBytes(16).toString('hex') });
	await db.insert(s.auditoria).values({
		quien,
		accion: v.dominio ? 'dominio de la empresa guardado' : 'dominio de la empresa sin indicar',
		detalle: { dominio: v.dominio }
	});
}

/* Todos los textos de los parámetros: para no repetir un nombre que ya usa otra trampa. */
const nombresDe = (filas: { parametros: Record<string, unknown> }[]) =>
	filas.flatMap((f) =>
		Object.values(f.parametros).filter((v): v is string => typeof v === 'string')
	);

/*
 * Lo que se propone para una trampa nueva de ese módulo en ese destino. Vacío si no hay
 * dominio, o si el sensor de ese destino está de cara a internet.
 */
export async function propuestasDeAlta(
	h: Honeycosa,
	destino: string
): Promise<Record<string, string>> {
	const { dominio, semilla } = await identidad();
	if (!dominio) return {};
	const [d] = await db
		.select({ entorno: s.sensores.entorno })
		.from(s.destinos)
		.leftJoin(s.sensores, eq(s.sensores.id, s.destinos.sensor))
		.where(eq(s.destinos.id, destino));
	if (d?.entorno === 'perimetro-web') return {};
	const filas = await db.select({ parametros: s.trampas.parametros }).from(s.trampas);
	return propuestas(h.parametros, dominio, { semilla, usados: nombresDe(filas) });
}

type Aplicable = {
	fila: typeof s.trampas.$inferSelect;
	honeycosa: Honeycosa;
	cambios: Record<string, string>;
};

/*
 * Las trampas ya puestas a las que les toca un nombre del dominio. Solo las de contenedor
 * activas: lo sembrado a mano ya está en la máquina del cliente con el nombre que tenía.
 */
async function aplicables(i: Identidad): Promise<Aplicable[]> {
	if (!i.dominio) return [];
	const filas = await db.select().from(s.trampas);
	const sensores = await db
		.select({ id: s.sensores.id, entorno: s.sensores.entorno })
		.from(s.sensores);
	const entornoSensor = new Map(sensores.map((x) => [x.id, x.entorno]));
	const catalogo = new Map(honeycosas().map((h) => [h.id, h]));
	const asignados = new Set<string>();
	const r: Aplicable[] = [];
	for (const fila of filas) {
		const honeycosa = catalogo.get(fila.modulo);
		if (!honeycosa || fila.ejecutor !== 'contenedor@1' || !fila.activo) continue;
		if ((fila.entorno ?? entornoSensor.get(fila.sensor)) === 'perimetro-web') continue;
		/* Sus propios nombres no cuentan como usados: si no, repetir le daría otro número. */
		const usados = [...nombresDe(filas.filter((f) => f.id !== fila.id)), ...asignados];
		const cambios = cambiosDeFabrica(
			honeycosa.parametros,
			fila.parametros,
			propuestas(honeycosa.parametros, i.dominio, { semilla: i.semilla, usados }),
			i.aplicados?.[fila.id]
		);
		for (const v of Object.values(cambios)) asignados.add(v);
		if (Object.keys(cambios).length) r.push({ fila, honeycosa, cambios });
	}
	return r;
}

export type CambioDeTrampa = {
	nombre: string;
	cambios: { campo: string; antes: string; despues: string }[];
};

/* A qué trampas afectaría, y cómo: se enseña antes de aplicarlo. */
export async function trampasDeFabrica(): Promise<CambioDeTrampa[]> {
	return (await aplicables(await identidad())).map(({ fila, honeycosa, cambios }) => ({
		nombre: fila.nombre,
		cambios: Object.entries(cambios).map(([k, despues]) => {
			const actual = fila.parametros[k];
			const fabrica = (honeycosa.parametros.properties[k] as { default?: unknown }).default;
			return {
				campo: tituloDe(honeycosa.parametros, k),
				antes: String(actual ?? fabrica ?? ''),
				despues
			};
		})
	}));
}

/*
 * Les pone los nombres del dominio, por el mismo camino que modificar una trampa a mano.
 * Una que no se pueda cambiar (lo sembrado apunta a ella, un puerto ocupado) se queda
 * como está, y se dice por qué.
 */
export async function aplicarIdentidad(quien: string): Promise<{
	cambiadas: string[];
	sinCambiar: { nombre: string; motivo: string }[];
}> {
	const cambiadas: string[] = [];
	const sinCambiar: { nombre: string; motivo: string }[] = [];
	const i = await identidad();
	const aplicados = { ...i.aplicados };
	for (const { fila, honeycosa, cambios } of await aplicables(i)) {
		/* Lo de ahora, no lo de cuando empezó la vuelta: se pudo tocar mientras tanto. */
		const [ahora] = await db.select().from(s.trampas).where(eq(s.trampas.id, fila.id));
		if (!ahora) continue;
		const r = await modificarConElector(quien, ahora, honeycosa, {
			nombre: ahora.nombre,
			parametros: { ...ahora.parametros, ...cambios }
		});
		if (r === 'modificada') {
			cambiadas.push(ahora.nombre);
			aplicados[fila.id] = { ...aplicados[fila.id], ...cambios };
		} else
			sinCambiar.push({
				nombre: ahora.nombre,
				motivo: r.errores[0] ?? r.motivos[0]?.texto ?? 'no se puede modificar'
			});
	}
	await escribir({ ...(await identidad()), aplicados });
	return { cambiadas, sinCambiar };
}
