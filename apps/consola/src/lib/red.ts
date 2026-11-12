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

/* Lo que dice un formulario con «red», «vlan» y «redNombre», o el error que enseñar. */
export function redDelFormulario(
	f: FormData
): { red: string | null; vlan: number | null; redNombre: string | null } | { error: string } {
	const red = leerRed(String(f.get('red') ?? ''));
	if (red === undefined)
		return { error: 'The network must be IPv4 CIDR, from /8 to /32 (e.g. 10.70.0.0/24).' };
	const vlan = leerVlan(String(f.get('vlan') ?? ''));
	if (vlan === undefined) return { error: 'The VLAN must be a number from 1 to 4094.' };
	const redNombre = String(f.get('redNombre') ?? '').trim();
	if (redNombre.length > 60) return { error: 'The network name can be up to 60 characters.' };
	return { red, vlan, redNombre: redNombre || null };
}

/* Las direcciones IPv4, por su valor y no como texto: 10.50.0.4 va antes que 10.50.0.10. */
export function porDireccion(a: string, b: string): number {
	const n = (x: string) => x.split('.').reduce((s, o) => s * 256 + (Number(o) || 0), 0);
	return n(a) - n(b) || a.localeCompare(b);
}
