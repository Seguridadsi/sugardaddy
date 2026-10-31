import { fail } from '@sveltejs/kit';
import { rango } from '@sugardaddy/canal';
import { exigir } from '$lib/server/auth/permisos';
import { puede } from '$lib/permisos';
import {
	ESTADOS_TRIAJE,
	borrarReglaTriaje,
	cambiarActivaReglaTriaje,
	crearReglaTriaje,
	nombresTrampas,
	reglasTriaje,
	type EstadoTriaje
} from '$lib/server/consultas';
import { CRITERIOS_TRIAJE, type CriterioTriaje } from '$lib/server/triaje-auto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* El valor de una regla, validado según su criterio. Devuelve el error o null. */
function valorMal(criterio: CriterioTriaje, valor: string, trampas: Record<string, string>): string | null {
	const v = valor.trim();
	if (!v) return 'Pon un valor para la regla.';
	if (v.length > 200) return 'El valor es demasiado largo.';
	if (criterio === 'ip' && !rango(v)) return 'Pon una IP (10.0.0.5) o un rango CIDR (10.0.0.0/24).';
	if (criterio === 'trampa' && !trampas[v]) return 'Esa trampa no existe.';
	return null;
}

export const load = async ({ url, locals }) => {
	const nombres = await nombresTrampas();
	/* Prefill del formulario cuando se llega desde un perfil de IP o de usuario
	 * («Crear regla para…»): se valida igual que al enviar; un valor raro se ignora. */
	const criterioPedido = url.searchParams.get('criterio') ?? '';
	const criterio = (CRITERIOS_TRIAJE as readonly string[]).includes(criterioPedido)
		? (criterioPedido as CriterioTriaje)
		: 'ip';
	const valor = (url.searchParams.get('valor') ?? '').trim().slice(0, 200);
	return {
		reglas: await reglasTriaje(),
		nombres,
		trampas: Object.entries(nombres).map(([id, nombre]) => ({ id, nombre })),
		criterios: CRITERIOS_TRIAJE,
		estados: ESTADOS_TRIAJE,
		/* El valor de trampa solo se prefilla si existe esa trampa. */
		prefill: { criterio, valor: criterio === 'trampa' && !nombres[valor] ? '' : valor },
		/* La gestión es de operador; a un lector se le enseña la lista, pero no los controles. */
		puedeEditar: !!locals.usuario && puede(locals.usuario.roles, 'desplegar')
	};
};

export const actions = {
	crear: async ({ request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const f = await request.formData();
		const criterio = String(f.get('criterio') ?? '');
		const valor = String(f.get('valor') ?? '');
		const estado = String(f.get('estado') ?? '');
		const nota = String(f.get('nota') ?? '');
		if (!(CRITERIOS_TRIAJE as readonly string[]).includes(criterio))
			return fail(400, { error: 'Criterio no válido.' });
		if (!(ESTADOS_TRIAJE as readonly string[]).includes(estado))
			return fail(400, { error: 'Estado no válido.' });
		const nombres = await nombresTrampas();
		const mal = valorMal(criterio as CriterioTriaje, valor, nombres);
		if (mal) return fail(400, { error: mal });
		await crearReglaTriaje(u.correo, {
			criterio: criterio as CriterioTriaje,
			valor,
			estado: estado as EstadoTriaje,
			nota: nota || null
		});
		return { mensaje: 'Regla creada. Se aplicará a los eventos nuevos.' };
	},
	cambiarActiva: async ({ request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const f = await request.formData();
		const id = String(f.get('id') ?? '');
		const activa = f.get('activa') === 'true';
		if (!UUID.test(id)) return fail(400, { error: 'Regla no válida.' });
		const ok = await cambiarActivaReglaTriaje(u.correo, id, activa);
		if (!ok) return fail(404, { error: 'Esa regla ya no existe.' });
		return { mensaje: activa ? 'Regla activada.' : 'Regla desactivada.' };
	},
	borrar: async ({ request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const id = String((await request.formData()).get('id') ?? '');
		if (!UUID.test(id)) return fail(400, { error: 'Regla no válida.' });
		const ok = await borrarReglaTriaje(u.correo, id);
		if (!ok) return fail(404, { error: 'Esa regla ya no existe.' });
		return { mensaje: 'Regla borrada. Los triajes que ya puso se quedan.' };
	}
};
