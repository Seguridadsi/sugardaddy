/*
 * Grabación de lo que hace el soporte de SeguridadSI (plan de fortificación
 * §4.4). hooks.server.ts llama a `grabar` tras cada petición de una sesión de
 * soporte: queda la ruta, el método, la acción del formulario y lo que respondió
 * la consola, con quién y en qué sesión. Lo que no es una lectura además entra en
 * la auditoría encadenada como «support action: …» (auditoria.soporte-accion);
 * las lecturas salen al SIEM desde esta tabla (auditoria.soporte-peticion,
 * salidas/auditoria.ts). El cliente lo ve en Audit logs → Support sessions.
 *
 * Nunca se graba el cuerpo de la petición: puede llevar contraseñas o
 * credenciales capturadas. Basta con saber qué se tocó.
 */
import { desc } from 'drizzle-orm';
import { db, schema as s } from './db';
import { auditar } from './consultas';

const LARGO_RUTA = 300;

/* Lo que se apunta de una petición: la ruta sin `/__data.json` (es la misma página) y sin datos raros. */
export function rutaGrabada(url: URL): { ruta: string; accion: string | null } {
	const m = url.search.match(/^\?\/([A-Za-z0-9_]+)/);
	const ruta = url.pathname.replace(/\/__data\.json$/, '') || '/';
	const resto = new URLSearchParams(url.search.replace(/^\?\/[A-Za-z0-9_]+&?/, '?'));
	resto.delete('x-sveltekit-invalidated');
	resto.delete('x-sveltekit-trailing-slash');
	const q = resto.toString();
	return { ruta: (q ? `${ruta}?${q}` : ruta).slice(0, LARGO_RUTA), accion: m ? m[1] : null };
}

export const esLectura = (metodo: string) => metodo === 'GET' || metodo === 'HEAD';

export async function grabar(p: {
	quien: string;
	sesion: string | null;
	metodo: string;
	url: URL;
	estado: number;
}) {
	const { ruta, accion } = rutaGrabada(p.url);
	await db.insert(s.soporteRegistro).values({
		quien: p.quien,
		sesion: p.sesion,
		metodo: p.metodo,
		ruta,
		accion,
		estado: p.estado
	});
	if (!esLectura(p.metodo))
		await auditar(p.quien, `support action: ${p.metodo} ${ruta}${accion ? ` ?/${accion}` : ''}`, {
			estado: p.estado
		});
}

export async function grabaciones(limite = 500) {
	return db.select().from(s.soporteRegistro).orderBy(desc(s.soporteRegistro.id)).limit(limite);
}
