import { error } from '@sveltejs/kit';
import type { FormatoPasos, PartePasos } from '@sugardaddy/contrato';
import { exigir } from '$lib/server/auth/permisos';
import { FORMATOS, PARTES, descargarPasos } from '$lib/server/pasos';

/*
 * Los pasos de una trampa a mano para descargar (docs/diseno/modulo-despliegue.md
 * §6.3): el script de colocar, de retirar (?parte=retirar) o de probar
 * (?parte=probar, con el código de su prueba abierta, §8.3) en su lenguaje,
 * o el documento para la gestión de cambios (.md, .txt). Siempre lo guardado
 * al generarlos. Descargar es parte de ponerla, probarla o quitarla: lo hace
 * quien despliega, y queda en la auditoría.
 */
export const GET = async ({ params, url, locals }) => {
	const u = exigir(locals, 'desplegar');
	const formato = params.formato as FormatoPasos;
	if (!FORMATOS.includes(formato)) error(404, 'Esos pasos no se descargan en ese formato.');
	const parte = (url.searchParams.get('parte') ?? 'colocar') as PartePasos;
	if (!PARTES.includes(parte)) error(400, 'Elige los pasos de colocar, de retirar o de probar.');
	const r = await descargarPasos(u.correo, params.id, formato, parte);
	if (r === 'no-existe') error(404, 'Esa trampa no existe.');
	if (r === 'sin-pasos') error(404, 'Esta trampa no tiene pasos a mano.');
	if (r === 'sin-prueba')
		error(400, 'Pulsa «Probar» primero: el script de la prueba lleva el código de esa prueba.');
	if (r === 'otro-lenguaje')
		error(404, 'Estos pasos son de otro lenguaje: no hay script en ese formato.');
	if (r === 'no-cuadran')
		error(
			409,
			'Los pasos guardados ya no cuadran con su huella: no se descargan. Avisa a SeguridadSI.'
		);
	return new Response(Buffer.from(r.contenido), {
		headers: {
			'content-type': r.tipo,
			'content-disposition': `attachment; filename="${r.nombre}"`,
			'cache-control': 'no-store'
		}
	});
};
