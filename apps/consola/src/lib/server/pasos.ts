/*
 * Los pasos de una trampa a mano (manual@1, docs/diseno/modulo-despliegue.md
 * §6.3): lo que enseña su ficha y su descarga. Se enseña y se descarga
 * siempre lo que se guardó al generarlos (trampas.manual), aunque el módulo
 * haya cambiado después: así se retira exactamente lo que se puso.
 */
import { eq, inArray } from 'drizzle-orm';
import {
	bloqueDeVariables,
	exportar,
	formatosDe,
	renderizar,
	sha256Pasos,
	validarParametros
} from '@sugardaddy/contrato';
import type {
	Colocacion,
	ContextoManual,
	Destino,
	FormatoPasos,
	Honeycosa,
	Marca,
	PartePasos,
	PasosGenerados,
	Resultado,
	TrampaDelCliente,
	Via
} from '@sugardaddy/contrato';
import { honeycosas } from './catalogo';
import { db, schema as s } from './db';
import type { Bd } from './destinos';
import { hechosDe } from './hechos';
import { nonceAbierto } from './pruebas';

/*
 * Lo que dice trampas.donde de una trampa a mano: no la pone ningún sensor,
 * así que no escucha en ningún sitio. La consola enseña su destino; esto solo
 * lo ve una consola anterior, tras una vuelta atrás, hasta que su plan la
 * deja «en espera» (no conoce el módulo).
 */
export const DONDE_MANUAL = 'pasos a mano';

/* Los parámetros de una honeycosa que apuntan a otra trampa del cliente (x-trampa, §2.5). */
export function parametrosConTrampa(h: Honeycosa): { parametro: string; modulos: string[] }[] {
	return Object.entries(h.parametros.properties).flatMap(([parametro, def]) => {
		const x = (def as { 'x-trampa'?: { modulos?: unknown } } | undefined)?.['x-trampa'];
		if (!x) return [];
		const modulos = Array.isArray(x.modulos)
			? x.modulos.filter((m): m is string => typeof m === 'string')
			: [];
		return [{ parametro, modulos }];
	});
}

/* Las trampas a las que apuntan unos parámetros (los valores de sus x-trampa), sin repetir. */
export function objetivosDe(h: Honeycosa, parametros: Record<string, unknown>): string[] {
	const ids = parametrosConTrampa(h).map(({ parametro }) => parametros[parametro]);
	return [...new Set(ids.filter((v): v is string => typeof v === 'string' && v !== ''))];
}

/* Las colocaciones en que una trampa recibe y puede ser la señal de otra (§2.4), como el elector. */
const RECIBEN: readonly Colocacion[] = ['colocada', 'comprobada', 'degradada'];

export type OpcionObjetivo = { id: string; nombre: string; destino: string; motivo: string | null };

/*
 * El desplegable de cada parámetro x-trampa (§2.5): las trampas del cliente
 * de esos módulos, primero las que valen. Las que no (no están puestas, se
 * están retirando o su destino no tiene dirección) salen con su motivo, sin
 * poder elegirlas. El servidor lo vuelve a mirar al guardar (el elector).
 */
export function opcionesDeObjetivo(
	h: Honeycosa,
	trampas: Record<string, TrampaDelCliente>
): Record<string, OpcionObjetivo[]> {
	const motivoDe = (t: TrampaDelCliente) => {
		if (t.colocacion === 'retirando') return 'se está retirando';
		if (!RECIBEN.includes(t.colocacion)) return 'aún no está puesta';
		if (!t.direccion) return `${t.destinoNombre || 'su destino'} no tiene dirección`;
		return null;
	};
	return Object.fromEntries(
		parametrosConTrampa(h).map(({ parametro, modulos }) => [
			parametro,
			Object.entries(trampas)
				.filter(([, t]) => modulos.includes(t.modulo))
				.map(([id, t]) => ({ id, nombre: t.nombre, destino: t.destinoNombre, motivo: motivoDe(t) }))
				.sort(
					(a, b) =>
						Number(a.motivo !== null) - Number(b.motivo !== null) ||
						a.nombre.localeCompare(b.nombre, 'es')
				)
		])
	);
}

/*
 * Para los pasos, las trampas a las que apuntan (ContextoManual.trampas): la
 * dirección de su destino y sus parámetros con los valores por defecto de su
 * módulo, que es lo que valida y guarda renderizar.
 */
async function trampasParaPasos(bd: Bd, ids: string[]): Promise<ContextoManual['trampas']> {
	if (!ids.length) return {};
	const catalogo = new Map(honeycosas().map((h) => [h.id, h]));
	const filas = await bd
		.select({
			id: s.trampas.id,
			modulo: s.trampas.modulo,
			parametros: s.trampas.parametros,
			destino: s.destinos,
			sensor: s.sensores
		})
		.from(s.trampas)
		.leftJoin(s.destinos, eq(s.destinos.id, s.trampas.destino))
		.leftJoin(s.sensores, eq(s.sensores.id, s.destinos.sensor))
		.where(inArray(s.trampas.id, ids));
	return Object.fromEntries(
		filas.map((f) => {
			const h = catalogo.get(f.modulo);
			const p = h && validarParametros(h.parametros, f.parametros);
			const direccion = f.destino
				? hechosDe(f.destino, f.sensor)['destino.direccion']?.valor
				: null;
			return [
				f.id,
				{
					...(typeof direccion === 'string' ? { direccion } : {}),
					parametros: p && p.ok ? p.valor : f.parametros
				}
			];
		})
	);
}

/*
 * Los pasos de una vía manual@1 para una trampa en un destino (renderizar,
 * §6.3), con los datos de hoy del destino (su nombre y su dirección) y de las
 * trampas a las que apunta. Se guardan tal cual en trampas.manual: los de
 * poner y también los de quitar, para retirar luego exactamente lo que se
 * puso aunque el módulo cambie.
 */
export async function generarPasos(
	bd: Bd,
	h: Honeycosa,
	via: Via,
	trampa: { id: string; nombre: string },
	d: Destino,
	parametros: Record<string, unknown>
): Promise<Resultado<PasosGenerados>> {
	const direccion = d.hechos['destino.direccion']?.valor;
	return renderizar(h, via.id, parametros, {
		trampa,
		destino: {
			id: d.id,
			nombre: d.nombre,
			...(typeof direccion === 'string' ? { direccion } : {})
		},
		trampas: await trampasParaPasos(bd, objetivosDe(h, parametros)),
		generado: new Date().toISOString()
	});
}

/* Las partes que se descargan desde la ficha: la de probar, con el código de su prueba abierta. */
export const PARTES: readonly PartePasos[] = ['colocar', 'retirar', 'probar'];
export const FORMATOS: readonly FormatoPasos[] = ['ps1', 'sh', 'md', 'txt'];

/* Cómo se llama cada campo de una marca para el cliente. */
function campoDeMarca(campo: Marca['campo']): string {
	if (campo === 'origen.usuario') return 'el usuario';
	if (campo === 'origen.ip') return 'la IP de origen';
	if (campo === 'origen.equipo') return 'el equipo';
	return `«${campo.slice('detalle.'.length)}»`;
}

/* La marca con que se le atribuyen los eventos de su objetivo, en una frase (§8.5). */
export function textoMarca(m: Marca): string {
	return 'igual' in m
		? `${campoDeMarca(m.campo)} «${m.igual}»`
		: `${campoDeMarca(m.campo)} con «${m.contiene}»`;
}

/*
 * Lo que enseña la ficha de unos pasos guardados: el bloque de variables
 * (para copiarlo primero), los pasos de colocar y de retirar, en qué se
 * pueden descargar y si siguen siendo los que se generaron (su sha256). Unos
 * pasos que no cuadran se enseñan, pero no se descargan.
 */
export function fichaDePasos(p: PasosGenerados) {
	return {
		lenguaje: p.lenguaje,
		via: p.nombres.via,
		modulo: p.nombres.modulo,
		versionModulo: p.versionModulo,
		destino: p.nombres.destino,
		generado: p.generado,
		sha256: p.sha256,
		integros: sha256Pasos(p) === p.sha256,
		bloque: bloqueDeVariables(p),
		/* Con lenguaje «ninguno» no hay bloque: las variables se dicen una a una. */
		variables: Object.entries(p.variables).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		pasos: p.pasos,
		retirada: p.retirada,
		formatos: formatosDe(p),
		marca: p.marca ? textoMarca(p.marca) : null
	};
}
export type FichaDePasos = ReturnType<typeof fichaDePasos>;

/*
 * Un fichero de los pasos de una trampa (exportar, §6.3): el script de una
 * parte en su lenguaje o el documento para la gestión de cambios. La parte de
 * probar lleva el código (nonce) de su prueba abierta (§8.3): sin prueba
 * abierta no hay script de prueba. Cada descarga deja su línea en la
 * auditoría con la huella de lo descargado.
 */
export async function descargarPasos(
	quien: string,
	id: string,
	formato: FormatoPasos,
	parte: PartePasos
): Promise<
	| { nombre: string; tipo: string; contenido: Uint8Array }
	| 'no-existe'
	| 'sin-pasos'
	| 'sin-prueba'
	| 'otro-lenguaje'
	| 'no-cuadran'
> {
	const [t] = await db
		.select({ manual: s.trampas.manual })
		.from(s.trampas)
		.where(eq(s.trampas.id, id));
	if (!t) return 'no-existe';
	const p = t.manual;
	if (!p) return 'sin-pasos';
	const nonce = parte === 'probar' && p.prueba ? await nonceAbierto(id) : null;
	if (parte === 'probar' && !nonce) return 'sin-prueba';
	if (!formatosDe(p).includes(formato)) return 'otro-lenguaje';
	if (sha256Pasos(p) !== p.sha256) return 'no-cuadran';
	const f = exportar(p, formato, { parte, ...(nonce ? { nonce } : {}) });
	await db.insert(s.auditoria).values({
		quien,
		accion: 'pasos descargados',
		detalle: { id, formato, parte, pasos: p.sha256 }
	});
	return f;
}
