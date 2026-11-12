/*
 * Una plantilla es un grupo de trampas pensado para un entorno («red interna de
 * Microsoft», «servidores Linux»): una receta, no un tipo de trampa. Al aplicarla
 * se dan de alta trampas normales, una por pieza, por el mismo camino que el alta
 * de una sola (el elector, la licencia, los nombres del dominio), y cada una
 * recuerda de qué plantilla salió (trampas.plantilla).
 *
 * Hay dos orígenes con el mismo formato: las del catálogo, que viajan en
 * modulos/plantillas/<id>/plantilla.yaml igual para todos los clientes, y las
 * propias, que monta cada cliente de Cloud desde el constructor y viven en su
 * base (tabla plantillas, con el id empezando por PREFIJO_PROPIA).
 *
 * Aquí solo está lo puro: el formato y su validación, que valen para las dos.
 */
import { parse } from 'yaml';
import type { Resultado } from './validar.ts';

export type ValorDePieza = string | number | boolean;

export type PiezaPlantilla = {
	/* Único dentro de la plantilla: dos piezas pueden ser del mismo módulo. */
	clave: string;
	modulo: string;
	/* El nombre que se propone para la trampa; el cliente lo puede cambiar al aplicarla. */
	nombre: string;
	/* Ajustes que la plantilla fija por encima de los de serie del módulo. */
	parametros?: Record<string, ValorDePieza>;
	/*
	 * El equipo que aparenta ser junto con otras piezas: al repartir direcciones
	 * (unaPorDireccion), las piezas del mismo equipo van en la misma. Sin él, cada
	 * pieza es su propio equipo.
	 */
	equipo?: string;
};

export type Plantilla = {
	id: string;
	nombre: string;
	descripcion: string;
	/* Para qué entorno está pensada, en una frase. */
	entorno?: string;
	/*
	 * Pensada para una máquina con varias direcciones: al aplicarla, cada equipo se
	 * publica en una dirección distinta de la máquina, para que cada IP enseñe un
	 * equipo y no todas lo mismo. Al aplicarla se puede desmarcar.
	 */
	unaPorDireccion?: boolean;
	piezas: PiezaPlantilla[];
};

export const PREFIJO_PROPIA = 'custom-';
export const esPropia = (id: string) => id.startsWith(PREFIJO_PROPIA);

export const MAX_PIEZAS = 20;
const MAX = { nombre: 60, descripcion: 400, entorno: 200, parametro: 500 } as const;
const ID = /^[a-z0-9][a-z0-9-]{1,47}$/;
const CLAVE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const esObjeto = (x: unknown): x is Record<string, unknown> =>
	typeof x === 'object' && x !== null && !Array.isArray(x);

function texto(x: unknown, campo: string, max: number, errores: string[], opcional = false) {
	if (x === undefined && opcional) return undefined;
	if (typeof x !== 'string' || !x.trim()) {
		errores.push(`${campo}: required`);
		return '';
	}
	const t = x.trim();
	if (Array.from(t).length > max) errores.push(`${campo}: ${max} characters at most`);
	return t;
}

/*
 * Valida lo que dice ser una plantilla (un YAML del catálogo ya leído, o lo que
 * manda el constructor) y la devuelve limpia: solo los campos del formato, sin
 * nada más. Que cada módulo exista y admita esos ajustes lo mira quien conoce el
 * catálogo (server/plantillas.ts): una plantilla puede nombrar un módulo que
 * esta edición no trae, y entonces esa pieza sale marcada, no rota.
 */
export function validarPlantilla(x: unknown): Resultado<Plantilla> {
	const errores: string[] = [];
	if (!esObjeto(x)) return { ok: false, errores: ['Template: not a valid template'] };
	if (typeof x.id !== 'string' || !ID.test(x.id))
		errores.push('Identifier: lowercase letters, numbers and hyphens only');
	const nombre = texto(x.nombre, 'Name', MAX.nombre, errores);
	const descripcion = texto(x.descripcion, 'Description', MAX.descripcion, errores);
	const entorno = texto(x.entorno, 'Environment', MAX.entorno, errores, true);
	const piezas: PiezaPlantilla[] = [];
	if (!Array.isArray(x.piezas) || !x.piezas.length)
		errores.push('Honeypots: add at least one honeypot');
	else if (x.piezas.length > MAX_PIEZAS)
		errores.push(`Honeypots: ${MAX_PIEZAS} per template at most`);
	else {
		const vistas = new Set<string>();
		x.piezas.forEach((p: unknown, i: number) => {
			const donde = `Honeypot ${i + 1}`;
			if (!esObjeto(p)) return void errores.push(`${donde}: not valid`);
			const clave = typeof p.clave === 'string' ? p.clave : '';
			if (!CLAVE.test(clave)) errores.push(`${donde}: its key is not valid`);
			else if (vistas.has(clave)) errores.push(`${donde}: repeated key "${clave}"`);
			vistas.add(clave);
			if (typeof p.modulo !== 'string' || !CLAVE.test(p.modulo))
				errores.push(`${donde}: choose a module`);
			const n = texto(p.nombre, `${donde}, display name`, MAX.nombre, errores);
			const parametros: Record<string, ValorDePieza> = {};
			if (p.parametros !== undefined) {
				if (!esObjeto(p.parametros)) errores.push(`${donde}: its settings are not valid`);
				else
					for (const [k, v] of Object.entries(p.parametros)) {
						const vale =
							typeof v === 'number' ||
							typeof v === 'boolean' ||
							(typeof v === 'string' && v.length <= MAX.parametro);
						if (!vale || !/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(k))
							errores.push(`${donde}: setting "${k}" is not valid`);
						else parametros[k] = v as ValorDePieza;
					}
			}
			let equipo: string | undefined;
			if (p.equipo !== undefined) {
				if (typeof p.equipo !== 'string' || !CLAVE.test(p.equipo))
					errores.push(`${donde}: its machine is not valid`);
				else equipo = p.equipo;
			}
			piezas.push({
				clave,
				modulo: String(p.modulo ?? ''),
				nombre: n ?? '',
				...(Object.keys(parametros).length ? { parametros } : {}),
				...(equipo ? { equipo } : {})
			});
		});
	}
	if (errores.length) return { ok: false, errores };
	return {
		ok: true,
		valor: {
			id: x.id as string,
			nombre: nombre!,
			descripcion: descripcion!,
			...(entorno ? { entorno } : {}),
			...(x.unaPorDireccion === true ? { unaPorDireccion: true } : {}),
			piezas
		}
	};
}

/* Una plantilla del catálogo: su plantilla.yaml, con la versión del formato. */
export function leerPlantilla(yaml: string): Resultado<Plantilla> {
	let x: unknown;
	try {
		x = parse(yaml);
	} catch (e) {
		return { ok: false, errores: [`not valid YAML: ${(e as Error).message}`] };
	}
	if (!esObjeto(x) || x.version !== 1)
		return { ok: false, errores: ['version: only version 1 is supported'] };
	return validarPlantilla(x);
}

/*
 * Un nombre que no choque con los que ya hay. Un nombre de equipo (sin
 * espacios) sigue siendo un nombre de equipo: «db01» pasa a «db02», con las
 * mismas cifras, e «intranet» a «intranet-2»; aplicar dos veces la misma
 * plantilla no obliga a reescribir sus nombres. Un título con espacios se
 * numera aparte: «File server», «File server 2»…
 * `ocupado` dice si ese nombre ya daría un identificador en uso.
 */
export function nombreLibre(nombre: string, ocupado: (nombre: string) => boolean): string {
	if (!ocupado(nombre)) return nombre;
	const numerado = /^(\S*?)(\d+)$/.exec(nombre);
	const candidato = numerado
		? (n: number) =>
				`${numerado[1]}${String(Number(numerado[2]) + n - 1).padStart(numerado[2].length, '0')}`
		: /\s/.test(nombre)
			? (n: number) => `${nombre} ${n}`
			: (n: number) => `${nombre}-${n}`;
	for (let n = 2; n < 1000; n++) if (!ocupado(candidato(n))) return candidato(n);
	return nombre;
}

/* La clave de una pieza nueva del constructor: el módulo, con número si se repite. */
export function claveLibre(modulo: string, usadas: Iterable<string>): string {
	const u = new Set(usadas);
	if (!u.has(modulo)) return modulo;
	for (let n = 2; n < 1000; n++) if (!u.has(`${modulo}-${n}`)) return `${modulo}-${n}`;
	return modulo;
}
