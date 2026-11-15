/*
 * Las IP del propio despliegue, que nada automático puede bloquear: ni el motor de respuesta
 * (EVT-5, respuesta/guardas.ts) ni la lista común en el EDL (docs/diseno/frenos-del-nodo.md).
 * Fuera de respuesta/ a propósito: la lista común también está en Community, y respuesta/ no.
 */
import { isIP } from 'node:net';
import { eq } from 'drizzle-orm';
import { db, schema as s } from './db';
import { hechosDeSensor } from '@sugardaddy/contrato';
import { hechosDe } from './hechos';
import { sinMapear } from './sin-mapear';

export { sinMapear };

const meterEn = (ips: Set<string>) => (v: unknown) => {
	if (typeof v === 'string' && isIP(v)) ips.add(sinMapear(v));
};

/*
 * Las IP de las máquinas del propio despliegue: la de cada destino (la que dio el
 * cliente o la que cuenta su sensor) y todas las que cuenta cada sensor de su
 * máquina. Contenerlas solas cortaría un servidor del cliente (el controlador de
 * dominio donde está la trampa) o dejaría ciego al producto (su sensor, su
 * consola): con estas, la automática pasa a aprobación.
 */
export async function ipsPropias(): Promise<Set<string>> {
	const filas = await db
		.select({ destino: s.destinos, sensor: s.sensores })
		.from(s.destinos)
		.leftJoin(s.sensores, eq(s.sensores.id, s.destinos.sensor));
	const ips = new Set<string>();
	const meter = meterEn(ips);
	for (const { destino, sensor } of filas) {
		const h = hechosDe(destino, sensor);
		meter(h['destino.direccion']?.valor);
		const contadas = h['red.direcciones']?.valor;
		if (Array.isArray(contadas)) contadas.forEach(meter);
	}
	return ips;
}

/*
 * Lo de ipsPropias más lo que un firewall del cliente nunca debe bloquear de su propio
 * despliegue: por dónde sale cada sensor a internet (red.ipPublica, que pregunta al panel),
 * desde qué IP llega cada sensor remoto a la consola, sus direcciones y las pasarelas de su
 * motor. Bloquear la IP de salida de una sede en el EDL la dejaría sin internet; bloquear la de
 * un sensor remoto, sin eventos.
 */
export async function ipsDelDespliegue(): Promise<Set<string>> {
	const ips = await ipsPropias();
	const meter = meterEn(ips);
	const sensores = await db
		.select({ capacidades: s.sensores.capacidades, direccion: s.sensores.direccion })
		.from(s.sensores);
	for (const x of sensores) {
		const h = hechosDeSensor(x.capacidades);
		meter(h['red.ipPublica']?.valor);
		meter(x.direccion);
		for (const clave of ['red.direcciones', 'motor.pasarelas']) {
			const v = h[clave]?.valor;
			if (Array.isArray(v)) v.forEach(meter);
		}
	}
	return ips;
}
