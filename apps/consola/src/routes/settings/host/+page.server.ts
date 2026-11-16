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
	hechosAnfitrion
} from '$lib/server/anfitrion';

/*
 * La máquina del nodo (lib/server/anfitrion.ts, docs/diseno/cortafuegos-anfitrion.md):
 * lo que el actualizador ve de ella (SSH, Docker, auditd) y el cortafuegos estricto.
 */
export const load = async ({ locals }) => {
	exigir(locals, 'ajustes');
	const ajuste = await ajusteAnfitrion();
	const estado = await estadoEstricto();
	return {
		ajuste,
		efectivo: await estrictoEfectivo(ajuste),
		estado,
		/* Sin noticias en diez minutos: el actualizador no informa (parado, o un nodo de antes). */
		viejo: !estado || Date.now() - new Date(estado.recibido).getTime() > PLAZO_INFORME_MS,
		hechos: await hechosAnfitrion(),
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
				'Saved. The node applies it within a minute; if it loses contact with this console it goes back on its own.'
		};
	}
};
