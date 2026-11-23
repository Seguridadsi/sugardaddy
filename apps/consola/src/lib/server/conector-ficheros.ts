/*
 * Colocar ficheros cebo en SharePoint y OneDrive (D3) es de Cloud. En esta edición no hay
 * conexión de Microsoft 365 ni nada que colocar, retirar o vigilar por un conector.
 */
export type VistaConexion = {
	tenant: string;
	aplicacion: string;
	estado: 'activa' | 'fallo' | 'sin-probar';
	error: string | null;
	comprobada: string | null;
	conSecreto: boolean;
};
export type ResultadoPruebaConexion =
	| { ok: true; avisos: string[]; carpeta?: { web: string } }
	| { ok: false; error: string; avisos: string[] };

const NO_ESTA = 'Not available in this edition.';

export async function conexionDeDestino(
	_destino: string
): Promise<{ conexion: VistaConexion | null } | null> {
	return null;
}
export async function guardarConexion(
	_quien: string,
	_destino: string,
	_f: FormData
): Promise<{ ok: true } | { ok: false; error: string }> {
	return { ok: false, error: NO_ESTA };
}
export async function quitarConexion(_quien: string, _destino: string): Promise<void> {}
export async function probarConexion(
	_quien: string,
	_destino: string,
	_carpeta?: string
): Promise<ResultadoPruebaConexion> {
	return { ok: false, error: NO_ESTA, avisos: [] };
}
export async function colocarPorConector(
	_id: string
): Promise<'colocada' | 'fallo' | 'nada' | 'ocupada'> {
	return 'nada';
}
export async function retirarPorConector(
	_id: string,
	_quien: string
): Promise<'retirada' | 'cambiada' | 'fallo' | 'nada' | 'ocupada'> {
	return 'nada';
}
export async function vigilarConectores(): Promise<void> {}
