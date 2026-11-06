/*
 * Los hechos de un destino tal como los ve el elector (docs/diseno/
 * modulo-despliegue.md §4.3). Aparte de destinos.ts para que lo usen también
 * los que destinos.ts necesita (el estado visible de las trampas, en
 * colocacion.ts) sin importarse en círculo; destinos.ts lo reexporta.
 */
import { isIP } from 'node:net';
import {
	fusionar,
	hechosDeConsola,
	hechosDeFormulario,
	hechosDeSensor
} from '@sugardaddy/contrato';
import type { Hechos } from '@sugardaddy/contrato';
import { ipPrincipal } from '$lib/mapa-despliegue';
import type { schema as s } from './db';

/* De la fila de un sensor, lo que cuenta para los hechos de su destino. */
export type SensorDeHechos = Pick<
	typeof s.sensores.$inferSelect,
	'id' | 'versionAgente' | 'registroPrivado' | 'capacidades' | 'red'
>;

/*
 * La IP de la máquina de un sensor, de las que cuenta él mismo (hecho
 * red.direcciones): la misma que enseña el mapa. null si no cuenta ninguna (un
 * sensor anterior a la 0.17.1). Pura.
 */
export function ipDeLaMaquina(direcciones: unknown, red: string | null): string | null {
	const ips = Array.isArray(direcciones)
		? direcciones.filter((x): x is string => typeof x === 'string' && isIP(x) !== 0)
		: [];
	return ipPrincipal(ips, red);
}

/*
 * Los hechos de un destino, calculados al leer y sin guardar copia: lo que
 * dijo el cliente en el formulario, lo que sabe la consola del sensor (su
 * versión, la credencial del registro, los ejecutores por defecto, el 443 del
 * sensor local) y lo que cuenta el sensor de su máquina
 * (sensores.capacidades). Para una misma clave gana el sensor, después la
 * consola y después el formulario. Un destino sin sensor solo tiene lo del
 * formulario.
 *
 * destino.direccion es la excepción: lo que dice el cliente manda, porque solo
 * él sabe si a esa máquina se llega por un nombre o por otra IP. Si no dice
 * nada, la consola pone la IP que el sensor cuenta de su máquina (un destino
 * con sensor es siempre esa máquina), para que nadie tenga que escribir un dato
 * que la consola ya sabe. Va con fuente consola y no sensor: un hecho del
 * sensor bloquea su campo en el formulario, y este se tiene que poder corregir.
 */
export function hechosDe(
	destino: Pick<typeof s.destinos.$inferSelect, 'descripcion'>,
	sensor: SensorDeHechos | null
): Hechos {
	const hechos = fusionar(
		hechosDeFormulario(destino.descripcion),
		hechosDeConsola(sensor),
		hechosDeSensor(sensor?.capacidades)
	);
	if (!sensor || Object.hasOwn(hechos, 'destino.direccion')) return hechos;
	const contadas = hechos['red.direcciones'];
	const ip = ipDeLaMaquina(contadas?.valor, sensor.red);
	if (ip)
		hechos['destino.direccion'] = {
			valor: ip,
			fuente: 'consola',
			...(contadas?.cuando ? { cuando: contadas.cuando } : {})
		};
	return hechos;
}
