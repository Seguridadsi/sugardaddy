import { error, fail, redirect } from '@sveltejs/kit';
import { esDeRegistro } from '@sugardaddy/canal';
import { proyectarParaSensor, validarParametros, viaDe } from '@sugardaddy/contrato';
import { esEntorno } from '$lib/entorno';
import { recibeSenalDe } from '$lib/formato';
import {
	avisosDeTrampa,
	cambiarEscucha,
	cambiarSitio,
	modificarConElector,
	opcionesDeEscucha,
	regenerarPasos
} from '$lib/server/alta';
import { exigir } from '$lib/server/auth/permisos';
import { alcanceDeFicha, fijarAlcance, leerAlcance } from '$lib/server/alcance-ficha';
import { honeycosas, trampasAutorizadas } from '$lib/server/catalogo';
import { estadosVisibles } from '$lib/server/colocacion';
import { entornoDeTrampa, trampa } from '$lib/server/consultas';
import { destinoDeTrampa, listaDestinos, trampasDelCliente } from '$lib/server/destinos';
import { esCommunity } from '$lib/server/edicion';
import {
	cambiarEntornoTrampa,
	retirarTrampa,
	trampaHecha,
	trampaQuitada
} from '$lib/server/gestion';
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
	if (!t) error(404, 'That honeypot does not exist.');
	const h = (await trampasAutorizadas()).find((x) => x.id === t.modulo);
	/* Una de registro sin registrarse: lo que hace falta está en Ajustes. */
	if (!h && esCommunity() && esDeRegistro(t.modulo)) redirect(303, '/settings#free-registration');
	if (!h) error(404, 'The module for this honeypot is no longer authorized for this customer.');
	const via = t.ejecutor === 'contenedor@1' ? viaDe(h, t.via) : undefined;
	if (via?.ejecutor !== 'contenedor@1')
		error(404, 'This honeypot cannot be edited here. Remove it and deploy it again.');
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
	if (!t) error(404, 'That honeypot does not exist.');
	/* Lo que ve el cliente de ella (§8.2): comprobada, puesta, degradada… y por qué. */
	const estado = (await estadosVisibles()).get(t.id) ?? null;
	/* «Probar» (§8.3): si se puede y cómo, y la última prueba con sus pasos. */
	const prueba = {
		...(await pruebaDeTrampa(t, estado)),
		ipNavegador: ipDelNavegador(getClientAddress)
	};
	/* Dónde está puesta (dentro | web | aislada): su valor propio y el que heredaría del sensor. */
	const entorno = (await entornoDeTrampa(params.id)) ?? {
		propio: null,
		sensor: null,
		efectivo: null
	};
	if (t.ejecutor === 'manual@1') {
		const destino = await destinoDeTrampa(t);
		const objetivo = t.senalTrampa ? await trampa(t.senalTrampa) : null;
		/* Por colocar, con su módulo y su vía: sus datos se pueden cambiar. */
		const h = (await trampasAutorizadas()).find((x) => x.id === t.modulo);
		const cambiable = t.colocacion === 'por-colocar' && h && viaDe(h, t.via);
		const p = cambiable ? validarParametros(h.parametros, t.parametros) : null;
		return {
			/* Por qué salidas avisa lo suyo (lib/alcance.ts). */
			alcance: await alcanceDeFicha('trampa', t.id, t.sensor),
			tipo: 'manual' as const,
			trampa: { id: t.id, nombre: t.nombre, colocacion: t.colocacion, modulo: t.modulo },
			/*
			 * Su módulo ya no está en el catálogo (como el píxel del login de Entra, retirado
			 * porque Microsoft quita el CSS del branding): la ficha pide retirarla con sus
			 * pasos, que se guardaron al generarla.
			 */
			fueraDelCatalogo: !honeycosas().some((x) => x.id === t.modulo),
			estado,
			prueba,
			entorno,
			destino: destino && { id: destino.id, nombre: destino.nombre },
			/*
			 * Adónde se puede cambiar de sitio: los demás destinos activos del tipo
			 * que admite su vía. El sistema y lo demás lo mira el elector al mover.
			 */
			sitios: await sitiosPara(t, h, destino?.id),
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
		alcance: await alcanceDeFicha('trampa', t.id, t.sensor),
		tipo: 'contenedor' as const,
		trampa: { id: t.id, nombre: t.nombre, sensor: t.sensor, donde: t.donde },
		estado,
		prueba,
		entorno,
		/* En qué dirección de su máquina escucha, si ahí se puede elegir. */
		escucha: await opcionesDeEscucha(t, h),
		modulo: m,
		valores: p.ok ? p.valor : t.parametros,
		/* Lo que dice hoy el elector de su máquina con sus valores: no impide guardar. */
		avisos: p.ok ? await avisosDeTrampa(t, h, p.valor) : []
	};
};

/* Los destinos a los que se puede mover una trampa a mano: activos, del tipo de su vía y no el suyo. */
async function sitiosPara(
	t: { via: string; colocacion: string },
	h: Parameters<typeof viaDe>[0] | undefined,
	actual: string | undefined
) {
	const via = h ? viaDe(h, t.via) : undefined;
	if (!via || t.colocacion === 'retirando') return [];
	const tipos = via.destino as readonly string[] | undefined;
	return (await listaDestinos())
		.filter((d) => d.activo && d.id !== actual && (!tipos || tipos.includes(d.tipo)))
		.map((d) => ({ id: d.id, nombre: d.nombre, plataforma: d.plataforma }));
}

/* El módulo de una trampa a mano, para volver a generar sus pasos. */
async function moduloDe(t: { modulo: string }) {
	const h = (await trampasAutorizadas()).find((x) => x.id === t.modulo);
	if (!h) error(404, 'The module for this honeypot is no longer authorized for this customer.');
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
		if (!t0) error(404, 'That honeypot does not exist.');
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
		if (!nombre) errores.push('Display name: required');
		const p = validarParametros(esquema ?? h.parametros, valores);
		if (!p.ok) errores.push(...p.errores);
		if (!p.ok || errores.length) return fail(400, { errores, motivos: [], nombre, valores });

		if (manual) {
			/* Por colocar, con los datos nuevos: el elector y los pasos otra vez, como al darla de alta. */
			const r = await regenerarPasos(u.correo, t.id, h, { nombre, parametros: p.valor });
			if (r !== 'generados') return fail(400, { ...r, nombre, valores });
			return { hecho: 'Steps regenerated with the new details. Follow them from here.' };
		}
		/* El elector con los valores nuevos: solo impide guardar un puerto que choca (§7.3). */
		const r = await modificarConElector(u.correo, t, h, { nombre, parametros: p.valor });
		if (r !== 'modificada') return fail(400, { ...r, nombre, valores });
		redirect(303, `/decoys?cambiado=${encodeURIComponent(nombre)}`);
	},

	/*
	 * Dónde está puesta esta trampa (dentro | de cara a la web | aislada), que
	 * afina el entorno de su sensor; gana lo más específico (lib/entorno.ts).
	 * Vacío = que herede del sensor. Decide qué respuesta tiene sentido, así que
	 * es cosa de quien despliega.
	 */
	/*
	 * En qué dirección de la máquina de su sensor se publica (vacío: en todas).
	 * El elector la comprueba: que sea de esa máquina y que ahí no choque un puerto.
	 */
	escucha: async ({ params, request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const t = await trampa(params.id);
		if (!t) error(404, 'That honeypot does not exist.');
		const h = honeycosas().find((x) => x.id === t.modulo);
		if (!h) return fail(400, { aviso: 'This honeypot is no longer in the catalog.' });
		const v = String((await request.formData()).get('escucha') ?? '').trim();
		const r = await cambiarEscucha(u.correo, t, h, v || null);
		if (r !== 'modificada')
			return fail(400, {
				aviso: [...r.errores, ...r.motivos.map((m) => m.texto)].join(' ')
			});
		return { hecho: 'Listening address saved. The sensor is applying it.' };
	},

	/* Lo que dice este honeypot de una salida: enviar, no enviar o heredar (lib/alcance.ts). */
	alcance: async ({ params, request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const v = leerAlcance(await request.formData());
		if (!v) return fail(400, { aviso: 'That output or value is not valid.' });
		if (!(await trampa(params.id))) error(404, 'That honeypot does not exist.');
		if (!(await fijarAlcance(u.correo, { ...v, nivel: 'trampa', objeto: params.id })))
			return fail(400, { aviso: 'That output no longer exists.' });
		return { hecho: 'Alerts for this honeypot saved.' };
	},

	entorno: async ({ params, request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const v = String((await request.formData()).get('entorno') ?? '');
		const entorno = v === '' ? null : esEntorno(v) ? v : undefined;
		if (entorno === undefined) return fail(400, { aviso: 'Invalid environment.' });
		if (!(await cambiarEntornoTrampa(u.correo, params.id, entorno)))
			error(404, 'That honeypot does not exist.');
		return { hecho: 'Honeypot environment saved.' };
	},

	/*
	 * Cambiar de sitio una trampa a mano sin retirarla (alta.ts, cambiarSitio):
	 * por colocar, con sus pasos generados otra vez para el nuevo destino;
	 * puesta, solo el destino.
	 */
	sitio: async ({ params, request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const t = await trampa(params.id);
		if (!t) error(404, 'That honeypot does not exist.');
		const nuevo = String((await request.formData()).get('destino') ?? '');
		if (!nuevo) return fail(400, { aviso: 'Choose the target it is on.' });
		const h = await moduloDe(t);
		const p = validarParametros(h.parametros, t.parametros);
		if (!p.ok)
			return fail(400, { aviso: `Its details are no longer valid: ${p.errores.join('; ')}` });
		const r = await cambiarSitio(u.correo, t.id, h, nuevo, p.valor);
		if (r !== 'movida')
			return fail(400, { aviso: [...r.errores, ...r.motivos.map((m) => m.texto)].join(' ') });
		return {
			hecho:
				t.colocacion === 'por-colocar'
					? 'Moved. Its steps were regenerated for the new target: follow them from here.'
					: 'Moved. What you deployed and its removal steps stay as they were.'
		};
	},

	/*
	 * Volver a generar los pasos de una trampa a mano por colocar con sus datos
	 * de hoy (§8.2): la trampa a la que apunta o su destino han cambiado.
	 */
	regenerar: async ({ params, locals }) => {
		const u = exigir(locals, 'desplegar');
		const t = await trampa(params.id);
		if (!t) error(404, 'That honeypot does not exist.');
		const h = await moduloDe(t);
		const p = validarParametros(h.parametros, t.parametros);
		if (!p.ok)
			return fail(400, { aviso: `Its details are no longer valid: ${p.errores.join('; ')}` });
		const r = await regenerarPasos(u.correo, t.id, h, { nombre: t.nombre, parametros: p.valor });
		if (r !== 'generados')
			return fail(400, { aviso: [...r.errores, ...r.motivos.map((m) => m.texto)].join(' ') });
		return { hecho: 'Steps regenerated with the current details. Follow them from here.' };
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
		if (r === 'no-existe') error(404, 'That honeypot does not exist.');
		/* El resultado se ve en la propia sección de la prueba, que se mira sola mientras espera. */
		if ('error' in r) return fail(400, { avisoPrueba: r.error, ip });
		return { probada: true };
	},

	/* «Ya está hecho»: quien ha seguido los pasos dice que está puesta. */
	hecho: async ({ params, locals }) => {
		const u = exigir(locals, 'desplegar');
		const r = await trampaHecha(u.correo, params.id);
		if (r === 'no-existe') error(404, 'That honeypot does not exist.');
		if (r === 'sin-pasos') return fail(400, { aviso: 'This honeypot is not deployed manually.' });
		if (r === 'no-por-colocar')
			return fail(400, { aviso: 'It is already deployed or being removed, so nothing changes.' });
		return { hecho: 'Noted: it is deployed. It will be verified by the first event that arrives.' };
	},

	retirar: async ({ params, locals }) => {
		const u = exigir(locals, 'desplegar');
		const r = await retirarTrampa(u.correo, params.id);
		if (r === 'no-existe') error(404, 'That honeypot does not exist.');
		if (r === 'retirada') redirect(303, '/decoys');
		if (r === 'retirando')
			return {
				hecho: 'Follow the steps to remove it and, when nothing is left, click "I have removed it".'
			};
		return fail(400, { aviso: recibeSenalDe(r.dependientes) });
	},

	/* «Ya lo he quitado»: después de los pasos de retirada, se borra. */
	quitado: async ({ params, locals }) => {
		const u = exigir(locals, 'desplegar');
		const nombre = (await trampa(params.id))?.nombre ?? params.id;
		const r = await trampaQuitada(u.correo, params.id);
		if (r === 'no-existe') error(404, 'That honeypot does not exist.');
		if (r === 'no-retirando')
			return fail(400, { aviso: 'First click "Remove" and follow its steps to take it down.' });
		if (r === 'retirada') redirect(303, `/decoys?quitada=${encodeURIComponent(nombre)}`);
		return fail(400, { aviso: recibeSenalDe(r.dependientes) });
	}
};
