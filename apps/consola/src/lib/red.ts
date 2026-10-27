/*
 * La red y la VLAN de un sensor: cómo se leen de un formulario y cómo se
 * enseñan. Las usan las páginas y el servidor; leerlas, también el arranque
 * de la consola (scripts/red.mjs).
 */
import { leerRed, leerVlan } from '../../scripts/red.mjs';

export { leerRed, leerVlan };

/* "10.70.0.0/24 · VLAN 70"; vacío si no se sabe ninguna. */
export const redYVlan = (red: string | null, vlan: number | null) =>
	[red, vlan ? `VLAN ${vlan}` : null].filter(Boolean).join(' · ');

/* Lo que dice un formulario con «red» y «vlan», o el error que enseñar. */
export function redDelFormulario(
	f: FormData
): { red: string | null; vlan: number | null } | { error: string } {
	const red = leerRed(String(f.get('red') ?? ''));
	if (red === undefined)
		return { error: 'La red va en CIDR IPv4, de /8 a /32 (p. ej. 10.70.0.0/24).' };
	const vlan = leerVlan(String(f.get('vlan') ?? ''));
	if (vlan === undefined) return { error: 'La VLAN es un número del 1 al 4094.' };
	return { red, vlan };
}
