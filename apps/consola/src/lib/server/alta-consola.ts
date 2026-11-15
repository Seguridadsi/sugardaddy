/*
 * El alta de una trampa tal como la hace la consola: el formulario de
 * /decoys/new/[modulo] y, en Cloud, la aprobación de una petición del MCP
 * guiado (lib/server/api/peticiones.ts) pasan por aquí. Así aprobar lo que
 * pidió un agente no es un camino nuevo: el módulo tiene que estar en la
 * suscripción y en la licencia, el identificador libre, los parámetros
 * cumplir el esquema del módulo y, al guardar, decide el elector (darDeAlta).
 */
import { motivo, validarParametros } from '@sugardaddy/contrato';
import type { Honeycosa } from '@sugardaddy/contrato';
import { SIN_IDENTIFICADOR, identificador } from '$lib/identificador';
import { darDeAlta, type FalloAlta } from './alta';
import { coberturaLicencia } from './candado';
import { trampasAutorizadas } from './catalogo';
import { existeTrampa } from './consultas';

export type ModuloParaAlta =
	{ ok: true; h: Honeycosa } | { ok: false; estado: 403 | 404; error: string };

/*
 * El módulo, si hoy se puede poner: autorizado para este cliente, cubierto por
 * su licencia (una de pago sin licencia se quedaría en espera: ni se pone) y
 * con alguna vía.
 */
export async function moduloParaAlta(id: string): Promise<ModuloParaAlta> {
	const h = (await trampasAutorizadas()).find((x) => x.id === id);
	if (!h)
		return {
			ok: false,
			estado: 404,
			error: 'That module is not in the catalog or is not authorized for this customer.'
		};
	const licencia = (await coberturaLicencia())(h.id);
	if (licencia !== 'cubierta') return { ok: false, estado: 403, error: motivo(licencia).texto };
	if (!h.vias.length)
		return { ok: false, estado: 404, error: 'This honeypot has no way to be deployed yet.' };
	return { ok: true, h };
}

/* Lo que llega del formulario (o de una petición aprobada): todo texto, como en un formulario. */
export type PedidoAlta = {
	id: string;
	nombre: string;
	destino: string;
	via?: string;
	/* La dirección de la máquina en la que se publica; vacía, en todas. */
	escucha: string;
	valores: Record<string, string>;
	plantilla?: string;
};

export type PedidoValido = {
	id: string;
	nombre: string;
	destino: string;
	via?: string;
	escucha: string | null;
	parametros: Record<string, unknown>;
	plantilla?: string;
};

/*
 * Las comprobaciones del formulario antes del elector: identificador libre,
 * nombre, destino y parámetros contra el esquema del módulo. Devuelve el id
 * ya normalizado y los parámetros tal como los deja el esquema.
 */
export async function comprobarPedido(
	h: Honeycosa,
	p: PedidoAlta
): Promise<{ ok: true; valor: PedidoValido } | { ok: false; id: string; errores: string[] }> {
	const nombre = p.nombre.trim();
	const id = identificador(p.id, nombre);
	const errores: string[] = [];
	if (!id) errores.push(SIN_IDENTIFICADOR);
	else if (await existeTrampa(id))
		errores.push('Identifier: a honeypot with that name already exists');
	if (!nombre) errores.push('Display name: required');
	if (!p.destino) errores.push('Target: choose where to deploy it');
	const v = validarParametros(h.parametros, p.valores);
	if (!v.ok) errores.push(...v.errores);
	if (!v.ok || errores.length) return { ok: false, id, errores };
	return {
		ok: true,
		valor: {
			id,
			nombre,
			destino: p.destino,
			...(p.via ? { via: p.via } : {}),
			escucha: p.escucha.trim() || null,
			parametros: v.valor,
			...(p.plantilla ? { plantilla: p.plantilla } : {})
		}
	};
}

/* Comprobar y guardar con el elector: lo mismo que pulsar «Deploy» en el formulario. */
export async function altaDeConsola(
	quien: string,
	h: Honeycosa,
	p: PedidoAlta
): Promise<'creada' | 'con-pasos' | (FalloAlta & { id: string })> {
	const c = await comprobarPedido(h, p);
	if (!c.ok) return { id: c.id, errores: c.errores, motivos: [] };
	const r = await darDeAlta(quien, { honeycosa: h, ...c.valor });
	return typeof r === 'string' ? r : { ...r, id: c.valor.id };
}
