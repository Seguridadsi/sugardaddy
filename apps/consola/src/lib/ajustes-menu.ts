/*
 * El menú de Ajustes. Los grupos de la página /settings (cada bloque es de uno y
 * solo se ve el elegido, ?tab=) y, detrás, las páginas de Ajustes que viven
 * aparte, enlazadas desde el mismo menú.
 */
export const GRUPOS_AJUSTES = [
	{ id: 'general', texto: 'General' },
	{ id: 'access', texto: 'Access' },
	{ id: 'recovery', texto: 'Recovery and support' },
	{ id: 'events', texto: 'Events and data' },
	{ id: 'integrations', texto: 'Integrations' },
	{ id: 'central', texto: 'Central' },
	{ id: 'all', texto: 'All' }
] as const;
export type GrupoAjustes = (typeof GRUPOS_AJUSTES)[number]['id'];

/* La API es de Cloud: construir-community.sh deja esta lista vacía. */
export const PAGINAS_AJUSTES: readonly {
	id: string;
	texto: string;
	ruta: `/settings/${string}`;
}[] = [];
