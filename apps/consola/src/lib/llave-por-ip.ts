/*
 * Las llaves FIDO2 y las passkeys (WebAuthn) van atadas a un nombre de dominio:
 * el navegador las rechaza si se entra a la consola por una IP («… is an
 * invalid domain»), y también con un aviso de certificado. Entrando así, la
 * entrada de emergencia es el código. Puro: lo usan las páginas y el servidor.
 */
export const esIp = (host: string) =>
	/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[');

export const sinLlavePorIp = (host: string) =>
	esIp(host)
		? `FIDO2 keys and passkeys only work if you open the console by its name (a domain), not by an IP address like ${host}: the browser does not allow them. When connecting by IP, use the emergency code.`
		: null;
