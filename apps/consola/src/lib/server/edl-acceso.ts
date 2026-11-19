import { timingSafeEqual } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

/*
 * Quién puede leer la lista dinámica (EDL). Palo Alto y FortiGate solo saben
 * mandar usuario y contraseña (Basic), así que vale eso, con cualquier usuario y
 * el token de contraseña, además de «Bearer <token>» para scripts y SIEM.
 */
export const USUARIO_EDL = 'sugardaddy';

export function tokenEdl(): string | null {
	const t = env.EDL_TOKEN;
	return t && t.length >= 32 ? t : null;
}

function dadoEn(cabecera: string | null): string {
	if (!cabecera) return '';
	const [esquema, valor = ''] = cabecera.split(' ', 2);
	if (/^bearer$/i.test(esquema)) return valor.trim();
	if (/^basic$/i.test(esquema)) {
		const claro = Buffer.from(valor.trim(), 'base64').toString('utf8');
		const dos = claro.indexOf(':');
		return dos < 0 ? '' : claro.slice(dos + 1);
	}
	return '';
}

/* null si puede leerla; si no, la respuesta que hay que dar (503 o 401). */
export function rechazoEdl(request: Request): Response | null {
	const esperado = tokenEdl();
	if (!esperado) error(503, 'The firewall list is not configured');
	const dado = Buffer.from(dadoEn(request.headers.get('authorization')));
	const b = Buffer.from(esperado);
	if (dado.length === b.length && timingSafeEqual(dado, b)) return null;
	return new Response('Invalid token\n', {
		status: 401,
		headers: { 'www-authenticate': 'Basic realm="Sugardaddy EDL"' }
	});
}
