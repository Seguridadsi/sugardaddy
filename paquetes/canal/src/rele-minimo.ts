/*
 * Lo mínimo de una señal del relé que pasa por el panel (docs/diseno/rele-balizas.md,
 * «Qué ve SeguridadSI»). El panel es solo una bandeja de salida: lo que guarda de quien
 * abrió un cebo tiene que ser lo justo para que el nodo lo atribuya y avise.
 *
 * - User-Agent: los primeros UA_RELE_MAX caracteres. Con eso se ve el programa (Word,
 *   Excel, Acrobat, un navegador) y la versión; lo que sigue son extensiones, idioma o
 *   basura que escribe quien tiene el cebo y que solo sirve para huella. El nodo compara
 *   la señal del relé con la del receptor (yaAvisoLaApertura) por este mismo recorte,
 *   para que las dos sigan casando.
 * - Referer: solo el nombre del sitio, sin esquema, usuario, puerto, ruta ni consulta.
 *   La ruta y la consulta pueden llevar datos de la persona (un id de sesión, un correo);
 *   lo único que sirve para un aviso es de qué sitio venía (la clase que compare con el
 *   dominio del cliente, web-clonada-cebo, solo necesita eso).
 */

export const UA_RELE_MAX = 256;

/* Recorta por puntos de código, no por unidades UTF-16: no parte un carácter. */
export function recortarUaRele(ua: string): string {
	const cps = Array.from(ua);
	return cps.length <= UA_RELE_MAX ? ua : cps.slice(0, UA_RELE_MAX).join('');
}

/*
 * El nombre del sitio de un Referer, en minúsculas. undefined si no es una URL absoluta
 * con nombre: un Referer raro no se guarda (lo escribió quien hizo la petición).
 */
export function dominioDeReferer(referer: string): string | undefined {
	let u: URL;
	try {
		u = new URL(referer);
	} catch {
		return undefined;
	}
	const host = u.hostname.toLowerCase();
	if (!host || host.length > 253) return undefined;
	return host;
}

/*
 * La carga de una señal ya minimizada: UA y User-Agent del cuerpo recortados, Referer
 * reducido a su sitio (o fuera). Lo demás se queda como está: el nodo lo necesita para
 * atribuirla (token, nonce, ruta) o es el resumen cerrado del POST.
 */
export function minimizarCargaRele(carga: Record<string, unknown>): Record<string, unknown> {
	const c = { ...carga };
	for (const k of ['ua', 'uaAtacante']) {
		if (typeof c[k] === 'string') c[k] = recortarUaRele(c[k] as string);
	}
	if (typeof c.referer === 'string') {
		const d = dominioDeReferer(c.referer);
		if (d) c.referer = d;
		else delete c.referer;
	}
	return c;
}
