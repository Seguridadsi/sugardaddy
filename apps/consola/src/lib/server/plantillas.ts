/* Las plantillas de trampas vienen en Sugardaddy Cloud: en Community no hay ninguna. */
export const plantillasDisponibles = () => false;
export const nombresDePlantillas = async (): Promise<Record<string, string>> => ({});
export const plantillaPorId = async (id: string): Promise<{ id: string } | null> => (void id, null);
export const piezaParaAlta = async (
	plantilla: string | null,
	clave: string | null,
	modulo: string
): Promise<{
	plantilla: string;
	plantillaNombre: string;
	nombre: string;
	parametros: Record<string, unknown>;
} | null> => (void plantilla, void clave, void modulo, null);
