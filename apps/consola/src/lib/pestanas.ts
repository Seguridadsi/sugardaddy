/*
 * Las pestañas de una página: los datos por un lado y la configuración por otro,
 * nunca mezclados en vertical. La pestaña va en la dirección (?tab=), así
 * funciona sin JavaScript, aguanta una recarga y se puede enlazar. La primera
 * es la de serie y no lleva parámetro.
 */
export type Pestana = { id: string; texto: string };

export function pestanaDe<const T extends readonly Pestana[]>(
	url: URL,
	pestanas: T
): T[number]['id'] {
	const pedida = url.searchParams.get('tab');
	return pestanas.some((p) => p.id === pedida) ? (pedida as T[number]['id']) : pestanas[0].id;
}

/* El enlace a una pestaña, conservando el resto de la dirección. */
export function enlacePestana(url: URL, pestanas: readonly Pestana[], id: string): string {
	const p = new URLSearchParams(url.searchParams);
	if (id === pestanas[0].id) p.delete('tab');
	else p.set('tab', id);
	const q = p.toString();
	return q ? `${url.pathname}?${q}` : url.pathname;
}
