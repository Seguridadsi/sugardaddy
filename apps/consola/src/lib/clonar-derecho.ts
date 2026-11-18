/*
 * Petición de clonado de una página para una trampa (H125, /decoys/clone).
 * Antes de clonar, quien despliega confirma que tiene derecho a copiar esa
 * página. La comprobación la hace el servidor con esto: sin la confirmación
 * no se baja nada, la mande o no el formulario. El formulario enseña el mismo
 * texto, que queda en la auditoría junto con quién, cuándo (la fila) y qué
 * dirección.
 */

/* Lo que ve y marca quien clona: es lo que acepta, así que va igual a la auditoría. */
export const TEXTO_DERECHO =
	'I confirm that I have the right to copy this page: it belongs to my organization or I am authorized to reproduce it.';

export type PeticionClon = { ok: true; url: string } | { ok: false; estado: number; error: string };

export function leerPeticionClon(cuerpo: unknown): PeticionClon {
	const c = (cuerpo && typeof cuerpo === 'object' ? cuerpo : {}) as {
		url?: unknown;
		derecho?: unknown;
	};
	const url = typeof c.url === 'string' ? c.url.trim().slice(0, 2048) : '';
	if (!url) return { ok: false, estado: 400, error: 'Enter the address of the page to clone' };
	/* Solo un true de verdad: ni "true", ni 1, ni una casilla sin marcar. */
	if (c.derecho !== true)
		return {
			ok: false,
			estado: 400,
			error: 'Confirm that you have the right to copy this page before cloning it'
		};
	return { ok: true, url };
}
