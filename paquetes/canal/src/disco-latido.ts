/*
 * El disco de datos del appliance en el latido (docs/diseno/disco-cifrado.md): si está
 * cifrado (LUKS2) y si su clave está sellada al TPM. Lo miden los sensores (hechos
 * disco.cifrado y disco.tpm, que les deja el script «disco» del appliance); la consola
 * manda el más débil de sus sensores vivos que lo dicen y el panel lo enseña en la ficha
 * del nodo. Dos booleanos: nada que identifique a nadie. No va en el latido mínimo (como
 * el aislamiento: es diagnóstico, no hace falta para la licencia ni las actualizaciones).
 */
export type LatidoDisco = { cifrado: boolean; tpm: boolean };

const valor = (h: unknown): unknown =>
	h && typeof h === 'object' ? (h as { valor?: unknown }).valor : undefined;

/*
 * De los hechos de cada sensor (capacidades.hechos), el disco más débil: cifrado solo si
 * todos los que lo dicen lo están, y sellado al TPM solo si todos lo están. Los sensores
 * que no lo dicen (instalados a mano, remotos sin appliance) no cuentan; si ninguno lo
 * dice, no va.
 */
export function discoMasDebil(hechos: unknown[]): LatidoDisco | undefined {
	let alguno = false;
	let cifrado = true;
	let tpm = true;
	for (const h of hechos) {
		const x = (h && typeof h === 'object' ? h : {}) as Record<string, unknown>;
		const c = valor(x['disco.cifrado']);
		if (typeof c !== 'boolean') continue;
		alguno = true;
		cifrado &&= c;
		tpm &&= c && valor(x['disco.tpm']) === true;
	}
	return alguno ? { cifrado, tpm } : undefined;
}

/* Lo que acepta el panel: los dos booleanos, y sin TPM si no está cifrado. Lo demás, fuera. */
export function leerDiscoLatido(v: unknown): LatidoDisco | undefined {
	const d = v as Record<string, unknown> | null;
	if (!d || typeof d !== 'object') return undefined;
	if (typeof d.cifrado !== 'boolean' || typeof d.tpm !== 'boolean') return undefined;
	return { cifrado: d.cifrado, tpm: d.cifrado && d.tpm };
}
