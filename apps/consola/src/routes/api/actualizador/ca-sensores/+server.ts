import { json } from '@sveltejs/kit';
import { exigirActualizador } from '$lib/server/actualizador';
import { asegurarCaSensores } from '$lib/server/ca-sensores';

/*
 * La raíz de la CA de sensores (docs/diseno/mtls-sensores.md): el actualizador
 * del nodo la pone en .env (CA_SENSORES) para que Caddy pida certificado de
 * cliente con ella. null sin CLAVE_SECRETOS: Caddy sigue sin pedirlo.
 */
export const GET = async ({ request }) => {
	exigirActualizador(request);
	const ca = await asegurarCaSensores();
	return json({ raiz: ca?.raiz ?? null });
};
