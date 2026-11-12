/*
 * El alcance de las salidas de avisos por sensor y por honeypot es de Cloud. En
 * esta edición no hay salidas: las fichas no enseñan su pestaña «Alerts» y en
 * las listas nada sale como silenciado.
 */
export type Nivel = 'sensor' | 'trampa';
export type FilaAlcance = {
	id: string;
	nombre: string;
	tipo: string;
	activa: boolean;
	valor: 'hereda' | 'si' | 'no';
	heredado: { envia: boolean; de: 'sensor' | 'consola' };
};

export async function alcanceDeFicha(
	_nivel: Nivel,
	_objeto: string,
	_sensor?: string | null
): Promise<FilaAlcance[] | null> {
	return null;
}

export function leerAlcance(_f: FormData): { salida: string; envia: boolean | null } | null {
	return null;
}

export async function fijarAlcance(
	_quien: string,
	_v: { salida: string; nivel: Nivel; objeto: string; envia: boolean | null }
): Promise<boolean> {
	return false;
}

export async function silenciosPorObjeto(): Promise<{
	sensores: Record<string, string[]>;
	trampas: Record<string, string[]>;
}> {
	return { sensores: {}, trampas: {} };
}
export async function salidasConProblemas(): Promise<
	{ id: string; nombre: string; fallosSeguidos: number; ultimoError: string | null }[]
> {
	return [];
}
