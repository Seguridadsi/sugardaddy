import type { Evento, Marca } from './tipos.ts';

/*
 * Cuándo un evento cumple una marca (docs/diseno/modulo-despliegue.md §2.4,
 * §8.3 y §8.5): el campo de la marca (origen.ip, origen.usuario,
 * origen.equipo o detalle.<campo>) es igual al valor, o lo contiene, sin
 * distinguir mayúsculas. La usan «Probar» (la marca de la prueba) y la señal
 * por otra trampa (la marca con que se reconoce lo sembrado).
 *
 * El evento lo escribe el atacante: un campo que no es texto, número ni
 * booleano no cumple nada, y una marca con el valor vacío tampoco (un
 * «contiene» vacío lo cumpliría cualquier evento). Pura y sin excepciones.
 */
export function cumpleMarca(e: Evento, m: Marca): boolean {
	const esperado = 'igual' in m ? m.igual : m.contiene;
	if (typeof esperado !== 'string' || esperado === '') return false;
	const v = valorDeCampo(e, m.campo);
	if (v === undefined) return false;
	const a = v.toLowerCase();
	const b = esperado.toLowerCase();
	return 'igual' in m ? a === b : a.includes(b);
}

/* El valor de un campo de marca en un evento, como texto, o undefined si no lo tiene. */
function valorDeCampo(e: Evento, campo: string): string | undefined {
	let v: unknown;
	if (campo === 'origen.ip') v = e.origen?.ip;
	else if (campo === 'origen.usuario') v = e.origen?.usuario;
	else if (campo === 'origen.equipo') v = e.origen?.equipo;
	else if (campo.startsWith('detalle.')) {
		const k = campo.slice('detalle.'.length);
		const d = e.detalle;
		v = d && Object.hasOwn(d, k) ? d[k] : undefined;
	}
	if (typeof v === 'string') return v;
	if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') return String(v);
	return undefined;
}
