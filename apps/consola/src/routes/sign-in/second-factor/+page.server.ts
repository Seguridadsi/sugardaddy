import { fail, redirect } from '@sveltejs/kit';
import { sinLlavePorIp } from '$lib/llave-por-ip';
import { qrDataUri } from '$lib/server/qr';
import {
	cerrarPaso,
	codigosRestantes,
	despuesDelFactor,
	factores,
	leerPaso,
	secretoAlta,
	totpDisponible,
	altaEnPasoTotp,
	verificarCodigo,
	verificarRecuperacion
} from '$lib/server/auth/segundo-factor';
import { pendientesAlEntrar } from '$lib/server/auth/local';
import { secretoLegible, uriOtpauth } from '$lib/server/auth/totp';

/*
 * El segundo paso de la entrada con login local (segundo-factor.ts): comprobar
 * el segundo factor o, si se exige y aún no tiene, darlo de alta. Sin un paso
 * válido (cookie bajo /sign-in, diez minutos) se vuelve a la contraseña.
 */
export const load = async ({ cookies, url, locals }) => {
	if (locals.usuario) redirect(303, '/');
	const p = leerPaso(cookies);
	if (!p) {
		cerrarPaso(cookies);
		redirect(303, '/sign-in');
	}
	const porIp = sinLlavePorIp(url.hostname);
	if (p.modo === 'verificar') {
		const suyos = await factores(p.id);
		return {
			modo: 'verificar' as const,
			passkeys: suyos.filter((f) => f.tipo === 'passkey').length,
			apps: suyos.filter((f) => f.tipo === 'totp').length,
			codigos: await codigosRestantes(p.id),
			porIp
		};
	}
	const usuario = (await pendientesAlEntrar(p.id))?.usuario ?? 'user';
	const conTotp = totpDisponible();
	const secreto = conTotp ? secretoAlta(p) : null;
	const uri = secreto ? uriOtpauth(secreto, `${usuario}@${url.hostname}`) : null;
	return {
		modo: 'alta' as const,
		hecho: !!p.hecho,
		totp: secreto && uri ? { qr: qrDataUri(uri), secreto: secretoLegible(secreto) } : null,
		porIp
	};
};

/* Sin paso (caducó o se acabaron los intentos): de vuelta a la contraseña. */
function sinPaso() {
	return fail(400, { error: 'Sign-in has expired. Sign in again.', fin: true });
}

export const actions = {
	codigo: async ({ request, cookies }) => {
		const p = leerPaso(cookies);
		if (!p || p.modo !== 'verificar') return sinPaso();
		const r = await verificarCodigo(
			cookies,
			p,
			String((await request.formData()).get('codigo') ?? '')
		);
		if (!r.ok) return fail(400, { error: r.error, fin: !!r.fin });
		cerrarPaso(cookies);
		redirect(303, await despuesDelFactor(cookies, p.id, p.identidad, p.volverA, r.factor));
	},
	recuperacion: async ({ request, cookies }) => {
		const p = leerPaso(cookies);
		if (!p || p.modo !== 'verificar') return sinPaso();
		const r = await verificarRecuperacion(
			cookies,
			p,
			String((await request.formData()).get('codigo') ?? '')
		);
		if (!r.ok) return fail(400, { error: r.error, fin: !!r.fin, recuperacion: true });
		cerrarPaso(cookies);
		redirect(303, await despuesDelFactor(cookies, p.id, p.identidad, p.volverA, r.factor));
	},
	/* Alta de una app de autenticación: comprueba el primer código y da los códigos de recuperación. */
	alta: async ({ request, cookies }) => {
		const p = leerPaso(cookies);
		if (!p || p.modo !== 'alta') return sinPaso();
		const f = await request.formData();
		const r = await altaEnPasoTotp(p, String(f.get('codigo') ?? ''), String(f.get('nombre') ?? ''));
		if (!r.ok) return fail(400, { error: r.error });
		return { codigos: r.codigos };
	},
	/* Ya guardó sus códigos: a lo siguiente. */
	seguir: async ({ cookies }) => {
		const p = leerPaso(cookies);
		if (!p || p.modo !== 'alta' || !p.hecho) return sinPaso();
		cerrarPaso(cookies);
		redirect(303, await despuesDelFactor(cookies, p.id, p.identidad, p.volverA, p.hecho));
	}
};
