/*
 * Lo que el latido lleva al panel de la integridad del nodo y de la entrega de los sensores
 * (F33, F34; paquetes/canal, leerIntegridadLatido y leerEntregaLatido). Solo números: el
 * detalle de las desviaciones (rutas, nombres de variables) y las líneas apartadas se quedan
 * en el nodo. No van en el latido mínimo.
 */
import type { Hechos } from '@sugardaddy/contrato';
import type { LatidoEntrega, LatidoIntegridad } from '@sugardaddy/canal';
import { estadoIntegridad } from './integridad';

export async function integridadParaLatido(): Promise<{ integridad?: LatidoIntegridad }> {
	const e = await estadoIntegridad();
	if (!e?.comprobado) return {};
	return { integridad: { comprobado: e.comprobado, desviaciones: e.desviaciones.length } };
}

/* La suma del hecho entrega.apartadas de los sensores que lo dicen, y en cuántos pasó. */
export function entregaParaLatido(hechos: (Hechos | null | undefined)[]): {
	entrega?: LatidoEntrega;
} {
	let apartadas = 0;
	let sensores = 0;
	let alguno = false;
	for (const h of hechos) {
		const v = h?.['entrega.apartadas']?.valor;
		if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) continue;
		alguno = true;
		if (v > 0) {
			apartadas += v;
			sensores++;
		}
	}
	return alguno ? { entrega: { apartadas: Math.min(apartadas, 1e9), sensores } } : {};
}
