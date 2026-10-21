import type { ManifiestoTrampa } from './tipos.ts';

/*
 * Los puertos que publicará una trampa con estos parámetros: el mismo cálculo
 * que hace el sensor en Go (despliegue.config). Un puerto apagado (si: telnet
 * y telnet = no) no se publica. Los fijos son los del manifiesto, a los que el
 * nodo puede sumar su desplazamiento; los que vienen de un parámetro, tal cual.
 * Solo mira el contenedor: vale igual con la carga de una vía contenedor@1,
 * que es lo que proyectarParaSensor copia al manifiesto v1.
 */
export type Puerto = { puerto: number; protocolo: 'tcp' | 'udp'; fijo: boolean; interno: number };

const encendido = (v: unknown) => v === true || v === 'yes' || v === 'true';

export function puertosPublicados(
	m: Pick<ManifiestoTrampa, 'contenedor'>,
	parametros: Record<string, unknown>
): Puerto[] {
	return (m.contenedor?.puertos ?? []).flatMap((p): Puerto[] => {
		if (p.si && !encendido(parametros[p.si])) return [];
		if (typeof p.expuesto === 'number')
			return [{ puerto: p.expuesto, protocolo: p.protocolo, fijo: true, interno: p.interno }];
		const n = Number(parametros[p.expuesto.slice(2, -1)]);
		return Number.isInteger(n) && n > 0 && n < 65536
			? [{ puerto: n, protocolo: p.protocolo, fijo: false, interno: p.interno }]
			: [];
	});
}
