/*
 * El alcance de una salida de avisos por niveles: además de lo que dice la
 * propia salida (la consola entera), cada sensor y cada honeypot pueden decir si
 * lo suyo sale por ese canal: sí, no o lo que diga el nivel de arriba. Gana lo
 * más específico: el honeypot sobre su sensor, el sensor sobre la consola.
 *
 * Aquí solo está lo puro; guardar y leer, en server/salidas/alcance.ts.
 */
export type Alcance = {
	/* Por id de sensor y de honeypot: true, sale; false, no sale; sin entrada, hereda. */
	sensores: Record<string, boolean>;
	trampas: Record<string, boolean>;
};

export const SIN_ALCANCE: Alcance = { sensores: {}, trampas: {} };

/* De dónde viene un mensaje: los honeypots que toca (con su sensor) o un sensor. */
export type Origen = {
	trampas?: { id: string; sensor?: string | null }[];
	sensor?: string | null;
};

/* ¿Sale por este canal lo de ese honeypot (o, sin honeypot, lo de ese sensor)? */
export function enviaDe(a: Alcance, trampa: string | null, sensor: string | null): boolean {
	if (trampa !== null && Object.hasOwn(a.trampas, trampa)) return a.trampas[trampa];
	if (sensor !== null && Object.hasOwn(a.sensores, sensor)) return a.sensores[sensor];
	return true;
}

/*
 * Un mensaje con su origen. Uno que toca varios honeypots (un incidente) sale
 * si alguno de ellos sale: un ataque no se pierde porque también haya tocado
 * un honeypot callado. Sin origen (el resumen semanal, lo de otra salida), sale:
 * es de la consola entera.
 */
export function enAlcance(a: Alcance | undefined, o: Origen): boolean {
	if (!a) return true;
	if (o.trampas?.length) return o.trampas.some((t) => enviaDe(a, t.id, t.sensor ?? null));
	if (o.sensor) return enviaDe(a, null, o.sensor);
	return true;
}

/* El valor de un nivel para pintarlo: heredado, y de quién, o propio. */
export type ValorAlcance = 'hereda' | 'si' | 'no';
export const valorDe = (mapa: Record<string, boolean>, id: string): ValorAlcance =>
	Object.hasOwn(mapa, id) ? (mapa[id] ? 'si' : 'no') : 'hereda';
