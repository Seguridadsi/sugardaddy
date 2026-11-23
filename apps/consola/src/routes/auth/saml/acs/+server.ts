import { redirect } from '@sveltejs/kit';
import { ErrorSaml, crearSaml, validarRespuesta } from '$lib/server/auth/saml';
import {
	cacheSaml,
	configSaml,
	gastarIda,
	guardarResultado,
	identidadSaml,
	samlActivo
} from '$lib/server/auth/saml-propio';
import { auditar } from '$lib/server/consultas';

/*
 * ACS: aquí llega el POST del proveedor con la respuesta SAML (HTTP-POST). Es
 * la única ruta a la que se deja un POST de otro origen (csrf.ts): el
 * proveedor está en otro dominio. Sin cookies (SameSite=Lax no viaja en un POST
 * de otro sitio), así que todo sale del RelayState, que dice qué ida es; la
 * sesión se abre después, en /auth/saml/fin, ya con la cookie de la ida.
 */
export const POST = async ({ request }) => {
	let SAMLResponse = '';
	let RelayState = '';
	try {
		const f = await request.formData();
		SAMLResponse = String(f.get('SAMLResponse') ?? '');
		RelayState = String(f.get('RelayState') ?? '');
	} catch {
		/* Cuerpo que no es un formulario: se trata como respuesta vacía. */
	}
	const ida = RelayState ? gastarIda(RelayState) : null;
	const probar = !!ida?.probar;
	function fuera(motivo: string): never {
		redirect(303, probar ? `/settings?tab=access&saml=${motivo}#saml` : `/sign-in?error=${motivo}`);
	}
	if (!SAMLResponse) fuera('caducado');
	if (!ida) {
		/* Sin ida de esta consola: iniciada por el proveedor, repetida o de hace más de diez minutos. */
		await auditar('anonymous', 'sign-in denied', { via: 'saml', motivo: 'unknown RelayState' });
		fuera('caducado');
	}

	const c = probar ? await configSaml() : await samlActivo();
	if (!c) fuera(probar ? 'sin-config' : 'idp');

	let a;
	try {
		a = await validarRespuesta(
			crearSaml(c.config, cacheSaml()),
			c.config,
			SAMLResponse,
			RelayState
		);
	} catch (e) {
		const motivo = e instanceof ErrorSaml ? e.motivo : 'firma';
		console.error('[saml] response rejected', (e as Error).message);
		await auditar('anonymous', 'sign-in denied', {
			via: 'saml',
			motivo,
			detalle: (e as Error).message.slice(0, 300)
		});
		fuera(probar ? `respuesta-${motivo}` : motivo === 'estado' ? 'idp_rechazado' : 'idp_canje');
	}

	const r = identidadSaml(a, c.guardado);
	if ('rechazo' in r) {
		await auditar('anonymous', 'sign-in denied', {
			via: 'saml',
			motivo: r.rechazo,
			nameId: a.nameId.slice(0, 80),
			contextos: a.contextos.slice(0, 5)
		});
		fuera(r.rechazo === 'sin_rol' || r.rechazo === 'sin_correo' ? r.rechazo : `idp_${r.rechazo}`);
	}
	if (probar && !r.roles.includes('admin')) fuera('sin-admin');

	const ficha = guardarResultado({ identidad: r, relay: RelayState, probar });
	if (!ficha) fuera(probar ? 'ida' : 'idp');
	redirect(303, `/auth/saml/fin?ficha=${encodeURIComponent(ficha)}`);
};
