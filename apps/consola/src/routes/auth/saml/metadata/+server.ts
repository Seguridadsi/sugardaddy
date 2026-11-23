import { error } from '@sveltejs/kit';
import { metadatosSp } from '$lib/server/auth/saml';
import { configSaml } from '$lib/server/auth/saml-propio';

/*
 * Los metadatos del SP (esta consola), firmados: la entidad, el ACS y el
 * certificado para firmar las idas y cifrar las aserciones. Públicos, como los
 * de cualquier SP: el proveedor puede leerlos de aquí. Con ?descargar, como fichero.
 */
export const GET = async ({ url }) => {
	const c = await configSaml();
	if (!c) error(404, 'SAML sign-in is not configured');
	const xml = metadatosSp(c.config);
	return new Response(xml, {
		headers: {
			'content-type': 'application/samlmetadata+xml; charset=utf-8',
			'cache-control': 'no-store',
			...(url.searchParams.has('descargar')
				? { 'content-disposition': 'attachment; filename="sugardaddy-sp-metadata.xml"' }
				: {})
		}
	});
};
