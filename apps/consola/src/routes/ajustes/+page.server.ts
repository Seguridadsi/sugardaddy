import { fail } from '@sveltejs/kit';
import { exigir } from '$lib/server/auth/permisos';
import { loginLocalHabilitado } from '$lib/server/auth/local';
import {
	actualizacion,
	configuracion,
	cortar,
	darDeAlta,
	estadoCanal,
	latir,
	reanudar,
	relevoEnCurso,
	urlPanelValida
} from '$lib/server/canal';
import { eq } from 'drizzle-orm';
import {
	auditar,
	autoActualizar,
	buscarActualizaciones,
	cabecera,
	guardarAutoActualizar,
	guardarBuscarActualizaciones,
	guardarWebhook,
	webhook
} from '$lib/server/consultas';
import { gestionado } from '$lib/server/actualizaciones';
import { enviarLead } from '$lib/server/lead';
import { db, schema as s } from '$lib/server/db';
import { aceptar, cerrarYa, rechazar, soporte } from '$lib/server/soporte';
import { llaves, retirarLlave } from '$lib/server/emergencia';
import { MINIMO_PALABRA, guardarPalabras, palabras } from '$lib/server/credenciales';
import {
	DIAS_MAXIMO,
	DIAS_MINIMO,
	borrarAntesDe,
	cambiarPlazo,
	conservacion,
	validarDias
} from '$lib/server/conservacion';
import { estadoEspacio, estimacion } from '$lib/server/espacio';

const DIA_MS = 86_400_000;

export const load = async ({ locals }) => {
	exigir(locals, 'ajustes');
	const a = await actualizacion();
	const cons = await conservacion();
	const esp = await estadoEspacio();
	return {
		ahora: Date.now(),
		loginLocal: loginLocalHabilitado(),
		gestionado: await gestionado(),
		buscarActualizaciones: await buscarActualizaciones(),
		autoActualizar: await autoActualizar(),
		webhook: await webhook(),
		espacio: esp,
		estimacion: estimacion(esp, cons.dias),
		canal: await estadoCanal(),
		version: (await cabecera()).cliente.version,
		actualizacion: { estado: a.estado, version: a.version, detalle: a.detalle },
		configuracion: await configuracion(),
		relevo: await (async () => {
			const r = await relevoEnCurso();
			if (!r) return null;
			const [sen] = await db
				.select({ nombre: s.sensores.nombre })
				.from(s.sensores)
				.where(eq(s.sensores.id, r.sensor));
			return { sensor: sen?.nombre ?? r.sensor, remoto: r.remoto, desde: r.desde };
		})(),
		soporte: await soporte(),
		palabras: await palabras(),
		minimoPalabra: MINIMO_PALABRA,
		conservacion: { ...cons, minimo: DIAS_MINIMO, maximo: DIAS_MAXIMO },
		llaves: (await llaves()).map((l) => ({
			...l,
			creada: l.creada.toISOString(),
			ultimoUso: l.ultimoUso?.toISOString() ?? null
		}))
	};
};

export const actions = {
	buscarActualizaciones: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		await guardarBuscarActualizaciones(u.correo, (await request.formData()).get('buscar') === 'on');
		return { mensaje: 'Guardado.' };
	},
	autoActualizar: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		if (await gestionado())
			return fail(400, {
				error: 'Este nodo lo gestiona un panel; la auto-actualización se controla desde ahí.'
			});
		const form = await request.formData();
		const activar = form.get('activar') === 'on';
		const correo = String(form.get('correo') ?? '').trim();
		if (activar) {
			if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo))
				return fail(400, { error: 'Pon un correo válido para activar la auto-actualización.' });
			if (form.get('consentimiento') !== 'on')
				return fail(400, { error: 'Marca el consentimiento para activar la auto-actualización.' });
		}
		const anterior = await autoActualizar();
		await guardarAutoActualizar(u.correo, {
			decidido: true,
			activo: activar,
			correo: activar ? correo : null,
			consentimiento: activar ? new Date().toISOString() : null
		});
		/*
		 * Lead a SeguridadSI (solo nodos community: enviarLead corta solo si hay
		 * panel). El mismo consentimiento de la casilla cubre recibir novedades.
		 * No se espera (void): el guardado local ya está hecho y el envío es
		 * best-effort con su propio timeout; así el toggle responde al instante
		 * aunque el panel esté caído o lento.
		 */
		if (activar) void enviarLead('alta', correo).catch(() => {});
		else if (anterior.activo && anterior.correo)
			void enviarLead('baja', anterior.correo).catch(() => {});
		return {
			mensaje: activar ? 'Auto-actualización activada.' : 'Auto-actualización desactivada.'
		};
	},
	webhook: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const activo = f.get('activo') === 'on';
		const url = String(f.get('url') ?? '').trim();
		const secreto = String(f.get('secreto') ?? '').trim();
		if (activo) {
			let ok = false;
			try {
				const p = new URL(url);
				ok = p.protocol === 'https:' || p.protocol === 'http:';
			} catch {
				ok = false;
			}
			if (!ok) return fail(400, { error: 'Pon una URL http(s) válida para activar el webhook.' });
		}
		/* El secreto en blanco NO lo borra: mantiene el que hubiera (no hace falta
		 * volver a teclearlo en cada guardado). */
		const previo = await webhook();
		await guardarWebhook(u.correo, {
			url: url || null,
			activo,
			secreto: secreto || previo.secreto
		});
		return { mensaje: activo ? 'Webhook activado.' : 'Webhook desactivado.' };
	},
	palabras: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const texto = String((await request.formData()).get('palabras') ?? '');
		const r = await guardarPalabras(u.correo, texto);
		if (!r.ok) return fail(400, { error: r.error, palabras: texto });
		return {
			mensaje: `Palabras guardadas. Revisados los eventos anteriores: ${r.cambiados} cambian.`
		};
	},
	conservacion: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const texto = String((await request.formData()).get('dias') ?? '');
		const dias = validarDias(texto);
		if (!dias)
			return fail(400, {
				error: `El plazo va en días, entre ${DIAS_MINIMO} y ${DIAS_MAXIMO}.`,
				dias: texto
			});
		await cambiarPlazo(u.correo, dias);
		return { mensaje: `Plazo de conservación: ${dias} días.` };
	},
	/* Aplicar el plazo YA (sin esperar al borrado de cada hora): borra ahora los
	 * eventos más viejos que el plazo. Es manual y deliberado, así que no respeta
	 * el margen de gracia; queda en la auditoría con quién lo pidió. */
	purgarEventos: async ({ locals }) => {
		const u = exigir(locals, 'ajustes');
		const c = await conservacion();
		const limite = new Date(Date.now() - c.dias * DIA_MS);
		const r = await borrarAntesDe(limite);
		await auditar(u.correo, 'purga manual de eventos', {
			antesDe: limite.toISOString(),
			dias: c.dias,
			eventos: r.eventos,
			cuarentena: r.cuarentena,
			cadena: r.cadena
		});
		return {
			mensaje:
				r.eventos || r.cuarentena
					? `Purgados ${r.eventos} eventos y ${r.cuarentena} de cuarentena de más de ${c.dias} días.`
					: `No había eventos de más de ${c.dias} días que borrar.`
		};
	},
	alta: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const panel = String(f.get('panel') ?? '').trim();
		const codigo = String(f.get('codigo') ?? '').trim();
		if (!urlPanelValida(panel))
			return fail(400, { error: 'La dirección del panel tiene que ser https.', panel });
		if (!/^[A-Za-z0-9_-]{32}$/.test(codigo))
			return fail(400, { error: 'El código de alta no tiene el formato esperado.', panel });
		const r = await darDeAlta(u.correo, panel, codigo);
		return r.ok
			? { mensaje: 'Nodo dado de alta en el panel central.' }
			: fail(400, { error: r.motivo, panel });
	},
	latir: async ({ locals }) => {
		exigir(locals, 'ajustes');
		await latir();
		return { mensaje: 'Latido enviado.' };
	},
	cortar: async ({ locals }) => {
		const u = exigir(locals, 'ajustes');
		await cortar(u.correo);
		return { mensaje: 'Canal cortado. El panel central ya no recibe nada de este nodo.' };
	},
	retirarLlave: async ({ locals, request }) => {
		const u = exigir(locals, 'ajustes');
		const ok = await retirarLlave(u.correo, String((await request.formData()).get('id')));
		return ok ? { mensaje: 'Llave retirada.' } : fail(404, { error: 'Esa llave no existe.' });
	},
	soporteAceptar: async ({ locals, request }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const horas = f.get('horas') === '8' ? 8 : 2;
		const rol = f.get('rol') === 'operador' ? 'operador' : 'lector';
		return (await aceptar(u.correo, horas, rol))
			? { mensaje: `Soporte abierto ${horas} horas como ${rol}.` }
			: fail(400, { error: 'No hay ninguna petición pendiente.' });
	},
	soporteRechazar: async ({ locals }) => {
		const u = exigir(locals, 'ajustes');
		return (await rechazar(u.correo))
			? { mensaje: 'Petición rechazada. SeguridadSI lo verá en el panel.' }
			: fail(400, { error: 'No hay ninguna petición pendiente.' });
	},
	soporteCerrar: async ({ locals }) => {
		const u = exigir(locals, 'ajustes');
		return (await cerrarYa(u.correo))
			? { mensaje: 'Soporte cerrado. Las sesiones de SeguridadSI se han cortado.' }
			: fail(400, { error: 'El soporte no estaba abierto.' });
	},
	reanudar: async ({ locals }) => {
		const u = exigir(locals, 'ajustes');
		await reanudar(u.correo);
		return { mensaje: 'Canal reanudado.' };
	}
};
