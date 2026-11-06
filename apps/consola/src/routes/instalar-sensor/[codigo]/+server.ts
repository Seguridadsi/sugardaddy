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
			return fallo(
				'this command has already been used or has expired. Generate a new one under Sensors in the console.'
			);
		return script(s);
	} catch (e) {
		if (e instanceof ErrorCliente) return fallo(e.message);
		console.error('[instalar-sensor]', e);
		return fallo(
			'the console could not prepare the installation. Try again in a few minutes; if it keeps failing, contact your support provider.'
		);
	}
};
