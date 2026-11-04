/*
 * Los toques de «Prueba mi detección» que hace el sensor (prueba-deteccion.ts
 * y, en el sensor, cmd/sensor/toques.go): la consola los deja aquí, el sensor
 * se los lleva con su plan y cuenta cómo han ido.
 *
 * El sensor marca los eventos del toque con el código de la prueba, así que
 * reconocerlos no depende de la IP con la que lleguen ni de que la consola
 * alcance la trampa, y el toque no le hace creer que sus trampas no ven la IP
 * de quien se conecta.
 */
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import type { Marca } from '@sugardaddy/contrato';
import { db, schema as s } from './db';

/* El campo del evento donde el sensor pone el código. */
export const marcaDeToque = (codigo: string): Marca => ({
	campo: 'detalle.toque',
	igual: codigo
});

/* Lo que se espera a que el sensor lo recoja: después, quien probaba ya se ha ido. */
const VIGENTE_MS = 90_000;
/* Lo que se guarda: solo sirve mientras dura la prueba. */
const CONSERVAR_MS = 86_400_000;

export type PedidoToque = {
	prueba: string;
	sensor: string;
	trampa: string;
	direccion: string;
	puerto: number;
	codigo: string;
	ips: string[];
};

export async function pedirToque(t: PedidoToque) {
	await db.delete(s.toques).where(lt(s.toques.pedido, new Date(Date.now() - CONSERVAR_MS)));
	await db.insert(s.toques).values(t);
}

/*
 * Los toques que el sensor aún no se ha llevado: se marcan entregados al
 * dárselos, en la misma sentencia, para que no se repitan. Si se perdiera la
 * respuesta, quien prueba vería «no llegó» y volvería a probar.
 */
export async function toquesPendientes(sensor: string) {
	return db
		.update(s.toques)
		.set({ entregado: new Date() })
		.where(
			and(
				eq(s.toques.sensor, sensor),
				isNull(s.toques.entregado),
				gt(s.toques.pedido, new Date(Date.now() - VIGENTE_MS))
			)
		)
		.returning({
			id: s.toques.id,
			trampa: s.toques.trampa,
			direccion: s.toques.direccion,
			puerto: s.toques.puerto,
			codigo: s.toques.codigo,
			ips: s.toques.ips
		});
}

/* Solo el suyo: un sensor no puede contar los toques de otro. */
export async function anotarToque(sensor: string, id: string, ok: boolean, detalle: string | null) {
	await db
		.update(s.toques)
		.set({ ok, detalle: detalle?.slice(0, 300) || null })
		.where(and(eq(s.toques.id, id), eq(s.toques.sensor, sensor)));
}
