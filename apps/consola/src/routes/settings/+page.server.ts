import { operador } from '$lib/server/operador';
import { fail, redirect } from '@sveltejs/kit';
import { leerDominio, proponer, sugerirDominio } from '$lib/camuflaje';
import {
	aplicarIdentidad,
	guardarIdentidad,
	identidad,
	trampasDeFabrica
} from '$lib/server/identidad';
import { exigir } from '$lib/server/auth/permisos';
import { loginLocalHabilitado } from '$lib/server/auth/local';
import { configuradoEnEntorno } from '$lib/server/auth/entra';
import {
	estadoEntraPropio,
	guardarEntraPropio,
	quitarEntraPropio
} from '$lib/server/auth/entra-propio';
import {
	actualizacion,
	configuracion,
	cortar,
	darDeAlta,
	estadoCanal,
	latir,
	reanudar,
	relevoEnCurso,
	urlPanelValida,
	guardarRecuperacionPanelActiva,
	recuperacionPanelActiva
} from '$lib/server/canal';
import { eq } from 'drizzle-orm';
import {
	actualizacionDisponible,
	auditar,
	autoActualizar,
	buscarActualizaciones,
	cabecera,
	comparticion,
	guardarAutoActualizar,
	guardarBuscarActualizaciones,
	guardarComparticion,
	falloWebhook,
	guardarWebhook,
	secretoWebhook,
	webhook
} from '$lib/server/consultas';
import { cifrar, estadoClave, final } from '$lib/server/secretos';
import { gestionado } from '$lib/server/actualizaciones';
import {
	activar,
	estadoRegistro,
	pedirRegistro,
	puedeRegistrarse,
	renovar
} from '$lib/server/registro';
import { honeycosas } from '$lib/server/catalogo';
import { MODULOS_REGISTRO } from '$lib/server/modulos-gratis';
import { db, schema as s } from '$lib/server/db';
import { aceptar, cerrarYa, rechazar, soporte } from '$lib/server/soporte';
import {
	estadoCodigoEmergencia,
	llaves,
	nuevoCodigoEmergencia,
	retirarLlave
} from '$lib/server/emergencia';
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

export const load = async ({ locals, url }) => {
	exigir(locals, 'ajustes');
	const empresa = await identidad();
	const a = await actualizacion();
	const cons = await conservacion();
	const esp = await estadoEspacio();
	return {
		ahora: Date.now(),
		loginLocal: loginLocalHabilitado(),
		gestionado: await gestionado(),
		buscarActualizaciones: await buscarActualizaciones(),
		autoActualizar: await autoActualizar(),
		registro: (await puedeRegistrarse())
			? {
					...(await estadoRegistro()),
					trampas: honeycosas()
						.filter((h) => MODULOS_REGISTRO.has(h.id))
						.map((h) => h.nombre)
				}
			: null,
		dominioSugerido: empresa.dominio ?? sugerirDominio(url.hostname),
		ejemplosDominio: empresa.dominio
			? ['equipo:fs', 'equipo:sql', 'host:bak', 'fqdn:mail'].flatMap(
					(t) => proponer(t, empresa.dominio!, { semilla: empresa.semilla }) ?? []
				)
			: [],
		trampasDeFabrica: await trampasDeFabrica(),
		/* Del secreto solo si está puesto y sus 4 últimos: nunca vuelve entero a la página. */
		webhook: await (async () => {
			const w = await webhook();
			const sec = secretoWebhook(w);
			return {
				url: w.url,
				activo: w.activo,
				secretoPuesto: !!(w.secretoCifrado || w.secreto),
				secretoFinal: sec ? final(sec) : null,
				/* El último fallo al entregar, si lo hay: un receptor que redirige o falla no se queda en silencio. */
				fallo: w.activo ? await falloWebhook() : null
			};
		})(),
		espacio: esp,
		estimacion: estimacion(esp, cons.dias),
		canal: await estadoCanal(),
		version: (await cabecera()).cliente.version,
		actualizacion: { estado: a.estado, version: a.version, detalle: a.detalle },
		/* La versión más nueva vista en el repo público (nodos sin panel que la buscan). */
		disponible: (await actualizacionDisponible()).version,
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
		comparticion: await comparticion(),
		palabras: await palabras(),
		minimoPalabra: MINIMO_PALABRA,
		conservacion: { ...cons, minimo: DIAS_MINIMO, maximo: DIAS_MAXIMO },
		codigoEmergencia: await estadoCodigoEmergencia(),
		recuperacionPanel: await recuperacionPanelActiva(),
		entra: {
			propio: await estadoEntraPropio(),
			seguridadsi: configuradoEnEntorno(),
			retorno: `${url.origin}/auth/callback`
		},
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
		return { mensaje: 'Saved.' };
	},
	identidad: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const form = await request.formData();
		const antes = await identidad();
		if (form.get('omitir') === 'si') {
			await guardarIdentidad(u.correo, { decidido: true, dominio: antes.dominio });
			return { mensaje: 'OK. You can set it at any time in Settings.' };
		}
		const texto = String(form.get('dominio') ?? '');
		const dominio = leerDominio(texto);
		if (!dominio)
			return fail(400, { error: `"${texto.trim()}" is not a domain. Enter it as company.com.` });
		await guardarIdentidad(u.correo, { decidido: true, dominio });
		return { mensaje: `Saved: ${dominio}. New decoys will take names from that domain.` };
	},
	aplicarIdentidad: async ({ locals }) => {
		const u = exigir(locals, 'ajustes');
		const { cambiadas, sinCambiar } = await aplicarIdentidad(u.correo);
		const partes = [
			cambiadas.length === 1
				? '1 decoy updated: the sensor redeploys it on its next check-in.'
				: `${cambiadas.length} decoys updated: the sensor redeploys them on its next check-in.`,
			...sinCambiar.map((x) => `"${x.nombre}" stays as it is: ${x.motivo}.`)
		];
		return { mensaje: partes.join(' ') };
	},
	pedirRegistro: async ({ request, locals }) => {
		exigir(locals, 'ajustes');
		if (!(await puedeRegistrarse()))
			return fail(400, { error: 'This node does not need registration.' });
		const correo = String((await request.formData()).get('correo') ?? '').trim();
		if (correo.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo))
			return fail(400, { error: 'Enter a valid email address.', correoRegistro: correo });
		const r = await pedirRegistro(correo);
		if (r === 'enviado')
			return {
				mensaje: `If the address is correct, you will receive a confirmation link at ${correo}. Once you confirm, you will get the activation code.`,
				correoRegistro: correo
			};
		const textos = {
			'no-disponible':
				'Registration is not available right now. The rest of Sugardaddy keeps working normally.',
			demasiados: 'Too many requests in a row. Try again in a while.',
			'correo-invalido': 'Enter a valid email address.',
			'sin-conexion':
				'Could not reach the SeguridadSI Central. Check that the node has internet access.'
		} as const;
		return fail(400, { error: textos[r], correoRegistro: correo });
	},
	activarRegistro: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const codigo = String((await request.formData()).get('codigo') ?? '');
		const r = await activar(u.correo, codigo);
		if (!r.ok) return fail(400, { error: r.error });
		return { mensaje: 'Registration activated. You can now deploy the registration decoys.' };
	},
	renovarRegistro: async ({ locals }) => {
		exigir(locals, 'ajustes');
		const r = await renovar(Date.now(), true);
		if (r === 'renovada') return { mensaje: 'Registration renewed.' };
		const { fallo } = await estadoRegistro();
		return fail(400, { error: fallo ?? 'Could not renew the registration.' });
	},
	autoActualizar: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		if (await gestionado())
			return fail(400, {
				error: 'This node is managed by a Central; auto-update is controlled from there.'
			});
		const activo = (await request.formData()).get('activar') === 'on';
		const { estado, correo } = await estadoRegistro();
		if (activo && (estado === 'sin' || estado === 'invalida'))
			return fail(400, { error: 'Automatic updates are enabled through registration.' });
		await guardarAutoActualizar(u.correo, {
			decidido: true,
			activo,
			correo,
			consentimiento: activo ? new Date().toISOString() : null
		});
		return {
			mensaje: activo ? 'Auto-update enabled.' : 'Auto-update disabled.'
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
			if (!ok) return fail(400, { error: 'Enter a valid http(s) URL to enable the webhook.' });
		}
		if (secreto.length > 512) return fail(400, { error: 'The signing secret is too long.' });
		/*
		 * El secreto en blanco NO lo borra: mantiene el que hubiera (no hace falta
		 * volver a teclearlo en cada guardado). Se guarda cifrado con la clave del
		 * nodo; uno en claro de antes se cifra ahora si hay clave, y si no se deja
		 * como estaba (guardar, o apagarlo, no puede fallar por eso). Uno cifrado que
		 * no se puede leer (otra clave) tampoco se pierde en silencio.
		 */
		const previo = await webhook();
		const hayClave = estadoClave() === 'lista';
		if (secreto && !hayClave)
			return fail(400, {
				error:
					'This node does not have its key for storing secrets (CLAVE_SECRETOS in its .env file). It is created when the node is updated; if you installed it by hand, add it with: openssl rand -hex 32'
			});
		const guardado = secreto
			? { secreto: null, secretoCifrado: cifrar({ secreto }, 'webhook') }
			: previo.secretoCifrado
				? { secreto: null, secretoCifrado: previo.secretoCifrado }
				: previo.secreto && hayClave
					? { secreto: null, secretoCifrado: cifrar({ secreto: previo.secreto }, 'webhook') }
					: { secreto: previo.secreto, secretoCifrado: null };
		await guardarWebhook(u.correo, { url: url || null, activo, ...guardado });
		return { mensaje: activo ? 'Webhook enabled.' : 'Webhook disabled.' };
	},
	palabras: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const texto = String((await request.formData()).get('palabras') ?? '');
		const r = await guardarPalabras(u.correo, texto);
		if (!r.ok) return fail(400, { error: r.error, palabras: texto });
		return {
			mensaje: `Words saved. Earlier events reviewed: ${r.cambiados} change.`
		};
	},
	conservacion: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const texto = String((await request.formData()).get('dias') ?? '');
		const dias = validarDias(texto);
		if (!dias)
			return fail(400, {
				error: `The retention period is in days, between ${DIAS_MINIMO} and ${DIAS_MAXIMO}.`,
				dias: texto
			});
		await cambiarPlazo(u.correo, dias);
		return { mensaje: `Retention period: ${dias} days.` };
	},
	/* Aplicar el plazo YA (sin esperar al borrado de cada hora): borra ahora los
	 * eventos más viejos que el plazo. Es manual y deliberado, así que no respeta
	 * el margen de gracia; queda en la auditoría con quién lo pidió. */
	purgarEventos: async ({ locals }) => {
		const u = exigir(locals, 'ajustes');
		const c = await conservacion();
		const limite = new Date(Date.now() - c.dias * DIA_MS);
		const r = await borrarAntesDe(limite);
		await auditar(u.correo, 'manual event purge', {
			antesDe: limite.toISOString(),
			dias: c.dias,
			eventos: r.eventos,
			cuarentena: r.cuarentena,
			cadena: r.cadena
		});
		return {
			mensaje:
				r.eventos || r.cuarentena
					? `Purged ${r.eventos} events and ${r.cuarentena} quarantined items older than ${c.dias} days.`
					: `There were no events older than ${c.dias} days to delete.`
		};
	},
	alta: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const panel = String(f.get('panel') ?? '').trim();
		const codigo = String(f.get('codigo') ?? '').trim();
		if (!urlPanelValida(panel))
			return fail(400, { error: 'The Central address must use https.', panel });
		if (!/^[A-Za-z0-9_-]{32}$/.test(codigo))
			return fail(400, { error: 'The enrollment code does not have the expected format.', panel });
		const r = await darDeAlta(u.correo, panel, codigo);
		return r.ok ? { mensaje: 'Node enrolled in Central.' } : fail(400, { error: r.motivo, panel });
	},
	latir: async ({ locals }) => {
		exigir(locals, 'ajustes');
		await latir();
		return { mensaje: 'Heartbeat sent.' };
	},
	cortar: async ({ locals }) => {
		const u = exigir(locals, 'ajustes');
		await cortar(u.correo);
		return { mensaje: 'Channel cut. Central no longer receives anything from this node.' };
	},
	/* Guarda el Entra propio, pendiente, y se va a probarlo con Microsoft. */
	entraGuardar: async ({ locals, request }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const datos = {
			tenant: String(f.get('tenant') ?? ''),
			clientId: String(f.get('clientId') ?? ''),
			secreto: String(f.get('secreto') ?? '')
		};
		const r = await guardarEntraPropio(u.correo, datos);
		if (!r.ok)
			return fail(400, {
				entraError: r.error,
				entraValores: { tenant: datos.tenant, clientId: datos.clientId }
			});
		redirect(303, '/auth/login?probar=1');
	},
	entraQuitar: async ({ locals }) => {
		const u = exigir(locals, 'ajustes');
		await quitarEntraPropio(u.correo);
		redirect(303, '/settings#entra');
	},
	/* El código se enseña solo en esta respuesta: no se guarda en claro en ningún sitio. */
	codigoEmergencia: async ({ locals }) => {
		const u = exigir(locals, 'ajustes');
		return { codigoEmergencia: await nuevoCodigoEmergencia(u.correo) };
	},
	/* SUP-12: que SeguridadSI pueda mandar un código de recuperación desde su panel. */
	recuperacionPanel: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const activa = (await request.formData()).get('activa') === 'si';
		await guardarRecuperacionPanelActiva(u.correo, activa);
		return {
			mensaje: activa
				? 'Password recovery from Central allowed.'
				: 'Password recovery from Central not allowed.'
		};
	},
	/* Compartir con otros clientes (va por el canal con el panel central). */
	comparticion: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const form = await request.formData();
		await guardarComparticion(u.correo, {
			compartir: form.get('compartir') === 'on',
			recibir: form.get('recibir') === 'on'
		});
		return { mensaje: 'Sharing settings saved.' };
	},
	retirarLlave: async ({ locals, request }) => {
		const u = exigir(locals, 'ajustes');
		const ok = await retirarLlave(u.correo, String((await request.formData()).get('id')));
		return ok ? { mensaje: 'Key removed.' } : fail(404, { error: 'That key does not exist.' });
	},
	soporteAceptar: async ({ locals, request }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const pedido = f.get('horas');
		const horas = pedido === 'continuo' ? null : pedido === '8' ? 8 : 2;
		const rol = f.get('rol') === 'operador' ? 'operador' : 'lector';
		const rolNombre = rol === 'operador' ? 'operator' : 'viewer';
		return (await aceptar(u.correo, horas, rol))
			? {
					mensaje:
						horas === null
							? `Support access opened as ${rolNombre}, until you close it.`
							: `Support access opened for ${horas} hours as ${rolNombre}.`
				}
			: fail(400, { error: 'There is no pending request.' });
	},
	soporteRechazar: async ({ locals }) => {
		const u = exigir(locals, 'ajustes');
		return (await rechazar(u.correo))
			? { mensaje: `Request rejected. ${await operador()} will see it in Central.` }
			: fail(400, { error: 'There is no pending request.' });
	},
	soporteCerrar: async ({ locals }) => {
		const u = exigir(locals, 'ajustes');
		return (await cerrarYa(u.correo))
			? { mensaje: `Support access closed. ${await operador()} sessions have been cut.` }
			: fail(400, { error: 'Support access was not open.' });
	},
	reanudar: async ({ locals }) => {
		const u = exigir(locals, 'ajustes');
		await reanudar(u.correo);
		return { mensaje: 'Channel resumed.' };
	}
};
