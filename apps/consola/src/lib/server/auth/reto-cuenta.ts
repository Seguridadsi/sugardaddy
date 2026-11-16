/*
 * El reto de WebAuthn de «añadir una passkey» en Mi cuenta: en memoria, de un
 * solo uso y atado al usuario que lo pidió (retos.ts).
 */
import { almacenDeRetos } from '../retos';
import { loginLocalHabilitado } from './local';

export const COOKIE_RETO_CUENTA = 'sd_reto_cuenta';
const retos = almacenDeRetos<{ reto: string; id: string }>(1000, 5 * 60_000);
export const guardarRetoCuenta = (d: { reto: string; id: string }) => retos.guardar(d);
export const tomarRetoCuenta = (t: string | undefined) => retos.tomar(t);

export function idLocalDe(locals: App.Locals): string | null {
	const oid = locals.usuario?.oid;
	if (!oid || !oid.startsWith('local:') || !loginLocalHabilitado()) return null;
	return oid.slice('local:'.length);
}
