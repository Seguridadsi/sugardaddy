/*
 * Ajustes → Backups: adónde salen las copias del nodo (copias-fuera.ts), cómo van y
 * la prueba de restauración. El actualizador hace el trabajo; aquí solo se elige
 * el destino y se ve lo que cuenta.
 */
import { fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { exigir } from '$lib/server/auth/permisos';
import {
	CONSERVAR_DEFECTO,
	HORAS_SIN_COPIA,
	PRUEBA_CADA_DIAS,
	SinClave,
	dondeVa,
	guardarDestino,
	huellaDestino,
	leerDestino,
	leerEstado,
	pedir,
	problemasCopias,
	quitarDestino,
	validar
} from '$lib/server/copias-fuera';
import { descifrar, estadoClave, TEXTO_ILEGIBLE } from '$lib/server/secretos';

export const load = async ({ locals }) => {
	const u = exigir(locals, 'ajustes');
	const d = await leerDestino();
	const e = await leerEstado();
	const leido = d ? descifrar(d.secreto, 'copias-destino') : null;
	const deAhora = !!d && e.huella === huellaDestino(d);
	const proxima =
		d?.activo && deAhora && e.ultimaSubida
			? e.prueba
				? new Date(
						Date.parse(e.prueba.cuando) +
							(e.prueba.resultado === 'fallo' ? 1 : PRUEBA_CADA_DIAS) * 86400_000
					).toISOString()
				: 'pronto'
			: null;
	return {
		soporte: !!u.soporte,
		claveLista: estadoClave() === 'lista',
		carpeta: env.NODO_DIR || '/opt/sugardaddy',
		conservarDefecto: CONSERVAR_DEFECTO,
		horasSinCopia: HORAS_SIN_COPIA,
		pruebaCadaDias: PRUEBA_CADA_DIAS,
		destino: d
			? {
					version: d.version,
					activo: d.activo,
					tipo: d.tipo,
					conservar: d.conservar,
					inmutable: d.inmutable,
					s3: d.s3 ?? null,
					azure: d.azure ?? null,
					smb: d.smb ?? null,
					final: d.final,
					cambiado: d.cambiado,
					quien: d.quien,
					donde: dondeVa(d),
					ilegible: leido && !leido.ok ? TEXTO_ILEGIBLE[leido.motivo] : null,
					pedidos: { comprobar: !!d.pedidos?.comprobar, prueba: !!d.pedidos?.prueba }
				}
			: null,
		/* Lo que cuenta el actualizador; lo del destino, solo si es del de ahora. */
		estado: {
			informe: e.informe,
			local: e.local,
			ultimaSubida: deAhora ? e.ultimaSubida : null,
			ultimoError: deAhora ? e.ultimoError : null,
			remotas: deAhora ? e.remotas : [],
			remotasCuando: deAhora ? e.remotasCuando : null,
			bloqueadas: deAhora ? e.bloqueadas : 0,
			avisos: deAhora ? e.avisos : [],
			prueba: deAhora ? e.prueba : null,
			conexion: deAhora ? e.conexion : null
		},
		proximaPrueba: proxima,
		problemas: problemasCopias(d, e).map((p) => ({ titulo: p.titulo, texto: p.texto }))
	};
};

const sinSoporte = (u: { soporte?: unknown }) =>
	u.soporte
		? fail(403, {
				error:
					'Support sessions cannot change where the backups go. Sign in with your own administrator account.'
			})
		: null;

export const actions = {
	guardar: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const no = sinSoporte(u);
		if (no) return no;
		const f = Object.fromEntries(
			[...(await request.formData()).entries()].map(([k, v]) => [k, String(v)])
		);
		const previo = await leerDestino();
		const v = validar(f, previo);
		/* Lo escrito vuelve al formulario, nunca el secreto. */
		const valores = { ...f, secreto: '' };
		if (!v.ok) return fail(400, { error: v.error, valores });
		try {
			const version = f.version ? Number(f.version) : null;
			if (!(await guardarDestino(v, u.correo, version)))
				return fail(409, {
					error: 'Someone changed the destination meanwhile. Reload the page and try again.',
					valores
				});
		} catch (e) {
			if (e instanceof SinClave) return fail(400, { error: e.message, valores });
			throw e;
		}
		return {
			mensaje: v.destino.activo
				? 'Saved. The node updater picks it up within a minute and uploads the latest backup; check the Status tab.'
				: 'Saved, paused: backups stay on this machine until you resume.'
		};
	},
	quitar: async ({ locals }) => {
		const u = exigir(locals, 'ajustes');
		const no = sinSoporte(u);
		if (no) return no;
		await quitarDestino(u.correo);
		return {
			mensaje:
				'Removed. Backups stay on this machine; the copies already in your storage are not touched.'
		};
	},
	comprobar: async ({ locals }) => {
		const u = exigir(locals, 'ajustes');
		if (!(await pedir('comprobar', u.correo)))
			return fail(400, { error: 'There is no active destination to check.' });
		return {
			mensaje:
				'Asked the node updater to check the destination: the result appears here within a minute.'
		};
	},
	probar: async ({ locals }) => {
		const u = exigir(locals, 'ajustes');
		if (!(await pedir('prueba', u.correo)))
			return fail(400, { error: 'There is no active destination to test.' });
		return {
			mensaje:
				'Asked the node updater for a restore test of the latest backup in your storage: the result appears here in a few minutes.'
		};
	}
};
