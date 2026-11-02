import { fail } from '@sveltejs/kit';
import { isIP } from 'node:net';
import { exigir } from '$lib/server/auth/permisos';
import { anadirALista, comparticion, guardarComparticion, listasDe } from '$lib/server/consultas';
import { normalizarDominio } from '$lib/server/dominios';
import { cambiarUsoTor, listaTor, usoTor } from '$lib/server/tor';

/* Una IP, una red en CIDR o un dominio. Devuelve además el valor ya normalizado
 * (el dominio en minúsculas, sin punto final). null si no es nada de eso. */
function clasificar(valor: string): { clase: 'ip' | 'red' | 'dominio'; valor: string } | null {
	if (isIP(valor)) return { clase: 'ip', valor };
	const [base, mascara] = valor.split('/');
	const bits = isIP(base);
	const n = Number(mascara);
	if (bits && /^\d{1,3}$/.test(mascara ?? '') && n >= 8 && n <= (bits === 4 ? 32 : 128))
		return { clase: 'red', valor };
	const dominio = normalizarDominio(valor);
	return dominio ? { clase: 'dominio', valor: dominio } : null;
}

export const load = async ({ url }) => {
	const pedida = url.searchParams.get('lista');
	const lista = pedida === 'blanca' ? 'blanca' : pedida === 'tor' ? 'tor' : 'negra';
	const { entradas, cuentas } = await listasDe(lista === 'blanca' ? 'blanca' : 'negra');
	const tor = await listaTor();
	return {
		lista,
		ahora: Date.now(),
		entradas: lista === 'tor' ? [] : entradas,
		cuentas: { ...cuentas, tor: tor?.ips.length ?? 0 },
		comparticion: await comparticion(),
		tor: tor
			? { ips: lista === 'tor' ? tor.ips : [], emitida: tor.emitida, fuente: tor.fuente }
			: null,
		usoTor: await usoTor()
	};
};

export const actions = {
	anadir: async ({ request, locals }) => {
		const u = exigir(locals, 'listas');
		const form = await request.formData();
		const lista = form.get('lista') === 'blanca' ? 'blanca' : 'negra';
		const valor = String(form.get('valor') ?? '').trim();
		const motivo = String(form.get('motivo') ?? '').trim();
		const dias = Number(form.get('dias') ?? 0);

		const c = clasificar(valor);
		if (!c)
			return fail(400, {
				error: 'Escribe una IP, una red en CIDR (mínimo /8) o un dominio.',
				valor,
				motivo
			});
		if (!motivo)
			return fail(400, { error: 'Explica el motivo: queda en los logs.', valor, motivo });
		const nuevo = await anadirALista(u.correo, {
			valor: c.valor,
			clase: c.clase,
			lista,
			motivo,
			caduca: dias > 0 ? new Date(Date.now() + dias * 86_400_000) : null
		});
		if (!nuevo) return fail(400, { error: 'Ya está en la lista.', valor, motivo });
		return { anadido: valor };
	},

	tor: async ({ request, locals }) => {
		const u = exigir(locals, 'listas');
		await cambiarUsoTor(u.correo, { edl: (await request.formData()).get('edl') === 'on' });
		return { guardadoTor: true };
	},

	comparticion: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const form = await request.formData();
		await guardarComparticion(u.correo, {
			compartir: form.get('compartir') === 'on',
			recibir: form.get('recibir') === 'on'
		});
		return { guardado: true };
	}
};
