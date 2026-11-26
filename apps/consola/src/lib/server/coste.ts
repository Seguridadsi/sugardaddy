/*
 * Lo que una trampa le ha costado al atacante (idea 4 de las de aitarpit):
 * tiempo retenido y bytes que le mandó, sacados del detalle de cada evento
 * con los campos que declara el manifiesto (eventos.coste). Se guardan con el
 * evento y se suman por incidente; los tokens que le hizo leer a un agente de
 * IA se estiman como bytes ÷ 4, y se dice que es una estimación.
 *
 * Puro: sin base de datos. El detalle lo escribió el atacante (la trampa lo
 * copia de su sesión), así que se lee con desconfianza: solo números, con tope.
 */

/* Topes de lo creíble en un evento: más que esto es un dato roto, no un récord. */
const MAX_RETENIDO_MS = 30 * 24 * 3600_000;
const MAX_BYTES = 10 ** 13;

export type Coste = { retenidoMs: number | null; bytesEnviados: number | null };

/* Un número del detalle: 12, "6.010", "6.010s" o "450ms". Lo demás, null. */
function numero(v: unknown): { n: number; ms: boolean } | null {
	if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? { n: v, ms: false } : null;
	if (typeof v !== 'string') return null;
	const m = /^\s*(\d{1,15}(?:\.\d{1,9})?)\s*(ms|s)?\s*$/.exec(v);
	return m ? { n: Number(m[1]), ms: m[2] === 'ms' } : null;
}

/* El coste de un evento según los campos que declara su manifiesto. */
export function costeDe(
	detalle: Record<string, unknown> | undefined,
	campos: { tiempo?: string; bytes?: string } | undefined
): Coste {
	const t = campos?.tiempo ? numero(detalle?.[campos.tiempo]) : null;
	const b = campos?.bytes ? numero(detalle?.[campos.bytes]) : null;
	const ms = t ? Math.round(t.ms ? t.n : t.n * 1000) : null;
	const bytes = b && !b.ms ? Math.round(b.n) : null;
	return {
		retenidoMs: ms !== null && ms <= MAX_RETENIDO_MS ? ms : null,
		bytesEnviados: bytes !== null && bytes <= MAX_BYTES ? bytes : null
	};
}

/* Tokens estimados que un agente de IA tuvo que leer: unos 4 bytes por token. */
export const tokensEstimados = (bytes: number) => Math.round(bytes / 4);

/* «2 h 14 min», «3 min 5 s», «12 s»: para personas. */
export function duracionLegible(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s} s`;
	const min = Math.floor(s / 60);
	if (min < 60) return s % 60 ? `${min} min ${s % 60} s` : `${min} min`;
	const h = Math.floor(min / 60);
	if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
	const d = Math.floor(h / 24);
	return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/*
 * 3.2M, 800K, 12: a mano y no con Intl compacto, que según los datos de idioma de la máquina
 * da «3.2m» y «800k» (pasó en el CI del repositorio público con la 0.33.5).
 */
const ESCALAS = [
	[1e12, 'T'],
	[1e9, 'B'],
	[1e6, 'M'],
	[1e3, 'K']
] as const;
export function compacto(n: number): string {
	for (const [i, [v, s]] of ESCALAS.entries()) {
		const x = Math.round((n / v) * 10) / 10;
		/* 999.96K se redondea a 1000K: mejor 1M, con la escala de arriba. */
		if (x >= 1000 && i > 0)
			return `${Math.round((n / ESCALAS[i - 1][0]) * 10) / 10}${ESCALAS[i - 1][1]}`;
		if (n >= v) return `${x}${s}`;
	}
	return String(Math.round(n));
}

/*
 * La frase del coste para un incidente o un origen, o null si no hay nada que
 * contar. «Held the attacker for 2 h 14 min and sent it 3.2 MB (~800K tokens
 * for an AI agent)».
 */
export function textoCoste(retenidoMs: number, bytes: number): string | null {
	const partes: string[] = [];
	if (retenidoMs >= 1000) partes.push(`held the attacker for ${duracionLegible(retenidoMs)}`);
	if (bytes >= 1024)
		partes.push(
			`sent it ${compacto(bytes)}B of decoy data (~${compacto(tokensEstimados(bytes))} tokens if an AI agent read it)`
		);
	if (!partes.length) return null;
	const t = partes.join(' and ');
	return t[0].toUpperCase() + t.slice(1);
}
