/*
 * La dirección HTTPS de la propia consola, la que se da a otras máquinas (un
 * sensor remoto) para que la llamen.
 *
 * En modo fijo es ORIGIN. En modo «cualquier IP/nombre» ORIGIN va vacío (el
 * origen de cada petición sale de las cabeceras de Caddy), pero la consola
 * sigue teniendo un nombre propio, el de su certificado: CONSOLA_URL. No vale
 * la dirección con la que mira quien da el alta: puede ser una IP de paso que
 * el certificado no cubre y que el sensor no alcanza.
 */
import { env } from '$env/dynamic/private';

export function direccionConsolaDe(origin?: string, consolaUrl?: string): string | null {
	for (const c of [origin, consolaUrl]) {
		const t = (c ?? '').trim().replace(/\/+$/, '');
		if (!t.startsWith('https://')) continue;
		try {
			if (new URL(t).hostname) return t;
		} catch {
			/* Una dirección que no se entiende no vale: se prueba la siguiente. */
		}
	}
	return null;
}

export class SinDireccionConsola extends Error {
	constructor() {
		super(
			'This console has no HTTPS address of its own (ORIGIN or CONSOLA_URL in the node configuration), so other machines cannot be pointed at it.'
		);
	}
}

export function direccionConsola(): string {
	const d = direccionConsolaDe(env.ORIGIN, env.CONSOLA_URL);
	if (!d) throw new SinDireccionConsola();
	return d;
}

/* El nombre que la otra máquina tiene que resolver, para decírselo a quien da el alta. */
export function nombreConsola(): string | null {
	const d = direccionConsolaDe(env.ORIGIN, env.CONSOLA_URL);
	return d ? new URL(d).hostname : null;
}
