/*
 * Abrir los puertos de los honeypots en el cortafuegos de la nube es de Cloud
 * (usa su conector de Azure). En esta edición la ficha de un sensor enseña qué
 * puertos abrir, para hacerlo a mano.
 */
export type CortafuegosDeSensor = {
	proveedor: 'azure';
	nsg: string | null;
	conector: boolean;
	enlaceConector: string;
};
export type PasoHecho = {
	regla: string;
	accion: 'crear' | 'cambiar' | 'igual' | 'quitar';
	trampa: string | null;
	destino: string | null;
	protocolo: 'Tcp' | 'Udp' | null;
	puertos: string[];
	prioridad: number | null;
	ok: boolean;
	error?: string;
};
export type ResultadoAbrir =
	{ ok: false; error: string } | { ok: true; simulado: boolean; nsg: string; pasos: PasoHecho[] };

const NO_ESTA = 'Not available in this edition.';

export async function cortafuegosDeFicha(_sensor: string): Promise<CortafuegosDeSensor | null> {
	return null;
}

export async function guardarCortafuegos(
	_quien: string,
	_sensor: string,
	_texto: string
): Promise<string | null> {
	return NO_ESTA;
}

export async function abrirPuertos(
	_quien: string,
	_sensor: string,
	_simular: boolean
): Promise<ResultadoAbrir> {
	return { ok: false, error: NO_ESTA };
}
