/*
 * Gestión del día a día del nodo: sensores, estado de las trampas y lectura
 * de la auditoría. Toda escritura deja su línea en auditoría, en la misma
 * transacción.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { EJECUTORES } from '@sugardaddy/contrato';
import { avisosSensor, resumenMotor } from '$lib/capacidades';
import { trasHecho, trasParar, trasQuitado, trasRetirar } from './colocacion';
import { db, schema as s } from './db';
import { insertarDestino, type Tx } from './destinos';

const LATIDO_MAXIMO = 5 * 60_000;
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export async function sensores() {
	const ahora = Date.now();
	const filas = await db
		.select({
			id: s.sensores.id,
			nombre: s.sensores.nombre,
			red: s.sensores.red,
			vlan: s.sensores.vlan,
			ultimoLatido: s.sensores.ultimoLatido,
			remoto: s.sensores.remoto,
			version: s.sensores.version,
			configuracion: s.sensores.configuracion,
			registroPrivado: s.sensores.registroPrivado,
			capacidades: s.sensores.capacidades,
			/*
			 * "sensores"."id" con su tabla: en una consulta de una sola tabla,
			 * drizzle escribe ${s.sensores.id} como "id" a secas, y dentro de la
			 * subconsulta sería el id de la otra tabla.
			 */
			trampas: sql<number>`(select count(*)::int from ${s.trampas} x where x.sensor = "sensores"."id")`,
			cuarentena: sql<number>`(select count(*)::int from ${s.cuarentena} q where q.sensor = "sensores"."id")`,
			rupturas: sql<number>`(select count(*)::int from ${s.rupturas} r where r.sensor = "sensores"."id")`
		})
		.from(s.sensores)
		.orderBy(s.sensores.creado);
	/* Del motor y los hechos que cuenta el sensor, solo lo que se enseña. */
	return filas.map(({ capacidades, ...f }) => ({
		...f,
		ultimoLatido: f.ultimoLatido?.toISOString() ?? null,
		vivo: !!f.ultimoLatido && ahora - f.ultimoLatido.getTime() < LATIDO_MAXIMO,
		motor: resumenMotor(capacidades?.motor),
		avisos: avisosSensor(capacidades)
	}));
}

/*
 * «Instalar un sensor aquí» en un destino que ya no puede recibirlo: no
 * existe, se ha dado de baja o ya tiene sensor (quizá otra persona acaba de
 * instalarle uno).
 */
export class DestinoNoDisponible extends Error {
	constructor() {
		super('Ese destino ya tiene un sensor o se ha dado de baja. Recarga la página.');
	}
}

/*
 * El token se enseña una vez y no se guarda: solo su hash. El sensor nace
 * con su destino, en la misma transacción: uno nuevo, una máquina con el id
 * del sensor (o con sufijo, si ese id ya es de otro destino) o, con
 * «destino», ese destino sin sensor («Instalar un sensor aquí»), sin crear
 * otro. null: ya hay un sensor con ese id.
 */
export async function crearSensor(
	quien: string,
	v: { id: string; nombre: string; red: string | null; vlan: number | null; remoto?: boolean },
	destino?: string
) {
	const token = randomBytes(32).toString('base64url');
	return db.transaction(async (tx) => {
		const [f] = await tx
			.insert(s.sensores)
			.values({ ...v, claveHash: hashToken(token) })
			.onConflictDoNothing()
			.returning();
		if (!f) return null;
		let d: string;
		if (destino) {
			const [x] = await tx
				.update(s.destinos)
				.set({ sensor: v.id })
				.where(
					and(eq(s.destinos.id, destino), isNull(s.destinos.sensor), eq(s.destinos.activo, true))
				)
				.returning({ id: s.destinos.id });
			if (!x) throw new DestinoNoDisponible();
			d = x.id;
		} else
			d = await insertarDestino(tx, {
				base: v.id,
				nombre: v.nombre,
				tipo: 'maquina',
				sensor: v.id
			});
		await tx
			.insert(s.auditoria)
			.values({ quien, accion: 'sensor dado de alta', detalle: { ...v, destino: d } });
		return token;
	});
}

/* La red y la VLAN de un sensor, cuando se indican o cambian. false si no existe. */
export async function cambiarRed(
	quien: string,
	id: string,
	v: { red: string | null; vlan: number | null }
) {
	return db.transaction(async (tx) => {
		const [f] = await tx
			.update(s.sensores)
			.set(v)
			.where(eq(s.sensores.id, id))
			.returning({ id: s.sensores.id });
		if (!f) return false;
		await tx
			.insert(s.auditoria)
			.values({ quien, accion: 'red del sensor cambiada', detalle: { id, ...v } });
		return true;
	});
}

/*
 * La red y la VLAN que detectó el instalador en la máquina de un sensor: solo
 * si aún no tiene ninguna (lo escrito en Sensores manda). false si no se guarda.
 */
export async function redDetectada(id: string, v: { red: string | null; vlan: number | null }) {
	if (!v.red && !v.vlan) return false;
	return db.transaction(async (tx) => {
		const [f] = await tx
			.update(s.sensores)
			.set(v)
			.where(and(eq(s.sensores.id, id), isNull(s.sensores.red), isNull(s.sensores.vlan)))
			.returning({ id: s.sensores.id });
		if (!f) return false;
		await tx
			.insert(s.auditoria)
			.values({ quien: `sensor ${id}`, accion: 'red del sensor detectada', detalle: { id, ...v } });
		return true;
	});
}

/* Un token nuevo invalida el anterior al instante: para cuando se sospecha que se ha filtrado. */
export async function regenerarToken(quien: string, id: string) {
	const token = randomBytes(32).toString('base64url');
	return db.transaction(async (tx) => {
		const [f] = await tx
			.update(s.sensores)
			.set({ claveHash: hashToken(token) })
			.where(eq(s.sensores.id, id))
			.returning();
		if (!f) return null;
		await tx
			.insert(s.auditoria)
			.values({ quien, accion: 'token de sensor regenerado', detalle: { id } });
		return token;
	});
}

/*
 * Solo se retira un sensor sin trampas: primero se retiran ellas, para que no
 * queden contenedores huérfanos. Cuentan las de contenedor y también las
 * manuales cuya señal recibe (trampas.sensor).
 */
export async function retirarSensor(quien: string, id: string) {
	return db.transaction(async (tx) => {
		const [{ n }] = await tx
			.select({ n: sql<number>`count(*)::int` })
			.from(s.trampas)
			.where(eq(s.trampas.sensor, id));
		if (n > 0) return 'tiene trampas';
		/* Lo que entregó, también en cuarentena o como ruptura, es historia de su cadena. */
		const [{ e }] = await tx
			.select({
				e: sql<number>`(select count(*) from ${s.eventos} where ${s.eventos.sensor} = ${id})
					+ (select count(*) from ${s.cuarentena} where ${s.cuarentena.sensor} = ${id})
					+ (select count(*) from ${s.rupturas} where ${s.rupturas.sensor} = ${id})`.mapWith(Number)
			})
			.from(sql`(select 1) as uno`);
		/*
		 * Con eventos registrados no se borra: la cadena de eventos tiene que
		 * seguir verificable. Se le invalida el token. Su destino se queda con
		 * él, igual que el sensor sigue en Sensores: si se borrara, el arranque
		 * se lo volvería a crear (un sensor sin destino es uno que dio de alta
		 * una consola anterior), y si se reinstala, sigue valiendo.
		 */
		if (e > 0) {
			await tx
				.update(s.sensores)
				.set({ claveHash: hashToken(randomBytes(32).toString('base64url')) })
				.where(eq(s.sensores.id, id));
			await tx.insert(s.auditoria).values({ quien, accion: 'sensor desactivado', detalle: { id } });
			return 'desactivado';
		}
		/*
		 * Su destino se borra, salvo que tenga trampas (manuales, con la señal en
		 * otro sensor): entonces se queda sin sensor, con ellas. Bloqueado antes
		 * de contar, para que no entre una trampa entre la cuenta y el borrado.
		 */
		const [d] = await tx
			.select({ id: s.destinos.id })
			.from(s.destinos)
			.where(eq(s.destinos.sensor, id))
			.for('update');
		let destinoQueda = false;
		if (d) {
			const [{ t }] = await tx
				.select({ t: sql<number>`count(*)::int` })
				.from(s.trampas)
				.where(eq(s.trampas.destino, d.id));
			destinoQueda = t > 0;
			if (destinoQueda)
				await tx.update(s.destinos).set({ sensor: null }).where(eq(s.destinos.id, d.id));
			else await tx.delete(s.destinos).where(eq(s.destinos.id, d.id));
		}
		await tx.delete(s.instaladoresSensor).where(eq(s.instaladoresSensor.sensor, id));
		await tx.delete(s.sensores).where(eq(s.sensores.id, id));
		await tx.insert(s.auditoria).values({
			quien,
			accion: 'sensor retirado',
			detalle: { id, ...(d ? { destino: d.id, destinoQueda } : {}) }
		});
		return 'retirado';
	});
}

/*
 * Parar o reanudar una trampa. El sensor lo aplica en su siguiente consulta
 * del plan: una trampa parada sale del plan y su contenedor se retira, así
 * que queda por colocar (§8.1). Al reanudarla vuelve al plan y la deja puesta
 * el primer estado limpio de su sensor. Solo se para lo que su ejecutor sabe
 * pausar (contenedor@1): lo sembrado a mano en una máquina no se pausa
 * (§6.3), se retira. Tampoco se para una trampa que recibe la señal de otras
 * (§8.4): su contenedor desaparecería y lo sembrado que apunta a ella dejaría
 * de avisar. Devuelve los nombres de esas otras.
 */
export async function cambiarTrampa(
	quien: string,
	id: string,
	activo: boolean
): Promise<'hecho' | 'no-existe' | 'no-se-para' | { dependientes: string[] }> {
	return db.transaction(async (tx) => {
		/* Bloqueada: dar de alta una que apunte a esta espera a que acabe, y al revés. */
		const [f] = await tx.select().from(s.trampas).where(eq(s.trampas.id, id)).for('update');
		if (!f) return 'no-existe';
		if (!activo && !EJECUTORES[f.ejecutor]?.pausable) return 'no-se-para';
		if (!activo) {
			const dependientes = await dependientesDeTrampa(tx, id);
			if (dependientes.length) return { dependientes };
		}
		await tx
			.update(s.trampas)
			.set({ activo, ...(activo ? {} : trasParar(f, new Date())) })
			.where(eq(s.trampas.id, id));
		await tx
			.insert(s.auditoria)
			.values({ quien, accion: activo ? 'trampa reanudada' : 'trampa parada', detalle: { id } });
		return 'hecho';
	});
}

/* Las que reciben su señal de esta (senal_trampa), por nombre: lo sembrado que apunta a ella. */
async function dependientesDeTrampa(tx: Tx, id: string) {
	const filas = await tx
		.select({ nombre: s.trampas.nombre })
		.from(s.trampas)
		.where(eq(s.trampas.senalTrampa, id))
		.orderBy(asc(s.trampas.nombre));
	return filas.map((x) => x.nombre);
}

/* La huella de los pasos de una trampa a mano, para la auditoría. */
const huella = (f: typeof s.trampas.$inferSelect) => (f.manual ? { pasos: f.manual.sha256 } : {});

/* Borra la trampa y lo deja en la auditoría: sus eventos se quedan, que son historia. */
async function borrarTrampa(tx: Tx, quien: string, f: typeof s.trampas.$inferSelect) {
	await tx.delete(s.trampas).where(eq(s.trampas.id, f.id));
	await tx.insert(s.auditoria).values({
		quien,
		accion: 'trampa retirada',
		detalle: { id: f.id, modulo: f.modulo, sensor: f.sensor, destino: f.destino, ...huella(f) }
	});
}

/*
 * Retirar (§8.1, §8.4). Con retirada automática (contenedor@1), se borra la
 * fila y el sensor quita el contenedor en su siguiente plan; sus eventos se
 * quedan, que son historia y forman parte de la cadena. Con retirada
 * confirmada (manual@1), queda «retirando» con los pasos de retirada que se
 * guardaron al generarla, hasta que alguien diga que ya la ha quitado
 * (trampaQuitada). No se retira una trampa que recibe la señal de otras (las
 * que la tienen en senal_trampa): lo sembrado que apunta a ella dejaría de
 * avisar. Devuelve los nombres de esas otras, para decir cuáles retirar
 * primero.
 */
export async function retirarTrampa(
	quien: string,
	id: string
): Promise<'retirada' | 'retirando' | 'no-existe' | { dependientes: string[] }> {
	return db.transaction(async (tx) => {
		/* Bloqueada: dar de alta una que apunte a esta espera a que acabe, y al revés. */
		const [f] = await tx.select().from(s.trampas).where(eq(s.trampas.id, id)).for('update');
		if (!f) return 'no-existe';
		const dependientes = await dependientesDeTrampa(tx, id);
		if (dependientes.length) return { dependientes };
		const retirada =
			EJECUTORES[f.ejecutor]?.retirada === 'confirmada' ? 'confirmada' : 'automatica';
		const r = trasRetirar(f, retirada, new Date());
		if (r === 'borrar') {
			await borrarTrampa(tx, quien, f);
			return 'retirada';
		}
		if (Object.keys(r).length) {
			await tx.update(s.trampas).set(r).where(eq(s.trampas.id, id));
			await tx.insert(s.auditoria).values({
				quien,
				accion: 'trampa en retirada',
				detalle: { id, modulo: f.modulo, destino: f.destino, ...huella(f) }
			});
		}
		return 'retirando';
	});
}

/*
 * «Ya lo he quitado» (manual@1): quien ha seguido los pasos de retirada dice
 * que ya no queda nada en el destino. Solo desde «retirando»; entonces se
 * borra la fila, como al retirar una de contenedor.
 */
export async function trampaQuitada(
	quien: string,
	id: string
): Promise<'retirada' | 'no-existe' | 'no-retirando' | { dependientes: string[] }> {
	return db.transaction(async (tx) => {
		const [f] = await tx.select().from(s.trampas).where(eq(s.trampas.id, id)).for('update');
		if (!f) return 'no-existe';
		if (trasQuitado(f) !== 'borrar') return 'no-retirando';
		const dependientes = await dependientesDeTrampa(tx, id);
		if (dependientes.length) return { dependientes };
		await borrarTrampa(tx, quien, f);
		return 'retirada';
	});
}

/*
 * «Ya está hecho» (manual@1): quien ha seguido los pasos dice que está
 * puesta. Queda en la auditoría quién lo dijo y cuándo (la hora de la línea),
 * con la huella de los pasos que siguió. Solo con pasos guardados y desde
 * «por colocar»: una ya puesta, o retirándose, no vuelve atrás.
 */
export async function trampaHecha(
	quien: string,
	id: string
): Promise<'puesta' | 'no-existe' | 'sin-pasos' | 'no-por-colocar'> {
	return db.transaction(async (tx) => {
		const [f] = await tx.select().from(s.trampas).where(eq(s.trampas.id, id)).for('update');
		if (!f) return 'no-existe';
		if (EJECUTORES[f.ejecutor]?.corre !== 'consola' || !f.manual) return 'sin-pasos';
		const c = trasHecho(f, new Date());
		if (!c) return 'no-por-colocar';
		await tx.update(s.trampas).set(c).where(eq(s.trampas.id, id));
		await tx.insert(s.auditoria).values({
			quien,
			accion: 'trampa puesta a mano',
			detalle: { id, nombre: f.nombre, destino: f.destino, ...huella(f) }
		});
		return 'puesta';
	});
}

export async function auditoria(filtro: string, limite = 300) {
	const f = filtro.trim().replace(/[%_\\]/g, '');
	const filas = await db
		.select()
		.from(s.auditoria)
		.where(
			f
				? or(
						ilike(s.auditoria.quien, `%${f}%`),
						ilike(s.auditoria.accion, `%${f}%`),
						sql`${s.auditoria.detalle}::text ilike ${'%' + f + '%'}`
					)
				: undefined
		)
		.orderBy(desc(s.auditoria.id))
		.limit(limite);
	return filas.map((a) => ({ ...a, cuando: a.cuando.toISOString() }));
}

/* Lo último que no pudo guardarse como evento, para revisarlo. */
export async function ultimaCuarentena(limite = 30) {
	const filas = await db
		.select()
		.from(s.cuarentena)
		.orderBy(desc(s.cuarentena.recibido))
		.limit(limite);
	return filas.map((f) => ({
		id: f.id,
		sensor: f.sensor,
		motivo: f.motivo,
		linea: f.linea.slice(0, 4000),
		recibido: f.recibido.toISOString()
	}));
}
