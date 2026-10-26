import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { join } from 'node:path';
import { leerHoneycosa, leerRespuesta, traductorDe, validarCatalogo } from '@sugardaddy/contrato';
import type {
	CargaManual,
	Honeycosa,
	IdEjecutor,
	ManifiestoRespuesta,
	ManifiestoTrampa,
	Resultado,
	Traductor,
	Via
} from '@sugardaddy/contrato';
import { db, schema } from './db';

/*
 * El catálogo son los manifiestos de modulos/, validados contra el contrato.
 * Un manifiesto que no lo cumple no aparece: mejor un hueco que un módulo roto.
 * Cuando el nodo reciba el catálogo firmado del panel central, esto leerá de ahí.
 * La carpeta se mira en cada lectura, no al cargar el módulo, para que una
 * prueba pueda apuntar SUGARDADDY_MODULOS a un catálogo suyo.
 */
const raiz = () => process.env.SUGARDADDY_MODULOS ?? join(process.cwd(), '../../modulos');

function cargar<T>(familia: string, fichero: string, leer: (yaml: string) => Resultado<T>) {
	return readdirSync(join(raiz(), familia)).flatMap((id) => {
		let r: Resultado<T>;
		try {
			r = leer(readFileSync(join(raiz(), familia, id, fichero), 'utf8'));
		} catch (e) {
			r = { ok: false, errores: [`no se puede leer: ${(e as Error).message}`] };
		}
		if (!r.ok) console.warn(`módulo ${familia}/${id} descartado`, r);
		return r.ok ? [r.valor] : [];
	});
}

/*
 * Las trampas del catálogo como honeycosas (docs/diseno/modulo-despliegue.md
 * §2.6), escritas en v1 o en v2: cada una validada contra el contrato y,
 * todas juntas, contra el resto del catálogo (validarCatalogo): la que apunta
 * a un módulo que no está, o a un parámetro que ese no tiene, no entra, igual
 * que una inválida.
 */
export function honeycosas(): Honeycosa[] {
	/*
	 * Las familias nuevas son optativas en un catálogo de prueba: sin la
	 * carpeta no hay nada de esa familia. ficheros son los documentos cebo
	 * (H22); nube, las de la tanda de conectores (H28–H31, §7.1 de la ronda).
	 */
	const trampas = cargar<Honeycosa>('trampas', 'trampa.yaml', leerHoneycosa);
	const de = (familia: string) =>
		existsSync(join(raiz(), familia))
			? cargar<Honeycosa>(familia, 'trampa.yaml', leerHoneycosa)
			: [];
	const ficheros = de('ficheros');
	const nube = de('nube');
	const familiaDe = new Map(
		[
			...trampas.map((h) => ['trampas', h] as const),
			...ficheros.map((h) => ['ficheros', h] as const),
			...nube.map((h) => ['nube', h] as const)
		].map(([familia, h]) => [h.id, familia])
	);
	const { validas, errores } = validarCatalogo([...trampas, ...ficheros, ...nube]);
	for (const [id, e] of Object.entries(errores))
		console.warn(`módulo ${familiaDe.get(id) ?? 'trampas'}/${id} descartado`, {
			ok: false,
			errores: e
		});
	return validas;
}

/*
 * Los bytes de la plantilla de una honeycosa de fichero (su siembra.plantilla,
 * dentro del módulo, p. ej. ficheros/fichero-word/plantilla/documento.docx):
 * lo que acuña la consola con la URL de baliza. null si la honeycosa no es de
 * fichero o no se puede leer la plantilla.
 */
export function plantillaDeFichero(h: Honeycosa): Uint8Array | null {
	const siembra = h.siembra as { clase?: string; plantilla?: string };
	if (siembra.clase !== 'fichero' || typeof siembra.plantilla !== 'string') return null;
	try {
		return new Uint8Array(readFileSync(join(raiz(), 'ficheros', h.id, siembra.plantilla)));
	} catch {
		return null;
	}
}

/* El nombre de cada módulo por id: los motivos del elector lo dicen así, no por su id (§7.4). */
export const nombresModulos = (catalogo: Iterable<Honeycosa>): Record<string, string> =>
	Object.fromEntries([...catalogo].map((h) => [h.id, h.nombre]));

/* Los ejecutores que conoce esta consola (§6.1): las vías que pone desde el alta. */
export const EJECUTORES_CONSOLA: IdEjecutor[] = ['contenedor@1', 'manual@1'];

/*
 * Se puede poner desde esta consola: tiene alguna vía que ella sabe poner
 * (en un sensor o con pasos a mano). Dónde vale, lo dice el elector en el alta.
 */
export const desplegable = (h: Honeycosa) =>
	h.vias.some((v) => EJECUTORES_CONSOLA.includes(v.ejecutor));

/*
 * La primera vía contenedor@1 de un módulo, la que elegiría el elector en un
 * sensor: la ficha del catálogo enseña lo que ejecuta.
 */
export const viaContenedor = (h: Honeycosa): Via | undefined =>
	h.vias.find((v) => v.ejecutor === 'contenedor@1');

/*
 * El traductor de los eventos de una trampa de ese módulo: el de su vía
 * (traductorDe) o, si no se sabe la vía (una trampa ya retirada) o no tiene
 * (la fuente es otra trampa), el de la raíz o el de la primera vía que lo
 * tenga. Para un v1 es su «eventos» sin la fuente, como siempre.
 */
export function traductorDeTrampa(h: Honeycosa, via?: string): Traductor | undefined {
	return (
		(via === undefined ? undefined : traductorDe(h, via)) ??
		h.senal.eventos ??
		h.vias.map((v) => traductorDe(h, v.id)).find((t) => t !== undefined)
	);
}

/*
 * El texto de un paso para la ficha y el alta, antes de que haya parámetros
 * ni destino: cada hueco ${…} dice qué irá ahí con las palabras que ve el
 * cliente (el título del parámetro, «la dirección del destino») y no con su
 * nombre interno.
 */
export function textoDeFicha(texto: string, h: Honeycosa): string {
	const props = h.parametros.properties as Record<string, { title?: unknown }>;
	const nombre = (p: string) =>
		`«${Object.hasOwn(props, p) && typeof props[p].title === 'string' ? props[p].title : p}»`;
	return texto
		.replace(/\$\{([^}]*)\}/g, (hueco, x: string) => {
			if (Object.hasOwn(props, x)) return nombre(x);
			const [de, campo, ...mas] = x.split('.');
			if (mas.length) return hueco;
			if (de === 'destino')
				return campo === 'direccion' ? 'la dirección del destino' : 'el destino';
			if (de === 'trampa') return 'esta trampa';
			if (campo !== undefined && Object.hasOwn(props, de))
				return campo === 'direccion'
					? `la dirección de ${nombre(de)}`
					: `«${campo}» de ${nombre(de)}`;
			return hueco;
		})
		.replaceAll('««', '«')
		.replaceAll('»»', '»');
}

/*
 * La ficha con «instalacion», que en v2 es opcional (§2.2): si el módulo no
 * la trae, se deduce de sus vías. Automática si tiene una vía contenedor@1
 * (se pone desde esta consola) y, si tiene alguna manual@1, con los textos de
 * los pasos de la primera (como mucho 20, de 500 caracteres, como en la
 * proyección para v1), con los huecos dichos para el cliente.
 */
export function fichaDe(h: Honeycosa): ManifiestoTrampa['ficha'] {
	if (!h.ficha) return undefined;
	const { instalacion, ...resto } = h.ficha;
	if (instalacion) return { ...resto, instalacion };
	const manual = h.vias.find((v) => v.ejecutor === 'manual@1');
	const pasos = manual
		? (manual.carga as CargaManual).pasos
				.slice(0, 20)
				.map((p) => Array.from(textoDeFicha(p.texto, h)).slice(0, 500).join(''))
		: [];
	return {
		...resto,
		instalacion: { automatica: !!viaContenedor(h), ...(pasos.length ? { manual: pasos } : {}) }
	};
}

export const catalogoRespuestas = () =>
	cargar<ManifiestoRespuesta>('respuestas', 'respuesta.yaml', leerRespuesta);

/*
 * Las trampas GRATIS (y, con ellas, qué es de pago) viven en modulos-gratis.ts,
 * un fichero sin dependencias que es la ÚNICA fuente de verdad: así la leen tanto
 * la consola como herramientas/es-de-pago.ts (que usa publicar-trampa.sh para no
 * publicar una trampa de pago sin candado). Se reexporta para no cambiar a quien
 * ya lo importa desde aquí (p. ej. sensor.ts).
 */
export { MODULOS_GRATIS, esDePago } from './modulos-gratis';

/*
 * Módulos que este cliente tiene autorizados. Llegan firmados del panel en
 * cada latido; sin panel, o antes del primer latido, ninguno.
 */
export const MODULOS_DE_SERIE: string[] = [];

export async function autorizados(): Promise<string[]> {
	const [f] = await db.select().from(schema.ajustes).where(eq(schema.ajustes.clave, 'modulos'));
	return (f?.valor as string[] | undefined) ?? MODULOS_DE_SERIE;
}

/*
 * El catálogo entero, para enseñarlo: cada trampa con su ficha y si entra en
 * la suscripción del cliente. Desplegar solo se puede con las que entran.
 */
export async function catalogoConSuscripcion() {
	const permitidos = new Set(await autorizados());
	return honeycosas().map((h) => ({ ...h, incluida: permitidos.has(h.id) }));
}

export async function trampasAutorizadas() {
	const permitidos = new Set(await autorizados());
	return honeycosas().filter((h) => permitidos.has(h.id));
}
