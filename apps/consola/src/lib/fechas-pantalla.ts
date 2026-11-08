/*
 * Las fechas de pantalla, en la zona de quien mira. La zona la pone el layout en
 * `page.data` (lib/server/zona-horaria.ts): `page` es de cada petición en el
 * servidor y reactivo en el navegador, así que al cambiarla se repinta todo lo
 * que hay en pantalla y no hay estado compartido entre usuarios.
 *
 * Solo sirve mientras se pinta: en un `load`, en una acción o en un correo no
 * hay `page`, y ahí se llama a `formatearFecha` con la zona a mano.
 * `fechas-pantalla.spec.ts` no deja formatear fechas por otro camino en las páginas.
 */
import { page } from '$app/state';
import { COOKIE_ZONA, ZONA_POR_DEFECTO, formatearFecha, zonaValida } from './fechas';

export const zonaEnPantalla = (): string => page.data.zonaHoraria ?? ZONA_POR_DEFECTO;

type Fecha = string | number | Date;

export const horaCorta = (f: Fecha) => formatearFecha(f, 'hora', zonaEnPantalla());
export const horaLarga = (f: Fecha) => formatearFecha(f, 'horaSegundos', zonaEnPantalla());
export const diaCorto = (f: Fecha) => formatearFecha(f, 'dia', zonaEnPantalla());
export const fechaCorta = (f: Fecha) => formatearFecha(f, 'fecha', zonaEnPantalla());
export const fechaLarga = (f: Fecha) => formatearFecha(f, 'fechaLarga', zonaEnPantalla());
export const fechaHora = (f: Fecha) => formatearFecha(f, 'fechaHora', zonaEnPantalla());
export const fechaHoraLarga = (f: Fecha) => formatearFecha(f, 'fechaHoraLarga', zonaEnPantalla());
export const diaHora = (f: Fecha) => formatearFecha(f, 'diaHora', zonaEnPantalla());
export const semanaHora = (f: Fecha) => formatearFecha(f, 'semanaHora', zonaEnPantalla());

/*
 * Solo en el navegador: deja dicha su zona en una cookie para que el servidor
 * pinte con ella desde la primera petición. Dice si ha cambiado algo: la primera
 * vez, o si el portátil ha viajado.
 */
export function anotarZonaDelNavegador(): boolean {
	const zona = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const valor = encodeURIComponent(zona);
	if (!zonaValida(zona) || document.cookie.split('; ').includes(`${COOKIE_ZONA}=${valor}`))
		return false;
	const seguro = location.protocol === 'https:' ? '; secure' : '';
	document.cookie = `${COOKIE_ZONA}=${valor}; path=/; max-age=31536000; samesite=lax${seguro}`;
	return true;
}
