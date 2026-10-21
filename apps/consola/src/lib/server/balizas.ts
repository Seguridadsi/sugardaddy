/*
 * Balizas de fichero: PIEZA DE PAGO. La edición community no trae el receptor de
 * balizas, el acuñado de documentos cebo (Word/Excel/PDF) ni la tabla de
 * balizas. Aquí quedan solo los dos ganchos que el elector y el alta esperan del
 * nodo, con la respuesta de un nodo que NO recibe balizas: hechosNodo no aporta
 * el hecho canal.rele y receptorDelNodo no encuentra ningún receptor. Sin
 * canal.rele el elector no enciende las honeycosas de fichero, que además no
 * están en el catálogo gratis: nunca se da de alta ninguna.
 */
import type { Hechos } from '@sugardaddy/contrato';
import { db } from './db';

/* La conexión de siempre o una transacción abierta (como el Bd de destinos.ts). */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Bd = Tx | typeof db;

/*
 * El receptor de balizas puesto y comprobado del nodo. En community el receptor
 * es una trampa de pago que no existe, así que nunca hay ninguno (null).
 */
export async function receptorDelNodo(_bd: Bd = db): Promise<{
	trampa: string;
	sensor: string;
	destino: string | null;
	puerto: number;
} | null> {
	return null;
}

/*
 * Los hechos del nodo que no salen de ningún destino (en la edición de pago,
 * canal.rele cuando el nodo recibe balizas). Sin receptor no hay nada que
 * aportar, así que el elector no enciende las honeycosas de fichero.
 */
export async function hechosNodo(_bd: Bd = db): Promise<Hechos> {
	return {};
}
