/*
 * El buscador de las listas (honeypots, catálogo, constructor de plantillas):
 * sin acentos ni mayúsculas, y sin distinguir un guion de un espacio. Quien
 * escribe «sensor 1» encuentra «sensor-1», y «srv backup» encuentra
 * «srv-backup01».
 */
export const llano = (t: string) =>
	t
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[-_./\\]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

/* ¿Están en el texto todas las palabras de lo buscado? Sin nada que buscar, sí. */
export function casa(texto: string, buscado: string): boolean {
	const palabras = llano(buscado).split(' ').filter(Boolean);
	if (!palabras.length) return true;
	const t = llano(texto);
	return palabras.every((p) => t.includes(p));
}
