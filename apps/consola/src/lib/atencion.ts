/*
 * Lo que necesita atención en el nodo, en una sola lista: lo que está roto o
 * a medias y pide que alguien haga algo. No son ataques (eso son los eventos y
 * los incidentes): es el estado del propio despliegue. Pura; quien junta los
 * datos es server/atencion.ts.
 */
export type Atencion = {
	gravedad: 'error' | 'aviso';
	texto: string;
	/* A dónde ir para arreglarlo. */
	href: string;
};

export type SensorParaAtencion = {
	id: string;
	nombre: string;
	vivo: boolean;
	ultimoLatido: string | null;
	avisos: { gravedad: string; titulo: string }[];
};

export type SalidaParaAtencion = {
	id: string;
	nombre: string;
	fallosSeguidos: number;
	ultimoError: string | null;
};

const plural = (n: number, uno: string, varios: string) => (n === 1 ? uno : varios);

export function armarAtencion(v: {
	sensores: readonly SensorParaAtencion[];
	/* El estado visible de cada honeypot (server/colocacion.ts). */
	trampas: readonly { estado: string }[];
	salidas: readonly SalidaParaAtencion[];
}): Atencion[] {
	const lista: Atencion[] = [];
	for (const x of v.sensores) {
		if (!x.vivo)
			lista.push({
				gravedad: 'error',
				texto: x.ultimoLatido
					? `Sensor "${x.nombre}" is offline: its honeypots are not reporting.`
					: `Sensor "${x.nombre}" has never connected.`,
				href: '/sensors'
			});
		for (const a of x.avisos)
			if (a.gravedad === 'error')
				lista.push({
					gravedad: 'error',
					texto: `Sensor "${x.nombre}": ${a.titulo}`,
					href: '/sensors'
				});
	}
	for (const x of v.salidas)
		if (x.fallosSeguidos > 0)
			lista.push({
				gravedad: 'error',
				texto: `Output "${x.nombre}" is not delivering${x.ultimoError ? `: ${x.ultimoError}` : '.'}`,
				href: `/alerts/${x.id}`
			});
	const cuantas = (estado: string) => v.trampas.filter((t) => t.estado === estado).length;
	const degradadas = cuantas('degradada');
	if (degradadas)
		lista.push({
			gravedad: 'error',
			texto: `${degradadas} ${plural(degradadas, 'honeypot is', 'honeypots are')} degraded.`,
			href: '/decoys'
		});
	const sinProbar = cuantas('colocada');
	if (sinProbar)
		lista.push({
			gravedad: 'aviso',
			texto: `${sinProbar} ${plural(sinProbar, 'honeypot is', 'honeypots are')} active but not verified with a real event yet.`,
			href: '/decoys'
		});
	const porColocar = cuantas('por-colocar');
	if (porColocar)
		lista.push({
			gravedad: 'aviso',
			texto: `${porColocar} ${plural(porColocar, 'honeypot is', 'honeypots are')} pending deployment.`,
			href: '/decoys'
		});
	/* Primero lo roto; dentro de cada grupo, el orden en que se ha mirado. */
	return [
		...lista.filter((x) => x.gravedad === 'error'),
		...lista.filter((x) => x.gravedad === 'aviso')
	];
}
