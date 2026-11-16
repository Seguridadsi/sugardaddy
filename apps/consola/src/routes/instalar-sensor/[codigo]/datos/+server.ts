import {
	ErrorCliente,
	datosParaEtapa1,
	errorEtapa1,
	versionParaEtapa1
} from '$lib/server/sensores-remotos';

/*
 * Lo que pide la primera etapa verificada en la máquina de un sensor remoto
 * (docs/diseno/instalador-verificado.md, «Sensor remoto»). Solo datos, como
 * registros de texto: GET la versión firmada y las piezas que comprueba (no gasta
 * el código); POST los datos del sensor (lo gasta). Siempre 200: el error va como
 * registro y lo cuenta la etapa 1.
 */
const texto = (cuerpo: string) =>
	new Response(cuerpo, {
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
	});
const USADA =
	'this line has already been used or has expired. Generate a new one under Sensors in the console.';

async function responder(hacer: () => Promise<string | null>) {
	try {
		return texto((await hacer()) ?? errorEtapa1(USADA));
	} catch (e) {
		if (e instanceof ErrorCliente) return texto(errorEtapa1(e.message));
		console.error('[instalar-sensor/datos]', e);
		return texto(
			errorEtapa1(
				'the console could not prepare the installation. Try again in a few minutes.',
				true
			)
		);
	}
}

export const GET = ({ params }) => responder(() => versionParaEtapa1(params.codigo));
export const POST = ({ params }) => responder(() => datosParaEtapa1(params.codigo));
