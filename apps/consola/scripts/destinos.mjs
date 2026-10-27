/*
 * Destinos de los sensores (docs/diseno/modulo-despliegue.md §5 y §9.1).
 *
 * Sin dependencias: lo usan el arranque de la consola (preparar-base.mjs),
 * que corre en la imagen sin compilar, la semilla de desarrollo y
 * $lib/server/destinos.ts, para que el id que se propone sea el mismo en
 * todos.
 */

/* Como el de un sensor o una trampa: un slug de 63 caracteres como mucho. */
export const LARGO_ID = 63;

/* Cuántos candidatos se prueban antes de rendirse: fs01, fs01-2 … fs01-1000. */
export const CANDIDATOS = 1000;

/**
 * Un texto escrito por el cliente, como id (de un destino, un sensor o una
 * trampa): «FS01 (Nóminas)» → «fs01-nominas». Vacío si no hay nada
 * aprovechable.
 *
 * @param {string} texto
 */
export function slug(texto) {
	return texto
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+/, '')
		.slice(0, LARGO_ID)
		.replace(/-+$/, '');
}

/**
 * La base del id de un destino: su nombre como slug o, sin nada
 * aprovechable, «destino».
 *
 * @param {string} nombre
 */
export function slugDestino(nombre) {
	return slug(nombre) || 'destino';
}

/**
 * El candidato número n para el id de un destino que se propone a partir de
 * base (un slug): base y, si ya lo tiene otro destino, base-2, base-3…,
 * recortando base para que quepa.
 *
 * @param {string} base
 * @param {number} n
 */
export function idDestino(base, n) {
	if (n <= 1) return base.slice(0, LARGO_ID);
	const sufijo = `-${n}`;
	return base.slice(0, LARGO_ID - sufijo.length) + sufijo;
}

/*
 * El «donde» que informa el sensor (o escribe la consola) dicho como estado
 * de colocación, para las trampas que vienen de antes del módulo de
 * despliegue. «en espera: …» la deja fuera el plan (el sensor quitó su
 * contenedor), «parada: …» la ha parado el sensor y «error…» no funciona;
 * «desplegando…» y «aplicando cambios…» aún no han llegado al sensor. Es la
 * misma expresión que la migración 0012_destinos.
 */
const COLOCACION_DE_ANTES = `CASE
	WHEN NOT "activo" OR "donde" LIKE 'en espera: %' THEN 'por-colocar'
	WHEN ("donde" LIKE 'error%' OR "donde" LIKE 'parada: %') AND "comprobada" IS NOT NULL THEN 'degradada'
	WHEN "donde" LIKE 'error%' OR "donde" LIKE 'parada: %' OR "donde" IN ('desplegando…', 'aplicando cambios…') THEN 'por-colocar'
	WHEN "comprobada" IS NOT NULL THEN 'comprobada'
	ELSE 'colocada' END`;

/**
 * Completa lo que no pudo hacer una consola anterior a la 0012: tras una
 * vuelta atrás, la consola anterior da de alta sensores sin destino y
 * trampas sin destino ni estado de colocación. Se corre al arrancar, después
 * de migrar y de crear el sensor local (que en una instalación nueva recibe
 * aquí su destino). Volver a correrlo no cambia nada.
 *
 * El destino de un sensor toma su id si está libre y, si no, el mismo con
 * sufijo (§5.2). Una trampa sin destino es de la máquina de su sensor; su
 * primer evento y su colocación se calculan como en la migración.
 *
 * @param {import('postgres').Sql} sql
 * @returns {Promise<{ destinos: string[]; trampas: number }>}
 */
export async function completarDestinos(sql) {
	return sql.begin(async (tx) => {
		const sinDestino = await tx`
			select s.id, s.nombre, s.creado from sensores s
			where not exists (select 1 from destinos d where d.sensor = s.id)
			order by s.creado, s.id`;
		/** @type {string[]} */
		const destinos = [];
		for (const sensor of sinDestino) {
			let id = null;
			for (let n = 1; !id && n <= CANDIDATOS; n++) {
				const [f] = await tx`
					insert into destinos (id, nombre, tipo, sensor, creado)
					values (${idDestino(sensor.id, n)}, ${sensor.nombre}, 'maquina', ${sensor.id}, ${sensor.creado})
					on conflict (id) do nothing
					returning id`;
				id = f?.id ?? null;
			}
			if (!id) throw new Error(`no hay un id libre para el destino del sensor ${sensor.id}`);
			destinos.push(id);
		}
		await tx`
			update trampas t set comprobada = p.primero
			from (
				select x.id, min(e.recibido) as primero
				from trampas x
				join eventos e on e.trampa = x.id and e.sensor = x.sensor and e.recibido >= x.creado
				where x.destino is null
				group by x.id
			) p
			where p.id = t.id and t.destino is null and t.comprobada is null`;
		/* Sin «from destinos»: destinos también tiene «activo», y el CASE sería ambiguo. */
		const trampas = await tx.unsafe(`
			update trampas
			set colocacion = ${COLOCACION_DE_ANTES}, colocacion_cuando = now(),
				destino = (select d.id from destinos d where d.sensor = trampas.sensor)
			where destino is null`);
		return { destinos, trampas: trampas.count };
	});
}
