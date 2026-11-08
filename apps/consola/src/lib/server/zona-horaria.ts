/*
 * La zona horaria de cada persona: la que eligió, o la de su navegador, o
 * Europe/Madrid si su navegador aún no ha dicho nada. Vale igual para login
 * local, Entra y emergencia, porque va por el oid de la sesión. El usuario de
 * modo desarrollo no tiene oid: el suyo es su correo, que nunca coincide con uno.
 */
import type { Cookies } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { COOKIE_ZONA, ZONA_POR_DEFECTO, zonaValida } from '../fechas';
import { db, schema as s } from './db';

type Persona = Pick<NonNullable<App.Locals['usuario']>, 'correo' | 'oid'>;

const claveDe = (u: Persona) => u.oid ?? u.correo;

/* Sin zona (null): vuelve a seguir la del navegador. Quien llama ya la ha validado. */
export async function guardarZona(u: Persona, zona: string | null) {
	const valores = { zonaHoraria: zona, actualizada: new Date() };
	await db
		.insert(s.preferenciasUsuario)
		.values({ oid: claveDe(u), ...valores })
		.onConflictDoUpdate({ target: s.preferenciasUsuario.oid, set: valores });
}

/*
 * También se valida lo guardado: la lista de zonas la trae el sistema y puede
 * cambiar con una actualización. Y la cookie la escribe el navegador, así que
 * vale lo que valga: una zona mala es como no haber dicho nada.
 */
export async function zonasDe(u: Persona | null, cookies: Pick<Cookies, 'get'>) {
	const cookie = cookies.get(COOKIE_ZONA);
	const zonaNavegador = zonaValida(cookie) ? cookie : ZONA_POR_DEFECTO;
	const [fila] = u
		? await db
				.select({ zona: s.preferenciasUsuario.zonaHoraria })
				.from(s.preferenciasUsuario)
				.where(eq(s.preferenciasUsuario.oid, claveDe(u)))
		: [];
	const zonaGuardada = zonaValida(fila?.zona) ? fila.zona : null;
	return { zonaHoraria: zonaGuardada ?? zonaNavegador, zonaGuardada, zonaNavegador };
}
