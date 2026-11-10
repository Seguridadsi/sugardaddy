/*
 * Las claves de publicación en las que confía esta aplicación (docs/diseno/claves-y-catalogo.md):
 * PUBLICACION_CLAVES (por uso) y PUBLICACION_CLAVE_PUBLICA (la de legado). Se leen en cada
 * llamada: el actualizador puede renovarlas con una versión firmada.
 */
import { env } from '$env/dynamic/private';
import { confianzaDelEntorno, type Confianza } from '@sugardaddy/canal';

/* null si no se confía en ninguna clave (un nodo o un panel sin claves no comprueba nada). */
export function confianza(): Confianza | null {
	const c = confianzaDelEntorno(env);
	return c.legado || c.claves.length ? c : null;
}

/* Las dos líneas de .env que se pasan a lo que se instala desde aquí. */
export const lineasDeClaves = () => [
	`PUBLICACION_CLAVES=${env.PUBLICACION_CLAVES ?? ''}`,
	`PUBLICACION_CLAVE_PUBLICA=${env.PUBLICACION_CLAVE_PUBLICA ?? ''}`
];
