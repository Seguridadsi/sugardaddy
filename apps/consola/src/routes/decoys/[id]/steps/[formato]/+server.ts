import { operador } from '$lib/server/operador';
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
	if (!FORMATOS.includes(formato)) error(404, 'These steps cannot be downloaded in that format.');
	const parte = (url.searchParams.get('parte') ?? 'colocar') as PartePasos;
	if (!PARTES.includes(parte)) error(400, 'Choose the deploy, removal or test steps.');
	const r = await descargarPasos(u.correo, params.id, formato, parte);
	if (r === 'no-existe') error(404, 'That decoy does not exist.');
	if (r === 'sin-pasos') error(404, 'This decoy has no manual steps.');
	if (r === 'sin-prueba')
		error(400, 'Click "Test" first: the test script carries the code of that test.');
	if (r === 'otro-lenguaje')
		error(404, 'These steps use a different language: there is no script in that format.');
	if (r === 'no-cuadran')
		error(
			409,
			`The saved steps no longer match their fingerprint, so they cannot be downloaded. Contact ${await operador()}.`
		);
	return new Response(Buffer.from(r.contenido), {
		headers: {
			'content-type': r.tipo,
			'content-disposition': `attachment; filename="${r.nombre}"`,
			'cache-control': 'no-store'
		}
	});
};
