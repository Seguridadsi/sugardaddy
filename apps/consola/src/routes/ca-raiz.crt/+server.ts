import { error } from '@sveltejs/kit';
import { readFileSync } from 'node:fs';
import { env } from '$env/dynamic/private';

/*
 * La raíz de la CA propia del nodo, para instalarla como raíz de confianza en
 * los equipos que entran a la consola. Va sin sesión: es pública (un
 * certificado, sin clave), hace falta justo antes de poder entrar sin avisos
 * y en el appliance no hay shell para sacar ca-raiz.crt de la máquina. Quien
 * la descarga compara su huella con la que dio el instalador o la pantalla.
 */
export const GET = () => {
	if (env.TLS_MODO === 'ficheros')
		error(404, 'Esta consola usa un certificado de tu empresa: no hay raíz que instalar.');
	let pem = '';
	try {
		pem = readFileSync(env.CA_RAIZ ?? '', 'utf8');
	} catch {
		/* se dice abajo */
	}
	const raiz = pem.match(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/);
	if (!raiz) error(503, 'La raíz de la CA aún no está lista: vuelve a intentarlo en unos minutos.');
	return new Response(`${raiz[0]}\n`, {
		headers: {
			'content-type': 'application/x-x509-ca-cert',
			'content-disposition': 'attachment; filename="ca-raiz.crt"',
			'cache-control': 'no-store'
		}
	});
};
