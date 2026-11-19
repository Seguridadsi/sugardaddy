import { fail } from '@sveltejs/kit';
import { exigir } from '$lib/server/auth/permisos';
import {
	MAX_DESTINOS,
	MAX_REDES,
	PLAZO_INFORME_MS,
	ajusteAnfitrion,
	destinosEfectivos,
	estadoEstricto,
	estrictoEfectivo,
	guardarAjusteAnfitrion,
	hechosAnfitrion,
	maquinasSensores
} from '$lib/server/anfitrion';
import { estadoIntegridad } from '$lib/server/integridad';

/*
 * La máquina del nodo (lib/server/anfitrion.ts, docs/diseno/cortafuegos-anfitrion.md):
 * lo que el actualizador ve de ella (SSH, Docker, auditd) y el cortafuegos estricto.
 * Y la de cada sensor remoto, con el mismo ajuste.
 */
export const load = async ({ locals }) => {
	exigir(locals, 'ajustes');
	const ajuste = await ajusteAnfitrion();
	const estado = await estadoEstricto();
	/* La última comprobación de integridad del actualizador (integridad.ts), con su detalle. */
	const integridad = await estadoIntegridad();
	return {
		integridad,
		integridadVieja:
			!!integridad && Date.now() - new Date(integridad.comprobado).getTime() > 30 * 60_000,
		ajuste,
		efectivo: await estrictoEfectivo(ajuste),
		estado,
		/* Sin noticias en diez minutos: el actualizador no informa (parado, o un nodo de antes). */
		viejo: !estado || Date.now() - new Date(estado.recibido).getTime() > PLAZO_INFORME_MS,
		hechos: await hechosAnfitrion(),
		sensores: await maquinasSensores(),
		salida: ajuste.salida.restringida ? await destinosEfectivos(ajuste) : null,
		maxRedes: MAX_REDES,
		maxDestinos: MAX_DESTINOS
	};
};

const lineas = (v: FormDataEntryValue | null) =>
	String(v ?? '')
		.split(/[\s,]+/)
		.map((x) => x.trim())
		.filter(Boolean);

export const actions = {
	guardar: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const modo = String(f.get('estricto') ?? 'serie');
		const r = await guardarAjusteAnfitrion(u.correo, {
			estricto: modo === 'si' ? true : modo === 'no' ? false : null,
			sshPuerto: Number(f.get('sshPuerto') ?? 22),
			sshRedes: lineas(f.get('sshRedes')),
			restringida: f.get('restringida') === 'on',
			destinos: lineas(f.get('destinos'))
		});
		if (!r.ok) return fail(400, { error: r.error });
		return {
			mensaje:
				'Saved. The node and its remote sensors apply it within a minute; one that loses contact with this console goes back on its own.'
		};
	}
};
