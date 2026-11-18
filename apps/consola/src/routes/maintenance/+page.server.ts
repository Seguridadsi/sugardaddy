import { fail, type Cookies } from '@sveltejs/kit';
import { asc, eq, isNull } from 'drizzle-orm';
import { exigir } from '$lib/server/auth/permisos';
import { puede } from '$lib/permisos';
import { db, schema as s } from '$lib/server/db';
import { horaLocal } from '$lib/server/hora-local';
import {
	DURACIONES,
	TOPE_HORAS,
	crearMantenimiento,
	fijarMaximoHoras,
	maximoHoras,
	nombresObjetivos,
	terminarMantenimiento,
	textoAlcance,
	ventanasTodas,
	type AlcanceMantenimiento
} from '$lib/server/mantenimiento';
import { zonasDe } from '$lib/server/zona-horaria';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALCANCES: AlcanceMantenimiento[] = ['nodo', 'sitios', 'sensores'];

/* Lo que alguien escribe aquí (cuándo empieza) es la hora de su reloj. */
const zonaDe = async (locals: App.Locals, cookies: Cookies) =>
	(await zonasDe(locals.usuario, cookies)).zonaHoraria;

export const load = async ({ locals }) => {
	const ahora = Date.now();
	const ventanas = await ventanasTodas();
	const nombres = await nombresObjetivos(ventanas);
	const maximo = await maximoHoras();
	const roles = locals.usuario?.roles ?? [];
	return {
		ventanas: ventanas.map((v) => ({
			id: v.id,
			nombre: v.nombre,
			alcance: textoAlcance(v, nombres),
			desde: v.desde.toISOString(),
			hasta: v.hasta.toISOString(),
			quien: v.quien,
			cerradaPor: v.cerradaPor,
			nota: v.nota,
			estado:
				v.desde.getTime() > ahora
					? ('programada' as const)
					: v.hasta.getTime() > ahora
						? ('en-curso' as const)
						: ('terminada' as const),
			callados: v.resumen?.callados.length ?? Object.keys(v.callado).length,
			eventos: v.resumen?.eventos ?? null
		})),
		sensores: await db
			.select({ id: s.sensores.id, nombre: s.sensores.nombre })
			.from(s.sensores)
			.where(isNull(s.sensores.retirado))
			.orderBy(asc(s.sensores.nombre)),
		sitios: await db
			.select({ id: s.destinos.id, nombre: s.destinos.nombre, tipo: s.destinos.tipo })
			.from(s.destinos)
			.where(eq(s.destinos.activo, true))
			.orderBy(asc(s.destinos.nombre)),
		duraciones: DURACIONES.filter((h) => h <= maximo),
		maximo,
		tope: TOPE_HORAS,
		puedeProgramar: puede(roles, 'desplegar'),
		/* Todo el nodo calla la salud de todo: eso solo lo decide un administrador. */
		puedeNodo: puede(roles, 'ajustes'),
		puedeAjustar: puede(roles, 'ajustes')
	};
};

export const actions = {
	crear: async ({ request, locals, cookies }) => {
		const u = exigir(locals, 'desplegar');
		const f = await request.formData();
		const alcance = String(f.get('alcance') ?? '') as AlcanceMantenimiento;
		if (!ALCANCES.includes(alcance)) return fail(400, { error: 'Choose what it covers.' });
		if (alcance === 'nodo' && !puede(u.roles, 'ajustes'))
			return fail(403, {
				error:
					'A window for the whole node holds back every health alert: only an administrator can schedule one. Choose sites or sensors.'
			});
		const empieza = String(f.get('empieza') ?? '').trim();
		const desde = empieza ? horaLocal(empieza, await zonaDe(locals, cookies)) : new Date();
		if (!desde) return fail(400, { error: 'Starts: a date and time, or leave empty for now.' });
		const horas = Number(f.get('dura'));
		if (!(DURACIONES as readonly number[]).includes(horas))
			return fail(400, { error: 'Choose how long it lasts.' });
		const objetivos = f
			.getAll(alcance === 'sitios' ? 'sitio' : 'sensor')
			.map(String)
			.filter((x) => x && x.length <= 200);
		const r = await crearMantenimiento(u.correo, {
			nombre: String(f.get('nombre') ?? ''),
			alcance,
			objetivos: alcance === 'nodo' ? [] : objetivos,
			desde,
			hasta: new Date(desde.getTime() + horas * 3_600_000),
			nota: String(f.get('nota') ?? '')
		});
		return r.ok
			? {
					mensaje: empieza
						? 'Maintenance window scheduled. You are alerted when it starts and a summary arrives when it ends.'
						: 'Maintenance window started. A summary arrives when it ends.'
				}
			: fail(400, { error: r.error });
	},
	terminar: async ({ request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const id = String((await request.formData()).get('id') ?? '');
		if (!UUID.test(id)) return fail(400, { error: 'That window does not exist.' });
		const r = await terminarMantenimiento(u.correo, id);
		if (!r) return fail(404, { error: 'That window had already ended.' });
		return {
			mensaje:
				r === 'anulada'
					? 'Window cancelled: it had not started.'
					: 'Window ended: health alerts are back on and its summary is ready.'
		};
	},
	ajustes: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const horas = Number((await request.formData()).get('maximo'));
		if (!(await fijarMaximoHoras(u.correo, horas)))
			return fail(400, { error: `Maximum duration: between 1 and ${TOPE_HORAS} hours.` });
		return { mensaje: `Saved: windows can last up to ${horas} hours.` };
	}
};
