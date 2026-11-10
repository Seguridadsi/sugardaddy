import { fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { exigir } from '$lib/server/auth/permisos';
import {
	MAX_ENTRADAS,
	cortafuegos,
	cortafuegosConfirma,
	dejarAbierta,
	esLocal,
	guardarAcceso,
	leerAcceso,
	propuestaDelInstalador,
	sensoresFuera,
	sensoresSinDireccion
} from '$lib/server/acceso';
import { normalizarIp } from '$lib/server/pruebas';

/* La IP del navegador tal como la ve la consola (la que pone Caddy). */
function ipDe(getClientAddress: () => string): string | null {
	try {
		return normalizarIp(getClientAddress());
	} catch {
		return null;
	}
}

export const load = async ({ locals, getClientAddress }) => {
	exigir(locals, 'ajustes');
	const ip = ipDe(getClientAddress);
	const acceso = await leerAcceso();
	const c = await cortafuegos();
	return {
		acceso,
		cortafuegos: c,
		confirmado: cortafuegosConfirma(acceso, c),
		/* Sensores remotos que ya conectan desde fuera de la lista guardada: se proponen. */
		sensoresFuera: await sensoresFuera(acceso.entradas),
		sensoresSinDireccion: await sensoresSinDireccion(),
		ip,
		local: esLocal(ip),
		propuesta: propuestaDelInstalador(),
		carpeta: env.NODO_DIR || '/opt/sugardaddy',
		maximo: MAX_ENTRADAS
	};
};

export const actions = {
	limitar: async ({ request, locals, getClientAddress }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const redes = f.getAll('red').map(String);
		const notas = f.getAll('nota').map(String);
		const sensores = f.getAll('sensor').map(String);
		const filas = redes.map((red, i) => ({
			red,
			nota: notas[i] ?? '',
			sensor: sensores[i] || undefined
		}));
		const ip = ipDe(getClientAddress);
		const version = Number(f.get('version'));
		const r = await guardarAcceso(u.correo, filas, ip, esLocal(ip), {
			version: Number.isInteger(version) ? version : undefined,
			cortarSensores: f.get('cortarSensores') === 'si'
		});
		if (!r.ok) return fail(400, { error: r.error, filas });
		redirect(303, '/settings/access?guardado=1');
	},
	abrir: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		if ((await request.formData()).get('entiendo') !== 'si')
			return fail(400, {
				error: 'Confirm that you understand anyone who reaches this machine will see the console.'
			});
		await dejarAbierta(u.correo);
		redirect(303, '/settings/access?abierta=1');
	}
};
