/*
 * Los hechos de un destino tal como los ve el elector (docs/diseno/
 * modulo-despliegue.md §4.3). Aparte de destinos.ts para que lo usen también
 * los que destinos.ts necesita (el estado visible de las trampas, en
 * colocacion.ts) sin importarse en círculo; destinos.ts lo reexporta.
 */
import {
	fusionar,
	hechosDeConsola,
	hechosDeFormulario,
	hechosDeSensor
} from '@sugardaddy/contrato';
import type { Hechos } from '@sugardaddy/contrato';
import type { schema as s } from './db';

/* De la fila de un sensor, lo que cuenta para los hechos de su destino. */
export type SensorDeHechos = Pick<
	typeof s.sensores.$inferSelect,
	'id' | 'versionAgente' | 'registroPrivado' | 'capacidades'
>;

/*
 * Los hechos de un destino, calculados al leer y sin guardar copia: lo que
 * dijo el cliente en el formulario, lo que sabe la consola del sensor (su
 * versión, la credencial del registro, los ejecutores por defecto, el 443 del
 * sensor local) y lo que cuenta el sensor de su máquina
 * (sensores.capacidades). Para una misma clave gana el sensor, después la
 * consola y después el formulario. Un destino sin sensor solo tiene lo del
 * formulario.
 */
export function hechosDe(
	destino: Pick<typeof s.destinos.$inferSelect, 'descripcion'>,
	sensor: SensorDeHechos | null
): Hechos {
	return fusionar(
		hechosDeFormulario(destino.descripcion),
		hechosDeConsola(sensor),
		hechosDeSensor(sensor?.capacidades)
	);
}
