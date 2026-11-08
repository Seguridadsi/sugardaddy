import { fail } from '@sveltejs/kit';
import { isIP } from 'node:net';
import { exigir } from '$lib/server/auth/permisos';
import { anadirALista, listasDe } from '$lib/server/consultas';
import { normalizarDominio } from '$lib/server/dominios';
import { migrados } from '$lib/server/origenes-comun';
import { cambiarUsoTor, listaTor, usoTor } from '$lib/server/tor';

/* Una IP, una red en CIDR o un dominio. Devuelve además el valor ya normalizado
 * (el dominio en minúsculas, sin punto final). null si no es nada de eso. */
function clasificar(valor: string): { clase: 'ip' | 'red' | 'dominio'; valor: string } | null {
	if (isIP(valor)) return { clase: 'ip', valor };
	const partes = valor.split('/');
	const [base, mascara] = partes;
	const bits = isIP(base);
	const n = Number(mascara);
	if (
		partes.length === 2 &&
		bits &&
		/^\d{1,3}$/.test(mascara ?? '') &&
		n >= 8 &&
		n <= (bits === 4 ? 32 : 128)
	)
		return { clase: 'red', valor };
	const dominio = normalizarDominio(valor);
	return dominio ? { clase: 'dominio', valor: dominio } : null;
}

export const load = async ({ url }) => {
	const pedida = url.searchParams.get('lista');
	const lista = pedida === 'blanca' ? 'blanca' : pedida === 'tor' ? 'tor' : 'negra';
	const { entradas, cuentas } = await listasDe(lista === 'blanca' ? 'blanca' : 'negra');
	const tor = await listaTor();
	/*
	 * Con Orígenes conocidos, las IP y redes de la blanca viven allí: las que se
	 * copiaron ya no se enseñan aquí (siguen en la tabla, por si se vuelve a una
	 * consola anterior). En community no hay migración y todo sigue igual.
	 */
	const m = await migrados();
	const pasadas = new Set(m?.listas ?? []);
	const blancas = lista === 'blanca' ? entradas.filter((l) => !pasadas.has(l.id)) : entradas;
	return {
		lista,
		ahora: Date.now(),
		origenes: !!m,
		pasadas: pasadas.size,
		entradas: lista === 'tor' ? [] : blancas,
		cuentas: {
			...cuentas,
			blanca: lista === 'blanca' ? blancas.length : cuentas.blanca - pasadas.size,
			tor: tor?.ips.length ?? 0
		},
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
				error: 'Enter an IP address, a network in CIDR notation (/8 or smaller), or a domain.',
				valor,
				motivo
			});
		if (!motivo)
			return fail(400, {
				error: 'Give a reason: it is recorded in the audit logs.',
				valor,
				motivo
			});
		/* Una IP o red de confianza es un origen conocido: se da de alta allí. */
		if (lista === 'blanca' && c.clase !== 'dominio' && (await migrados()))
			return fail(400, {
				error: 'Trusted IPs and networks are added under Known sources.',
				aOrigenes: c.valor,
				valor,
				motivo
			});
		const nuevo = await anadirALista(u.correo, {
			valor: c.valor,
			clase: c.clase,
			lista,
			motivo,
			caduca: dias > 0 ? new Date(Date.now() + dias * 86_400_000) : null
		});
		if (!nuevo) return fail(400, { error: 'It is already on the list.', valor, motivo });
		return { anadido: valor };
	},

	tor: async ({ request, locals }) => {
		const u = exigir(locals, 'listas');
		await cambiarUsoTor(u.correo, { edl: (await request.formData()).get('edl') === 'on' });
		return { guardadoTor: true };
	}
};
