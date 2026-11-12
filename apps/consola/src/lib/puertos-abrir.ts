/*
 * Los puertos que hay que abrir en el cortafuegos de la máquina de un sensor
 * para que lleguen a sus trampas: por dirección de la máquina, con la trampa de
 * cada uno. La consola no abre nada (no entra en esa máquina ni en su nube): lo
 * dice, para que quien la administra abra justo eso y nada más.
 */
import { porDireccion } from './red';

export type TrampaConPuertos = {
	nombre: string;
	puertos: { puerto: number; protocolo: string }[];
	/* La dirección de la máquina en la que escucha; sin ella, en todas. */
	escucha?: string | null;
};

export type PuertosDeDireccion = {
	/* null: todas las direcciones de la máquina. */
	direccion: string | null;
	puertos: { puerto: number; protocolo: string; trampa: string }[];
};

export function puertosParaAbrir(trampas: TrampaConPuertos[]): PuertosDeDireccion[] {
	const porDir = new Map<string, PuertosDeDireccion>();
	for (const t of trampas) {
		const clave = t.escucha || '';
		const g = porDir.get(clave) ?? { direccion: t.escucha || null, puertos: [] };
		porDir.set(clave, g);
		for (const p of t.puertos)
			if (!g.puertos.some((x) => x.puerto === p.puerto && x.protocolo === p.protocolo))
				g.puertos.push({ puerto: p.puerto, protocolo: p.protocolo, trampa: t.nombre });
	}
	for (const g of porDir.values())
		g.puertos.sort((a, b) => a.puerto - b.puerto || a.protocolo.localeCompare(b.protocolo));
	return [...porDir.values()]
		.filter((g) => g.puertos.length)
		.sort((a, b) =>
			a.direccion === null ? -1 : b.direccion === null ? 1 : porDireccion(a.direccion, b.direccion)
		);
}
