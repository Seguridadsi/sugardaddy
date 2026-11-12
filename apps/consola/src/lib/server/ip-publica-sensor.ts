/*
 * La IP pública de un sensor, por este orden:
 *  - la que él mismo ha preguntado al panel (hecho red.ipPublica): por dónde sale
 *    a internet de verdad, también detrás de un NAT. La consola le dice en el plan
 *    dónde preguntar (PREGUNTAR_IP_EN); un sensor anterior, o uno sin salida a
 *    internet, no la trae;
 *  - una dirección pública en su propia máquina (hecho red.direcciones): un
 *    servidor con la IP de internet en su interfaz;
 *  - la IP desde la que llega a la consola (sensores.direccion), cuando es
 *    pública: una máquina de nube o una sede detrás de NAT, con la consola en otro sitio.
 * Si nada de eso la da, null. No depende de respuesta/iocs.ts, que en Community no existe.
 */
import { BlockList, isIP } from 'node:net';
import { env } from '$env/dynamic/private';

/*
 * Dónde pregunta el sensor: el panel de este nodo, que contesta con la IP desde
 * la que le llega la petición y nada más (api/nodo/ip en la central).
 */
export const PREGUNTAR_IP_EN =
	(env.SUGARDADDY_PANEL_URL ?? 'https://sugardaddy-central.azurewebsites.net').replace(/\/+$/, '') +
	'/api/nodo/ip';

const NO_PUBLICAS = new BlockList();
for (const [red, bits] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.168.0.0', 16],
	/* Documentación y pruebas: no son de nadie. */
	['192.0.2.0', 24],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	['240.0.0.0', 4]
] as const)
	NO_PUBLICAS.addSubnet(red, bits, 'ipv4');
for (const [red, bits] of [
	['::', 96],
	['64:ff9b::', 96],
	['2001:db8::', 32],
	['2002::', 16],
	['fc00::', 7],
	['fe80::', 10],
	['fec0::', 10],
	['ff00::', 8]
] as const)
	NO_PUBLICAS.addSubnet(red, bits, 'ipv6');

/* La sonda de Azure y los metadatos de las nubes: salen en la máquina, no son suyas. */
const DE_LA_NUBE = new Set(['168.63.129.16', '100.100.100.200']);

function esPublica(ip: string): boolean {
	const familia = isIP(ip);
	if (!familia || DE_LA_NUBE.has(ip)) return false;
	return !NO_PUBLICAS.check(ip, familia === 6 ? 'ipv6' : 'ipv4');
}

export function ipPublicaSensor(
	ips: readonly string[],
	direccion: string | null | undefined,
	preguntada?: unknown
): string | null {
	if (typeof preguntada === 'string' && esPublica(preguntada)) return preguntada;
	/* IPv4 antes que IPv6: es la que se busca en un cortafuegos o en un buscador. */
	const propias = ips.filter(esPublica);
	const propia = propias.find((x) => isIP(x) === 4) ?? propias[0];
	if (propia) return propia;
	const llega = direccion?.replace(/^::ffff:/i, '') ?? '';
	return esPublica(llega) ? llega : null;
}
