import { error, fail, redirect } from '@sveltejs/kit';
import { proyectarParaSensor, validarParametros, viaDe } from '@sugardaddy/contrato';
import { recibeSenalDe } from '$lib/formato';
import { avisosDeTrampa, modificarConElector, regenerarPasos } from '$lib/server/alta';
import { exigir } from '$lib/server/auth/permisos';
import { trampasAutorizadas } from '$lib/server/catalogo';
import { estadosVisibles } from '$lib/server/colocacion';
import { trampa } from '$lib/server/consultas';
import { destinoDeTrampa, trampasDelCliente } from '$lib/server/destinos';
import { retirarTrampa, trampaHecha, trampaQuitada } from '$lib/server/gestion';
import { fichaDePasos, opcionesDeObjetivo } from '$lib/server/pasos';
import { abrirPrueba, normalizarIp, pruebaDeTrampa } from '$lib/server/pruebas';

/*
 * Una trampa. Las de contenedor@1 son sus ajustes: el manifiesto v1 de su vía,
 * el que recibe su sensor, y sus parámetros, que se cambian aquí. Las de
 * manual@1 son su ficha de pasos (docs/diseno/modulo-despliegue.md §6.3): el
 * bloque de variables, los pasos de colocar y de retirar tal como se
 * guardaron, sus descargas, «Ya está hecho», «Retirar» y «Ya lo he quitado».
 * Mientras no está puesta, sus datos se cambian y sus pasos se vuelven a
 * generar; puesta, ya no: se retira y se pone otra.
 *
 * Las dos tienen «Probar» (§8.3): unos pasos que provocan un evento, y la
 * consola espera unos minutos a que llegue para darla por comprobada.
 */
async function cargarContenedor(id: string) {
	const t = await trampa(id);
	if (!t) error(404, 'Esa trampa no existe.');
	const h = (await trampasAutorizadas()).find((x) => x.id === t.modulo);
	if (!h) error(404, 'El módulo de esta trampa ya no está autorizado para este cliente.');
	const via = t.ejecutor === 'contenedor@1' ? viaDe(h, t.via) : undefined;
	if (via?.ejecutor !== 'contenedor@1')
		error(404, 'Esta trampa no se modifica desde aquí: retírala y vuelve a ponerla.');
	return { t, h, m: proyectarParaSensor(h, via.id) };
}

/*
 * La IP del navegador tal como la ve la consola (detrás de Caddy, la que este
 * pone en X-Forwarded-For: ADDRESS_HEADER en el compose del nodo). Es la que
 * propone «Probar» cuando la prueba no tiene marca. null si no se sabe.
 */
function ipDelNavegador(getClientAddress: () => string): string | null {
	try {
		return normalizarIp(getClientAddress());
	} catch {
		return null;
	}
}

export const load = async ({ params, getClientAddress }) => {
	const t = await trampa(params.id);
	if (!t) error(404, 'Esa trampa no existe.');
	/* Lo que ve el cliente de ella (§8.2): comprobada, puesta, degradada… y por qué. */
	const estado = (await estadosVisibles()).get(t.id) ?? null;
	/* «Probar» (§8.3): si se puede y cómo, y la última prueba con sus pasos. */
	const prueba = {
		...(await pruebaDeTrampa(t, estado)),
		ipNavegador: ipDelNavegador(getClientAddress)
	};
	if (t.ejecutor === 'manual@1') {
		const destino = await destinoDeTrampa(t);
		const objetivo = t.senalTrampa ? await trampa(t.senalTrampa) : null;
		/* Por colocar, con su módulo y su vía: sus datos se pueden cambiar. */
		const h = (await trampasAutorizadas()).find((x) => x.id === t.modulo);
		const cambiable = t.colocacion === 'por-colocar' && h && viaDe(h, t.via);
		const p = cambiable ? validarParametros(h.parametros, t.parametros) : null;
		return {
			tipo: 'manual' as const,
			trampa: { id: t.id, nombre: t.nombre, colocacion: t.colocacion, modulo: t.modulo },
			estado,
			prueba,
			destino: destino && { id: destino.id, nombre: destino.nombre },
			objetivo: objetivo && { id: objetivo.id, nombre: objetivo.nombre },
			pasos: t.manual ? fichaDePasos(t.manual) : null,
			cambiar:
				cambiable && h
					? {
							parametros: h.parametros,
							valores: p?.ok ? p.valor : t.parametros,
							objetivos: opcionesDeObjetivo(h, await trampasDelCliente())
						}
					: null
		};
	}
	const { h, m } = await cargarContenedor(params.id);
	/* Con los valores por defecto de lo que el módulo haya añadido después de desplegarla. */
	const p = validarParametros(m.parametros, t.parametros);
	return {
		tipo: 'contenedor' as const,
		trampa: { id: t.id, nombre: t.nombre, sensor: t.sensor, donde: t.donde },
		estado,
		prueba,
		modulo: m,
		valores: p.ok ? p.valor : t.parametros,
		/* Lo que dice hoy el elector de su máquina con sus valores: no impide guardar. */
		avisos: p.ok ? await avisosDeTrampa(t, h, p.valor) : []
	};
};

/* El módulo de una trampa a mano, para volver a generar sus pasos. */
async function moduloDe(t: { modulo: string }) {
	const h = (await trampasAutorizadas()).find((x) => x.id === t.modulo);
	if (!h) error(404, 'El módulo de esta trampa ya no está autorizado para este cliente.');
	return h;
}

/*
 * Con acciones con nombre, SvelteKit no admite también la de por defecto:
 * guardar (los ajustes, o los datos de una trampa a mano) es una más.
 */
export const actions = {
	guardar: async ({ params, request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const t0 = await trampa(params.id);
		if (!t0) error(404, 'Esa trampa no existe.');
		const manual = t0.ejecutor === 'manual@1';
		const { t, h, esquema } = manual
			? { t: t0, h: await moduloDe(t0), esquema: null }
			: await cargarContenedor(params.id).then((x) => ({ ...x, esquema: x.m.parametros }));
		const form = await request.formData();
		const nombre = String(form.get('nombre') ?? '').trim();
		const valores: Record<string, unknown> = {};
		for (const [k, v] of form)
			if (k.startsWith('p.')) valores[k.slice(2)] = String(v).replace(/\r\n/g, '\n');

		const errores: string[] = [];
		if (!nombre) errores.push('Nombre visible: obligatorio');
		const p = validarParametros(esquema ?? h.parametros, valores);
		if (!p.ok) errores.push(...p.errores);
		if (!p.ok || errores.length) return fail(400, { errores, motivos: [], nombre, valores });

		if (manual) {
			/* Por colocar, con los datos nuevos: el elector y los pasos otra vez, como al darla de alta. */
			const r = await regenerarPasos(u.correo, t.id, h, { nombre, parametros: p.valor });
			if (r !== 'generados') return fail(400, { ...r, nombre, valores });
			return { hecho: 'Pasos preparados de nuevo con los datos nuevos. Síguelos desde aquí.' };
		}
		/* El elector con los valores nuevos: solo impide guardar un puerto que choca (§7.3). */
		const r = await modificarConElector(u.correo, t, h, { nombre, parametros: p.valor });
		if (r !== 'modificada') return fail(400, { ...r, nombre, valores });
		redirect(303, `/trampas?cambiado=${encodeURIComponent(nombre)}`);
	},

	/*
	 * Volver a generar los pasos de una trampa a mano por colocar con sus datos
	 * de hoy (§8.2): la trampa a la que apunta o su destino han cambiado.
	 */
	regenerar: async ({ params, locals }) => {
		const u = exigir(locals, 'desplegar');
		const t = await trampa(params.id);
		if (!t) error(404, 'Esa trampa no existe.');
		const h = await moduloDe(t);
		const p = validarParametros(h.parametros, t.parametros);
		if (!p.ok) return fail(400, { aviso: `Sus datos ya no valen: ${p.errores.join('; ')}` });
		const r = await regenerarPasos(u.correo, t.id, h, { nombre: t.nombre, parametros: p.valor });
		if (r !== 'generados')
			return fail(400, { aviso: [...r.errores, ...r.motivos.map((m) => m.texto)].join(' ') });
		return { hecho: 'Pasos preparados de nuevo con los datos de hoy. Síguelos desde aquí.' };
	},

	/*
	 * «Probar» (§8.3): abre una prueba con un código nuevo. Sin marca, el
	 * evento se reconoce por la IP desde la que se prueba (por defecto, la
	 * del navegador).
	 */
	probar: async ({ params, request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const ip = String((await request.formData()).get('ip') ?? '').trim();
		const r = await abrirPrueba(u.correo, params.id, ip || null);
		if (r === 'no-existe') error(404, 'Esa trampa no existe.');
		/* El resultado se ve en la propia sección de la prueba, que se mira sola mientras espera. */
		if (r !== 'abierta') return fail(400, { avisoPrueba: r.error, ip });
		return { probada: true };
	},

	/* «Ya está hecho»: quien ha seguido los pasos dice que está puesta. */
	hecho: async ({ params, locals }) => {
		const u = exigir(locals, 'desplegar');
		const r = await trampaHecha(u.correo, params.id);
		if (r === 'no-existe') error(404, 'Esa trampa no existe.');
		if (r === 'sin-pasos') return fail(400, { aviso: 'Esta trampa no se pone a mano.' });
		if (r === 'no-por-colocar')
			return fail(400, { aviso: 'Ya estaba puesta, o se está retirando: no cambia nada.' });
		return { hecho: 'Apuntado: está puesta. Quedará comprobada con el primer evento que llegue.' };
	},

	retirar: async ({ params, locals }) => {
		const u = exigir(locals, 'desplegar');
		const r = await retirarTrampa(u.correo, params.id);
		if (r === 'no-existe') error(404, 'Esa trampa no existe.');
		if (r === 'retirada') redirect(303, '/trampas');
		if (r === 'retirando')
			return {
				hecho: 'Sigue los pasos para quitarla y, cuando no quede nada, pulsa «Ya lo he quitado».'
			};
		return fail(400, { aviso: recibeSenalDe(r.dependientes) });
	},

	/* «Ya lo he quitado»: después de los pasos de retirada, se borra. */
	quitado: async ({ params, locals }) => {
		const u = exigir(locals, 'desplegar');
		const nombre = (await trampa(params.id))?.nombre ?? params.id;
		const r = await trampaQuitada(u.correo, params.id);
		if (r === 'no-existe') error(404, 'Esa trampa no existe.');
		if (r === 'no-retirando')
			return fail(400, { aviso: 'Primero pulsa «Retirar» y sigue sus pasos para quitarla.' });
		if (r === 'retirada') redirect(303, `/trampas?quitada=${encodeURIComponent(nombre)}`);
		return fail(400, { aviso: recibeSenalDe(r.dependientes) });
	}
};
