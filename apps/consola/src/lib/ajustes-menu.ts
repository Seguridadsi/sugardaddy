/*
 * El menú de Ajustes. Los grupos de la página /settings (cada bloque es de uno y
 * solo se ve el elegido, ?tab=) y, detrás, las páginas de Ajustes que viven
 * aparte, enlazadas desde el mismo menú.
 */
export const GRUPOS_AJUSTES = [
	{ id: 'general', texto: 'General' },
	{ id: 'updates', texto: 'Updates' },
	{ id: 'access', texto: 'Access' },
	{ id: 'recovery', texto: 'Recovery and support' },
	{ id: 'events', texto: 'Events and data' },
	{ id: 'integrations', texto: 'Integrations' },
	{ id: 'central', texto: 'Central' },
	{ id: 'all', texto: 'All' }
] as const;
export type GrupoAjustes = (typeof GRUPOS_AJUSTES)[number]['id'];

type PaginaAjustes = { id: string; texto: string; ruta: `/settings/${string}` };

/* La API es de Cloud: construir-community.sh deja esta lista vacía. */
const PAGINAS_CLOUD: readonly PaginaAjustes[] = [];

/*
 * La exportación completa (la salida del cliente) y las copias fuera de la máquina
 * (copias-fuera.ts) van en las dos ediciones.
 */
export const PAGINAS_AJUSTES: readonly PaginaAjustes[] = [
	/* Quién tiene acceso y la revisión trimestral (revision-accesos.ts): en las dos ediciones. */
	{ id: 'access-review', texto: 'Access review', ruta: '/settings/access-review' },
	{ id: 'backups', texto: 'Backups', ruta: '/settings/backups' },
	/* La máquina del nodo y su cortafuegos estricto (anfitrion.ts), en las dos ediciones. */
	{ id: 'host', texto: 'Host', ruta: '/settings/host' },
	{ id: 'export', texto: 'Export', ruta: '/settings/export' },
	/* mTLS de los sensores remotos (docs/diseno/mtls-sensores.md), en las dos ediciones. */
	{
		id: 'sensor-certificates',
		texto: 'Sensor certificates',
		ruta: '/settings/sensor-certificates'
	},
	...PAGINAS_CLOUD
];
