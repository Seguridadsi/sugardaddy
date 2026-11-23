/*
 * El inventario de colocaciones (D7, docs/diseno/inventario-colocaciones.md): cada copia de un
 * cebo puesta en algún sitio, con su ruta exacta, la versión de la plantilla, cuándo se sembró,
 * su caducidad y su rotación, y cómo y cuándo se retiró. Es historia: la fila sobrevive a su
 * trampa y nunca se borra (se va con la conservación de la auditoría, no antes).
 *
 * Quien cambia el estado de una trampa sembrada (alta, «Ya está hecho», retirar, «Ya lo he
 * quitado», un conector que coloca o retira) llama aquí dentro de su misma transacción: la
 * trampa y su inventario no pueden contar cosas distintas.
 *
 * Es de la edición Community: vale para lo que se siembra a mano. Lo que coloca un conector
 * (SharePoint, OneDrive) es de Cloud y vive en conectores/.
 */
import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, lte, ne, notInArray } from 'drizzle-orm';
import type { Honeycosa } from '@sugardaddy/contrato';
import { db, schema as s } from './db';
import type { EstadoColocacion, ReferenciaColocacion } from './db/schema';
import type { Bd, Tx } from './destinos';

/* Las que aún cuentan como puestas o por poner: las demás son historia. */
export const ABIERTAS: readonly EstadoColocacion[] = [
	'pendiente',
	'colocada',
	'retirando',
	'perdida'
];

/* Lo que ve el cliente de cada estado. */
export const ETIQUETA_COLOCACION: Readonly<Record<EstadoColocacion, string>> = {
	pendiente: 'Not placed yet',
	colocada: 'Placed',
	retirando: 'Being removed',
	retirada: 'Removed',
	sustituida: 'Replaced by rotation',
	perdida: 'Missing'
};

/* Por qué se retiró. */
export const RETIRADA_POR: Readonly<Record<string, string>> = {
	manual: 'Removed by a user',
	caducada: 'Expired',
	rotada: 'Rotated',
	'trampa-retirada': 'Its honeypot was removed'
};

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/* placement_id: «col-» y 16 caracteres base32 (80 bits). */
export function idColocacion(): string {
	const b = randomBytes(16);
	let x = '';
	for (let i = 0; i < 16; i++) x += BASE32[b[i] & 31];
	return `col-${x}`;
}

/* «modulo@versionModulo»: con qué versión de la plantilla se acuñó. */
export const versionPlantilla = (h: Pick<Honeycosa, 'id' | 'versionModulo'>) =>
	`${h.id}@${h.versionModulo}`;

/*
 * La ruta exacta de lo sembrado: la «ruta» que se dio al ponerla y, si es una carpeta, el nombre
 * del fichero detrás, con el separador que ya usa (\ en Windows). Sin ruta, lo que haya; sin
 * nada, «(not recorded)», que es lo que deja también la migración de las de antes.
 */
export function ubicacionDe(parametros: Record<string, unknown>, nombre?: string | null): string {
	const ruta = typeof parametros.ruta === 'string' ? parametros.ruta.trim() : '';
	if (!ruta) return nombre ? nombre : '(not recorded)';
	if (!nombre || ruta.endsWith(nombre)) return ruta;
	const sep = ruta.includes('\\') && !ruta.startsWith('http') ? '\\' : '/';
	return ruta.replace(/[\\/]+$/, '') + sep + nombre;
}

/*
 * Abre la colocación de una trampa recién dada de alta (o la de una rotación, con
 * «sustituye»). Copia el nombre, el módulo y el destino: la fila sigue diciendo qué hubo
 * aunque la trampa se retire.
 */
export async function abrirColocacion(
	tx: Bd,
	v: {
		trampa: { id: string; nombre: string; modulo: string; via: string; ejecutor: string };
		destino: { id: string; nombre: string } | null;
		honeycosa?: Pick<Honeycosa, 'id' | 'versionModulo'>;
		ubicacion: string;
		baliza?: { token: string; sha256?: string | null } | null;
		estado?: 'pendiente' | 'colocada';
		referencia?: ReferenciaColocacion | null;
		sustituye?: string | null;
		ahora?: Date;
	}
): Promise<string> {
	const id = idColocacion();
	const estado = v.estado ?? 'pendiente';
	await tx.insert(s.colocaciones).values({
		id,
		trampa: v.trampa.id,
		trampaNombre: v.trampa.nombre,
		modulo: v.trampa.modulo,
		destino: v.destino?.id ?? null,
		destinoNombre: v.destino?.nombre ?? null,
		baliza: v.baliza?.token ?? null,
		via: v.trampa.via,
		ejecutor: v.trampa.ejecutor,
		ubicacion: v.ubicacion.slice(0, 1000),
		referencia: v.referencia ?? null,
		plantillaVersion: v.honeycosa ? versionPlantilla(v.honeycosa) : null,
		sha256: v.baliza?.sha256 ?? null,
		estado,
		sembrada: estado === 'colocada' ? (v.ahora ?? new Date()) : null,
		vista: estado === 'colocada' ? (v.ahora ?? new Date()) : null,
		sustituye: v.sustituye ?? null
	});
	return id;
}

/* Las abiertas de una trampa: casi siempre una. */
const deTrampa = (trampa: string) =>
	and(eq(s.colocaciones.trampa, trampa), inArray(s.colocaciones.estado, [...ABIERTAS]));

/* «Ya está hecho» o un conector que ya la ha subido: la pendiente pasa a colocada. */
export async function marcarColocada(
	tx: Bd,
	trampa: string,
	v: { referencia?: ReferenciaColocacion; ubicacion?: string; ahora?: Date } = {}
): Promise<void> {
	const ahora = v.ahora ?? new Date();
	await tx
		.update(s.colocaciones)
		.set({
			estado: 'colocada',
			motivo: null,
			sembrada: ahora,
			vista: ahora,
			...(v.referencia ? { referencia: v.referencia } : {}),
			...(v.ubicacion ? { ubicacion: v.ubicacion.slice(0, 1000) } : {})
		})
		.where(and(eq(s.colocaciones.trampa, trampa), eq(s.colocaciones.estado, 'pendiente')));
}

/* Retirada confirmada (manual@1): hasta que alguien diga que ya no está, «retirando». */
export async function marcarRetirando(tx: Bd, trampa: string): Promise<void> {
	await tx
		.update(s.colocaciones)
		.set({ estado: 'retirando' })
		.where(
			and(
				eq(s.colocaciones.trampa, trampa),
				inArray(s.colocaciones.estado, ['pendiente', 'colocada', 'perdida'])
			)
		);
}

/* Ya no está: se cierra con quién o qué la retiró. Antes de borrar la trampa. */
export async function marcarRetirada(
	tx: Bd,
	trampa: string,
	por: keyof typeof RETIRADA_POR,
	ahora = new Date()
): Promise<void> {
	await tx
		.update(s.colocaciones)
		.set({ estado: 'retirada', retirada: ahora, retiradaPor: por })
		.where(deTrampa(trampa));
}

/* Un conector ha visto que lo colocado ya no está, o que ha vuelto. */
export async function marcarVista(
	tx: Bd,
	id: string,
	v: { esta: boolean; motivo?: string | null; ahora?: Date }
): Promise<void> {
	await tx
		.update(s.colocaciones)
		.set(
			v.esta
				? { estado: 'colocada', motivo: null, vista: v.ahora ?? new Date() }
				: { estado: 'perdida', motivo: v.motivo ?? 'colocacion.perdida' }
		)
		.where(and(eq(s.colocaciones.id, id), inArray(s.colocaciones.estado, ['colocada', 'perdida'])));
}

/* Rotar: la vieja queda sustituida (retirada por «rotada») y la nueva la nombra. */
export async function marcarSustituida(tx: Bd, id: string, ahora = new Date()): Promise<void> {
	await tx
		.update(s.colocaciones)
		.set({ estado: 'sustituida', retirada: ahora, retiradaPor: 'rotada' })
		.where(eq(s.colocaciones.id, id));
}

/*
 * Mientras está por poner se puede cambiar de datos o de sitio, y una puesta se puede mover
 * de destino (está en otra máquina): el inventario lo sigue en sus abiertas.
 */
export async function actualizarPendiente(
	tx: Bd,
	trampa: string,
	v: { nombre?: string; ubicacion?: string; destino?: { id: string; nombre: string } }
): Promise<void> {
	const cambios = {
		...(v.nombre ? { trampaNombre: v.nombre } : {}),
		...(v.ubicacion ? { ubicacion: v.ubicacion.slice(0, 1000) } : {}),
		...(v.destino ? { destino: v.destino.id, destinoNombre: v.destino.nombre } : {})
	};
	if (!Object.keys(cambios).length) return;
	await tx.update(s.colocaciones).set(cambios).where(deTrampa(trampa));
}

/*
 * Lo que toca hacer con una colocación según la política de su trampa: caducada (pasó
 * «caduca») o con la rotación vencida (sembrada hace rotar_dias o más). Puro.
 */
export function vencimientos(
	c: { estado: string; sembrada: Date | null },
	p: { caduca: Date | null; rotarDias: number | null },
	ahora = new Date()
): { caducada: boolean; rotarEl: Date | null; rotacionVencida: boolean } {
	const puesta = c.estado === 'colocada' || c.estado === 'perdida';
	const caducada = puesta && !!p.caduca && p.caduca.getTime() <= ahora.getTime();
	const rotarEl =
		puesta && c.sembrada && p.rotarDias
			? new Date(c.sembrada.getTime() + p.rotarDias * 86_400_000)
			: null;
	return { caducada, rotarEl, rotacionVencida: !!rotarEl && rotarEl.getTime() <= ahora.getTime() };
}

/*
 * La política que se escribe en la ficha (pestaña Placement): la fecha de caducidad
 * (AAAA-MM-DD, el final de ese día en UTC; vacía = no caduca) y cada cuántos días rota
 * (1 a 3650; vacío = no rota). Puro.
 */
export function leerPolitica(
	f: FormData,
	ahora = new Date()
): { ok: true; caduca: Date | null; rotarDias: number | null } | { ok: false; error: string } {
	const fecha = String(f.get('caduca') ?? '').trim();
	const dias = String(f.get('rotarDias') ?? '').trim();
	let caduca: Date | null = null;
	if (fecha) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha))
			return { ok: false, error: 'Expiry date: use the format YYYY-MM-DD.' };
		caduca = new Date(`${fecha}T23:59:59.000Z`);
		if (Number.isNaN(caduca.getTime()) || caduca.toISOString().slice(0, 10) !== fecha)
			return { ok: false, error: 'Expiry date: that date does not exist.' };
		if (caduca.getTime() <= ahora.getTime())
			return { ok: false, error: 'Expiry date: it has to be in the future.' };
	}
	let rotarDias: number | null = null;
	if (dias) {
		if (!/^\d{1,4}$/.test(dias) || Number(dias) < 1 || Number(dias) > 3650)
			return { ok: false, error: 'Rotation: a number of days between 1 and 3650.' };
		rotarDias = Number(dias);
	}
	return { ok: true, caduca, rotarDias };
}

/* Fija la política de una trampa sembrada, con su línea en la auditoría. */
export async function fijarPolitica(
	quien: string,
	trampa: string,
	p: { caduca: Date | null; rotarDias: number | null }
): Promise<'hecho' | 'no-existe' | 'contenedor'> {
	return db.transaction(async (tx: Tx) => {
		const [t] = await tx
			.select({
				id: s.trampas.id,
				tipo: s.trampas.tipo,
				caduca: s.trampas.caduca,
				rotarDias: s.trampas.rotarDias
			})
			.from(s.trampas)
			.where(eq(s.trampas.id, trampa))
			.for('update');
		if (!t) return 'no-existe';
		if (t.tipo === 'contenedor') return 'contenedor';
		await tx.update(s.trampas).set(p).where(eq(s.trampas.id, trampa));
		await tx.insert(s.auditoria).values({
			quien,
			accion: 'decoy placement policy changed',
			detalle: {
				id: trampa,
				caduca: p.caduca?.toISOString() ?? null,
				rotarDias: p.rotarDias,
				antes: { caduca: t.caduca?.toISOString() ?? null, rotarDias: t.rotarDias }
			}
		});
		return 'hecho';
	});
}

export type FilaInventario = {
	id: string;
	trampa: string | null;
	trampaNombre: string;
	modulo: string;
	destino: string | null;
	destinoNombre: string | null;
	ejecutor: string;
	ubicacion: string;
	web: string | null;
	plantillaVersion: string | null;
	estado: EstadoColocacion;
	etiqueta: string;
	motivo: string | null;
	sembrada: string | null;
	vista: string | null;
	caduca: string | null;
	rotarDias: number | null;
	rotarEl: string | null;
	caducada: boolean;
	rotacionVencida: boolean;
	sustituye: string | null;
	retirada: string | null;
	retiradaPor: string | null;
};

/*
 * El inventario para la pestaña Placements: primero las abiertas y después la historia,
 * cada grupo de la más nueva a la más vieja. Con la política de su trampa (si sigue).
 * historia: cuántas cerradas como mucho (las abiertas van todas).
 */
export async function inventario(
	v: { trampa?: string; historia?: number } = {},
	bd: Bd = db,
	ahora = new Date()
): Promise<FilaInventario[]> {
	const filtro = v.trampa ? eq(s.colocaciones.trampa, v.trampa) : undefined;
	const columnas = {
		c: s.colocaciones,
		caduca: s.trampas.caduca,
		rotarDias: s.trampas.rotarDias
	};
	const abiertas = await bd
		.select(columnas)
		.from(s.colocaciones)
		.leftJoin(s.trampas, eq(s.trampas.id, s.colocaciones.trampa))
		.where(and(filtro, inArray(s.colocaciones.estado, [...ABIERTAS])))
		.orderBy(desc(s.colocaciones.creado));
	const cerradas = await bd
		.select(columnas)
		.from(s.colocaciones)
		.leftJoin(s.trampas, eq(s.trampas.id, s.colocaciones.trampa))
		.where(and(filtro, notInArray(s.colocaciones.estado, [...ABIERTAS])))
		.orderBy(desc(s.colocaciones.retirada), desc(s.colocaciones.creado))
		.limit(v.historia ?? 500);
	return [...abiertas, ...cerradas].map(({ c, caduca, rotarDias }) => {
		const venc = vencimientos(c, { caduca: caduca ?? null, rotarDias: rotarDias ?? null }, ahora);
		return {
			id: c.id,
			trampa: c.trampa,
			trampaNombre: c.trampaNombre,
			modulo: c.modulo,
			destino: c.destino,
			destinoNombre: c.destinoNombre,
			ejecutor: c.ejecutor,
			ubicacion: c.ubicacion,
			web: c.referencia?.web ?? null,
			plantillaVersion: c.plantillaVersion,
			estado: c.estado,
			etiqueta: ETIQUETA_COLOCACION[c.estado] ?? c.estado,
			motivo: c.motivo,
			sembrada: c.sembrada?.toISOString() ?? null,
			vista: c.vista?.toISOString() ?? null,
			caduca: caduca?.toISOString() ?? null,
			rotarDias: rotarDias ?? null,
			rotarEl: venc.rotarEl?.toISOString() ?? null,
			caducada: venc.caducada,
			rotacionVencida: venc.rotacionVencida,
			sustituye: c.sustituye,
			retirada: c.retirada?.toISOString() ?? null,
			retiradaPor: c.retiradaPor ? (RETIRADA_POR[c.retiradaPor] ?? c.retiradaPor) : null
		};
	});
}

/* Las trampas con la caducidad pasada, para retirarlas (vigilarColocaciones). */
export async function trampasCaducadas(bd: Bd = db, ahora = new Date()) {
	return bd
		.select({ id: s.trampas.id, ejecutor: s.trampas.ejecutor, colocacion: s.trampas.colocacion })
		.from(s.trampas)
		.where(and(lte(s.trampas.caduca, ahora), ne(s.trampas.colocacion, 'retirando')));
}
