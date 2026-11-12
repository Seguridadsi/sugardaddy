/*
 * Los manifiestos de las trampas de un partner (docs/diseno/trampas-de-partner.md), ya
 * comprobado que son los que firmó (verificarPaquetePartner, en el canal). Aquí se leen
 * con el mismo contrato que los nuestros y se les exige lo que un módulo de partner tiene
 * que cumplir. Lo usan su herramienta de firma, su central y la consola de cada empresa:
 * los tres aplican lo mismo, y el sensor lo vuelve a comprobar.
 */
import { manifiestoParaSensor, proyectarParaSensor } from './honeycosa.ts';
import type { Honeycosa, ManifiestoTrampa } from './tipos.ts';
import { leerHoneycosa, validarCatalogo } from './validar.ts';

/* Lo que el sensor recibiría de una trampa: con la imagen del registro y con la pública. */
export function proyeccionesParaSensor(h: Honeycosa): ManifiestoTrampa[] {
	const salida: ManifiestoTrampa[] = [];
	for (const via of h.vias) {
		if (via.ejecutor !== 'contenedor@1') continue;
		const m = proyectarParaSensor(h, via.id);
		const privada = manifiestoParaSensor(m, true);
		const publica = manifiestoParaSensor(m, false);
		salida.push(privada);
		if (JSON.stringify(privada) !== JSON.stringify(publica)) salida.push(publica);
	}
	return salida;
}

/*
 * Lee los manifiestos de un partner. `techo` dice por qué una proyección para el sensor
 * pasa de lo que un módulo de partner puede pedir (motivoTechoPartner, del canal). O valen
 * todos o no vale ninguno: un catálogo a medias no es el que firmó el partner.
 */
export function leerModulosDePartner(
	manifiestos: Record<string, string>,
	prefijo: string,
	techo: (proyeccion: unknown) => string | null
): { ok: true; honeycosas: Honeycosa[] } | { ok: false; motivo: string } {
	const leidas: Honeycosa[] = [];
	for (const [id, yaml] of Object.entries(manifiestos).sort(([a], [b]) => a.localeCompare(b))) {
		const r = leerHoneycosa(yaml);
		if (!r.ok) return { ok: false, motivo: `"${id}": ${r.errores.join('; ')}` };
		const h = r.valor;
		if (h.id !== id) return { ok: false, motivo: `the manifest of "${id}" says it is "${h.id}"` };
		if (!id.startsWith(`${prefijo}-`))
			return { ok: false, motivo: `"${id}" does not carry the partner prefix "${prefijo}-"` };
		/* Solo contenedores: unos pasos a mano los pegaría el administrador en sus máquinas. */
		if (!h.vias.length || h.vias.some((v) => v.ejecutor !== 'contenedor@1'))
			return { ok: false, motivo: `"${id}": a partner decoy can only be a container` };
		let proyecciones: ManifiestoTrampa[];
		try {
			proyecciones = proyeccionesParaSensor(h);
		} catch (e) {
			return { ok: false, motivo: `"${id}": ${(e as Error).message}` };
		}
		for (const m of proyecciones) {
			const motivo = techo(m);
			if (motivo) return { ok: false, motivo: `"${id}": ${motivo}` };
		}
		leidas.push(h);
	}
	/* Entre ellas y nada más: una trampa de partner no puede apoyarse en un módulo nuestro. */
	const { errores } = validarCatalogo(leidas);
	const [rota] = Object.entries(errores);
	if (rota) return { ok: false, motivo: `"${rota[0]}": ${rota[1].join('; ')}` };
	return { ok: true, honeycosas: leidas };
}
