import { isIP } from 'node:net';
import { esPrivada, motivoHost, motivoIp, sinCorchetes } from '$lib/server/destino-red';
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
import { sesionActual } from '$lib/server/auth/sesion';
import { listar as usuariosLocales, loginLocalHabilitado } from '$lib/server/auth/local';
import { estadoExigencia, fijarExigido, resumenPorUsuario } from '$lib/server/auth/segundo-factor';
import { estadoOidc, guardarOidc, quitarOidc } from '$lib/server/auth/oidc-propio';
import { ROLES } from '$lib/server/auth/permisos';
import { configuradoEnEntorno } from '$lib/server/auth/entra';
import { equipoB2B, estadoB2B, retirarB2B } from '$lib/server/auth/b2b';
import {
	configActiva,
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
	comprobacionVersion,
	auditar,
	autoActualizar,
	buscarActualizaciones,
	cabecera,
	comparticion,
	guardarAutoActualizar,
	guardarBuscarActualizaciones,
	guardarComparticion,
	guardarLatidoMinimo,
	latidoMinimo,
	falloWebhook,
	guardarWebhook,
	secretoWebhook,
	webhook
} from '$lib/server/consultas';
import { cifrar, estadoClave, final } from '$lib/server/secretos';
import { comprobarVersiones, gestionado } from '$lib/server/actualizaciones';
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
import {
	aceptar,
	cerrarYa,
	fijarPosturaSoporte,
	horasValidas,
	plazosDe,
	porCaducar,
	posturaSoporte,
	rechazar,
	renovar as renovarSoporte,
	soporte
} from '$lib/server/soporte';
import { aplicarPerfilBanca, estadoBanca, fijarSeparacion } from '$lib/server/banca';
import {
	estadoCodigoEmergencia,
	llaves,
	nuevoCodigoEmergencia,
	retirarLlave
} from '$lib/server/emergencia';
import { MINIMO_PALABRA, guardarPalabras, palabras } from '$lib/server/credenciales';
import {
	DIAS_CREDENCIALES_MINIMO,
	DIAS_MAXIMO,
	DIAS_MINIMO,
	borrarAntesDe,
	cambiarPlazo,
	cambiarPlazoCredenciales,
	conservacion,
	conservacionCredenciales,
	validarDias,
	validarDiasCredenciales
} from '$lib/server/conservacion';
import { estadoEspacio, estimacion } from '$lib/server/espacio';
import { fechasLicencia } from '$lib/server/candado';
import {
	aprobacionActualizacion,
	aprobarActualizacion,
	esperaActual,
	guardarPoliticaActualizacion,
	politicaActualizacion
} from '$lib/server/politica-actualizacion';
import { datosDeRelease, politicaDelFormulario } from '$lib/politica-actualizacion';

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
		/* Las fechas de la licencia Cloud (B-06): desplegar hasta caduca, funcionar hasta funcionaHasta. */
		licenciaCloud: await fechasLicencia(),
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
		/* La política de cambios y por qué espera la pendiente (docs/diseno/politica-cambios.md). */
		politica: await politicaActualizacion(),
		espera: await esperaActual(a),
		aprobacion: await (async () => {
			const ap = await aprobacionActualizacion();
			return ap && ap.version === a.version ? ap : null;
		})(),
		pendienteFirmada: (() => {
			const d = datosDeRelease(a.release?.release);
			return d && d.version === a.version ? { publicada: d.publicada, urgente: d.urgente } : null;
		})(),
		/* La versión más nueva vista en el repo público (nodos sin panel que la buscan). */
		disponible: (await actualizacionDisponible()).version,
		/* Cuándo miró por última vez y qué vio (nodos sin panel). */
		comprobada: await comprobacionVersion(),
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
		...(await (async () => {
			const sop = await soporte();
			const postura = await posturaSoporte();
			return {
				soporte: sop,
				soportePorCaducar: porCaducar(sop, Date.now(), postura),
				soportePostura: postura,
				soportePlazos: plazosDe(postura)
			};
		})()),
		/* El perfil bancario: la política de actualización, el soporte y las credenciales (banca.ts). */
		banca: await estadoBanca(),
		/* Cómo se entra hoy: el bloque de soporte cambia con ello. */
		/* A quién dar rol en la aplicación propia: solo mientras se migra. */
		equipoB2B: (await estadoB2B()) === 'activo' ? await equipoB2B() : [],
		accesoModo: ((await configActiva())?.modo ?? 'local') as 'propio' | 'seguridadsi' | 'local',
		comparticion: await comparticion(),
		latidoMinimo: await latidoMinimo(),
		palabras: await palabras(),
		minimoPalabra: MINIMO_PALABRA,
		conservacion: { ...cons, minimo: DIAS_MINIMO, maximo: DIAS_MAXIMO },
		conservacionCredenciales: {
			...(await conservacionCredenciales()),
			minimo: DIAS_CREDENCIALES_MINIMO,
			maximo: DIAS_MAXIMO
		},
		codigoEmergencia: await estadoCodigoEmergencia(),
		recuperacionPanel: await recuperacionPanelActiva(),
		/* Segundo factor de los usuarios locales: si se exige y cuántos aún no lo tienen. */
		segundoFactor: await (async () => {
			if (!loginLocalHabilitado()) return null;
			const con = await resumenPorUsuario();
			const todos = await usuariosLocales();
			return {
				...(await estadoExigencia()),
				sinFactor: todos.filter((u) => !con.has(u.id)).map((u) => u.usuario)
			};
		})(),
		oidc: {
			estado: await estadoOidc(),
			roles: ROLES,
			retorno: `${url.origin}/auth/oidc/callback`
		},
		entra: {
			propio: await estadoEntraPropio(),
			seguridadsi: configuradoEnEntorno(),
			b2b: await estadoB2B(),
			retorno: `${url.origin}/auth/callback`
		},
		llaves: (await llaves()).map((l) => ({
			...l,
			creada: l.creada.toISOString(),
			ultimoUso: l.ultimoUso?.toISOString() ?? null
		}))
	};
};

/* «30 days», «7 days», «8 hours». */
const plazoEnTexto = (horas: number) =>
	horas % 24 === 0 ? `${horas / 24} days` : horas === 1 ? '1 hour' : `${horas} hours`;

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
		return { mensaje: `Saved: ${dominio}. New honeypots will take names from that domain.` };
	},
	aplicarIdentidad: async ({ locals }) => {
		const u = exigir(locals, 'ajustes');
		const { cambiadas, sinCambiar } = await aplicarIdentidad(u.correo);
		const partes = [
			cambiadas.length === 1
				? '1 honeypot updated: the sensor redeploys it on its next check-in.'
				: `${cambiadas.length} honeypots updated: the sensor redeploys them on its next check-in.`,
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
		return { mensaje: 'Registration activated. You can now deploy the registration honeypots.' };
	},
	renovarRegistro: async ({ locals }) => {
		exigir(locals, 'ajustes');
		const r = await renovar(Date.now(), true);
		if (r === 'renovada') return { mensaje: 'Registration renewed.' };
		const { fallo } = await estadoRegistro();
		return fail(400, { error: fallo ?? 'Could not renew the registration.' });
	},
	comprobarVersion: async ({ locals }) => {
		const u = exigir(locals, 'ajustes');
		if (await gestionado())
			return fail(400, {
				error: 'This node is managed by a Central; new versions arrive from there.'
			});
		const r = await comprobarVersiones();
		await auditar(u.correo, 'version check', { version: r?.version ?? null });
		if (!r)
			return fail(400, {
				error: 'Version checks are turned off: enable the version notice or automatic updates.'
			});
		if (r.rechazada)
			return fail(400, { error: `The published version was not accepted: ${r.rechazada}.` });
		if (!r.red) return fail(400, { error: 'Could not reach the update server.' });
		const actual = (await cabecera()).cliente.version;
		return {
			mensaje:
				r.version && r.version !== actual
					? `Version ${r.version} is published.`
					: 'This node is on the latest published version.'
		};
	},
	politicaActualizacion: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const p =
			f.get('preset') === 'banca'
				? { modo: 'manual' as const, retardoHoras: 72 }
				: politicaDelFormulario(f.get('modo'), f.get('retardo'));
		if (!p)
			return fail(400, {
				error: 'Choose automatic or manual approval and a delay between 0 and 720 hours.'
			});
		const cambiada = await guardarPoliticaActualizacion(u.correo, p);
		return { mensaje: cambiada ? 'Update policy saved.' : 'The update policy has not changed.' };
	},
	aprobarActualizacion: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const version = String((await request.formData()).get('version') ?? '');
		const r = await aprobarActualizacion(u.correo, version, await actualizacion());
		if (r === 'no-pendiente')
			return fail(409, { error: 'That version is no longer the one waiting to be installed.' });
		return {
			mensaje:
				r === 'ya-aprobada'
					? `Version ${version} was already approved.`
					: `Version ${version} approved. The updater installs it when the update policy allows.`
		};
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
			/* Lo que se ve sin preguntar al DNS; el resto se comprueba en cada envío. */
			const servidor = sinCorchetes(new URL(url).hostname);
			const motivo = motivoHost(servidor) ?? (isIP(servidor) ? motivoIp(servidor) : null);
			if (motivo) return fail(400, { error: `The webhook cannot be sent there: ${motivo}.` });
			/* Sin cifrar, solo dentro de su red (con un nombre, se mira en cada envío). */
			if (new URL(url).protocol === 'http:' && isIP(servidor) && !esPrivada(servidor))
				return fail(400, {
					error: 'Unencrypted webhooks are only sent to private addresses. Use an https:// URL.'
				});
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
	conservacionCredenciales: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const texto = String((await request.formData()).get('diasCredenciales') ?? '');
		const dias = validarDiasCredenciales(texto);
		if (!dias)
			return fail(400, {
				error: `The period for captured credentials is in days, between ${DIAS_CREDENCIALES_MINIMO} and ${DIAS_MAXIMO}.`,
				diasCredenciales: texto
			});
		await cambiarPlazoCredenciales(u.correo, dias);
		return { mensaje: `Captured credentials are kept in full for ${dias} days.` };
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
	/* Exigir (o no) el segundo factor a los usuarios locales. */
	segundoFactor: async ({ locals, request }) => {
		const u = exigir(locals, 'ajustes');
		const exigirlo = String((await request.formData()).get('exigir') ?? '') === 'si';
		await fijarExigido(u.correo, exigirlo);
		return {
			mensaje: exigirlo
				? 'Two-factor authentication is now required. Users without it set it up on their next sign-in.'
				: 'Two-factor authentication is now optional. Users who already have it keep using it.'
		};
	},
	/*
	 * Guarda el OIDC propio, pendiente. No se va directo al proveedor: la CSP
	 * (form-action) no deja que un formulario acabe en otro dominio. La prueba es
	 * un enlace (Ajustes → «Test»).
	 */
	oidcGuardar: async ({ locals, request }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const datos = {
			emisor: String(f.get('emisor') ?? ''),
			clientId: String(f.get('clientId') ?? ''),
			secreto: String(f.get('secreto') ?? ''),
			nombre: String(f.get('nombre') ?? ''),
			alcances: String(f.get('alcances') ?? ''),
			claim: String(f.get('claim') ?? ''),
			roles: Object.fromEntries(ROLES.map((r) => [r, String(f.get(`rol-${r}`) ?? '')])),
			exigirMfa: f.get('exigirMfa') === 'si',
			acr: String(f.get('acr') ?? '')
		};
		const r = await guardarOidc(u.correo, datos);
		if (!r.ok) {
			const { secreto, ...valores } = datos;
			void secreto;
			return fail(400, { oidcError: r.error, oidcValores: valores });
		}
		redirect(303, '/settings?tab=access&oidc=guardado#oidc');
	},
	oidcQuitar: async ({ locals }) => {
		const u = exigir(locals, 'ajustes');
		const r = await quitarOidc(u.correo);
		if (!r.ok) return fail(400, { oidcError: r.error });
		redirect(303, '/settings?tab=access#oidc');
	},
	/* Guarda el Entra propio, pendiente, y se va a probarlo con Microsoft. */
	entraGuardar: async ({ locals, request }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const datos = {
			tenant: String(f.get('tenant') ?? ''),
			clientId: String(f.get('clientId') ?? ''),
			secreto: String(f.get('secreto') ?? ''),
			exigirMfa: f.get('exigirMfa') === 'si',
			confirmarSinMfa: f.get('confirmarSinMfa') === 'si',
			contextoAuth: String(f.get('contextoAuth') ?? ''),
			secretoCaduca: String(f.get('secretoCaduca') ?? '')
		};
		const r = await guardarEntraPropio(u.correo, datos);
		if (!r.ok)
			return fail(400, {
				entraError: r.error,
				entraValores: {
					tenant: datos.tenant,
					clientId: datos.clientId,
					exigirMfa: datos.exigirMfa,
					contextoAuth: datos.contextoAuth,
					secretoCaduca: datos.secretoCaduca
				}
			});
		redirect(303, '/auth/login?probar=1');
	},
	entraQuitar: async ({ locals, cookies }) => {
		const u = exigir(locals, 'ajustes');
		const r = await quitarEntraPropio(u.correo, sesionActual(cookies));
		if (!r.ok) return fail(400, { entraError: r.error });
		redirect(303, '/settings#entra');
	},
	/* Último paso de la migración: la consola deja de aceptar el Entra de SeguridadSI. */
	retirarB2B: async ({ locals, cookies }) => {
		const u = exigir(locals, 'ajustes');
		const r = await retirarB2B(u.correo, sesionActual(cookies), await estadoEntraPropio());
		return r.ok
			? { mensaje: `Done: only your own Entra ID signs in now. ${await operador()} has been told.` }
			: fail(400, { migrarError: r.error });
	},
	/* El código se enseña solo en esta respuesta: no se guarda en claro en ningún sitio. */
	codigoEmergencia: async ({ locals, cookies }) => {
		const u = exigir(locals, 'ajustes');
		return { codigoEmergencia: await nuevoCodigoEmergencia(u.correo, sesionActual(cookies)) };
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
	/* Latido mínimo: solo lo de la licencia y las actualizaciones (canal.ts). */
	latidoMinimo: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const activo = (await request.formData()).get('minimo') === 'on';
		await guardarLatidoMinimo(u.correo, activo);
		return {
			mensaje: activo
				? 'Minimal heartbeat on: Central only gets what licensing and updates need.'
				: 'Minimal heartbeat off: Central gets the full heartbeat again.'
		};
	},
	retirarLlave: async ({ locals, request, cookies }) => {
		const u = exigir(locals, 'ajustes');
		const ok = await retirarLlave(
			u.correo,
			String((await request.formData()).get('id')),
			sesionActual(cookies)
		);
		return ok ? { mensaje: 'Key removed.' } : fail(404, { error: 'That key does not exist.' });
	},
	perfilBanca: async ({ locals }) => {
		const u = exigir(locals, 'ajustes');
		const cambios = await aplicarPerfilBanca(u.correo);
		return {
			mensaje: cambios.length
				? `Banking profile applied: ${cambios.join(', ')}.`
				: 'The banking profile was already in place.'
		};
	},
	separacionCredenciales: async ({ locals, request }) => {
		const u = exigir(locals, 'ajustes');
		const activa = (await request.formData()).get('activa') === 'si';
		await fijarSeparacion(u.correo, activa);
		return {
			mensaje: activa
				? 'Administrators can no longer reveal captured credentials.'
				: 'Administrators who also have the credential viewer role can reveal credentials again.'
		};
	},
	posturaSoporte: async ({ locals, request }) => {
		const u = exigir(locals, 'ajustes');
		const banca = (await request.formData()).get('postura') === 'banca';
		await fijarPosturaSoporte(u.correo, banca ? 'banca' : 'estandar');
		return {
			mensaje: banca
				? 'Support access is now just-in-time: each request approved separately, 4 hours at most.'
				: 'Support access is back to the standard policy: up to 30 days, renewable.'
		};
	},
	soporteAceptar: async ({ locals, request }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const horas = horasValidas(f.get('horas'), await posturaSoporte());
		const rol = f.get('rol') === 'operador' ? 'operador' : 'lector';
		const rolNombre = rol === 'operador' ? 'operator' : 'viewer';
		return (await aceptar(u.correo, horas, rol))
			? { mensaje: `Support access opened for ${plazoEnTexto(horas)} as ${rolNombre}.` }
			: fail(400, { error: 'There is no pending request.' });
	},
	soporteRenovar: async ({ locals, request }) => {
		const u = exigir(locals, 'ajustes');
		if ((await posturaSoporte()) === 'banca')
			return fail(400, {
				error: `Just-in-time support access cannot be renewed: ${await operador()} has to request it again.`
			});
		const horas = horasValidas((await request.formData()).get('horas'));
		return (await renovarSoporte(u.correo, horas))
			? { mensaje: `Support access renewed for ${plazoEnTexto(horas)} from now.` }
			: fail(400, { error: 'Support access was not open.' });
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
