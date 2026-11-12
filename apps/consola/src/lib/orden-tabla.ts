/*
 * Ordenar una tabla por varias columnas a la vez. El orden es una lista de
 * claves: la primera manda y las siguientes deshacen los empates.
 */
export type Clave<C extends string> = { columna: C; sentido: 'asc' | 'desc' };

/* Lo que una columna da de cada fila para compararla: texto o número. */
export type Valores<F, C extends string> = Record<C, (fila: F) => string | number>;

const comparar = (a: string | number, b: string | number) =>
	typeof a === 'number' && typeof b === 'number'
		? a - b
		: String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });

export function ordenar<F, C extends string>(
	filas: readonly F[],
	orden: readonly Clave<C>[],
	valores: Valores<F, C>
): F[] {
	if (!orden.length) return [...filas];
	return filas.toSorted((a, b) => {
		for (const { columna, sentido } of orden) {
			const d = comparar(valores[columna](a), valores[columna](b));
			if (d) return sentido === 'asc' ? d : -d;
		}
		return 0;
	});
}

/*
 * Lo que hace un clic en una cabecera. Solo, deja esa columna como único
 * orden; con «añadir» (Mayús), la suma a las que ya había. En los dos casos,
 * repetir sobre la misma columna da ascendente, descendente y la quita.
 */
export function alternar<C extends string>(
	orden: readonly Clave<C>[],
	columna: C,
	anadir: boolean
): Clave<C>[] {
	const actual = orden.find((k) => k.columna === columna);
	const siguiente: Clave<C> | null = !actual
		? { columna, sentido: 'asc' }
		: actual.sentido === 'asc'
			? { columna, sentido: 'desc' }
			: null;
	if (!anadir) return siguiente ? [siguiente] : [];
	if (!actual) return [...orden, siguiente!];
	return siguiente
		? orden.map((k) => (k.columna === columna ? siguiente : k))
		: orden.filter((k) => k.columna !== columna);
}
