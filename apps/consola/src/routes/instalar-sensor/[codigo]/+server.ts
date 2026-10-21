import { ErrorCliente, scriptSensorRemoto } from '$lib/server/sensores-remotos';

/*
 * Siempre 200: con «curl -f», un 4xx o 5xx se tragaría el mensaje y quien
 * instala no sabría qué pasa. El error va en el propio script, que lo escribe
 * y sale con 1.
 */
const script = (cuerpo: string) =>
	new Response(cuerpo, {
		headers: { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store' }
	});
const fallo = (mensaje: string) =>
	script(`echo ${JSON.stringify(`Sugardaddy: ${mensaje}`)} >&2\nexit 1\n`);

/* Lo que ejecuta `curl … | sudo bash` en la máquina del sensor. */
export const GET = async ({ params }) => {
	try {
		const s = await scriptSensorRemoto(params.codigo);
		if (!s)
			return fallo('esta línea ya se usó o ha caducado. Genera otra en Sensores de la consola.');
		return script(s);
	} catch (e) {
		if (e instanceof ErrorCliente) return fallo(e.message);
		console.error('[instalar-sensor]', e);
		return fallo(
			'la consola no ha podido preparar la instalación. Inténtalo de nuevo en unos minutos; si sigue, avisa a SeguridadSI.'
		);
	}
};
