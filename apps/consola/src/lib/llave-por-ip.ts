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
		? `Las llaves FIDO2 y las passkeys solo funcionan si entras a la consola por su nombre (un dominio), no por una IP como ${host}: el navegador no las deja. Entrando por IP, usa el código de emergencia.`
		: null;
