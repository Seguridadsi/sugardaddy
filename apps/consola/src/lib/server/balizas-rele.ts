/*
 * Relé de balizas: PIEZA DE PAGO. La edición community no trae el ingreso de las
 * balizas que vuelven por el relé público. canal.ts solo lo llama cuando el panel
 * lo pide (releBalizas), y un nodo community no tiene panel: nunca hay nada que
 * ingerir.
 */
export type BalizaRele = { id: number; huella: string; carga: Record<string, unknown> };

export async function recibirBalizasRele(
	_balizas: BalizaRele[]
): Promise<{ guardadas: number; nuevos: number }> {
	return { guardadas: 0, nuevos: 0 };
}
