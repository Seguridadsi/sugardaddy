/*
 * A dónde salen las salidas de avisos es de Cloud. En esta edición no hay salidas:
 * la salida restringida del cortafuegos estricto no tiene nada que añadir de ellas.
 */
export async function destinosDeSalidas(
	_normalizar: (destino: string) => string | null,
	_que?: 'tcp' | 'directas' | 'udp'
): Promise<string[]> {
	return [];
}
