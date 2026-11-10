/*
 * El candado de licencia en la consola (capa 4, defensa en profundidad): qué
 * trampas de PAGO cubre la licencia que llegó del panel. La de verdad está
 * dentro del binario cerrado de cada trampa de pago; aquí sirve para que el
 * plan no mande al sensor una de pago sin licencia y para que el catálogo no
 * ofrezca «Desplegar» en una que se quedaría en espera.
 *
 * Se verifica con la clave de PUBLICACIÓN (la del binario), no con la del
 * panel, para que valga aunque el panel mienta sobre los módulos. Las trampas
 * gratis (MODULOS_GRATIS) no pasan por aquí. Sin clave para cotejar, en un nodo
 * Cloud todas cuentan como cubiertas (la licencia la juzga solo la trampa); en
 * Community no se desbloquea nada: es la licencia verificada la que da derecho.
 */
import { eq } from 'drizzle-orm';
import {
	licenciaDeRegistro,
	licenciaPermite,
	verificarLicencia,
	type LicenciaFirmada
} from '@sugardaddy/canal';
import { env } from '$env/dynamic/private';
import { confianza } from './claves';
import { db, schema as s } from './db';
import { esCommunity } from './edicion';
import { esDePago, esDeRegistro } from './modulos-gratis';

/* La licencia de pago guardada, o null si el nodo no tiene (edición gratis). */
export async function licenciaGuardada(): Promise<LicenciaFirmada | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'licencia'));
	return (f?.valor as LicenciaFirmada | undefined) ?? null;
}

/*
 * Los módulos que da el registro gratuito de este nodo Community: los de una
 * licencia de registro AUTÉNTICA, sin mirar si sigue vigente (si ha caducado, el
 * plan y el catálogo dicen «ha caducado» en lugar de «no la tienes»; la cobertura
 * de abajo es la que la deja fuera). Sin clave para cotejar, ninguno.
 */
export async function modulosDeRegistro(): Promise<string[]> {
	const clave = confianza();
	if (!clave) return [];
	const lic = await licenciaGuardada();
	if (!lic) return [];
	const v = licenciaDeRegistro(clave, lic, 0);
	return v.ok ? v.licencia.modulos : [];
}

/* Cubierta, o el código de espera con que se queda fuera del plan. */
export type Cobertura =
	'cubierta' | 'licencia.sin' | 'licencia.caducada' | 'registro.sin' | 'registro.caducado';

/* Cómo cubre la licencia de este nodo cada módulo: se lee y se verifica una vez. */
export async function coberturaLicencia(): Promise<(modulo: string) => Cobertura> {
	const clave = confianza();
	const community = esCommunity();
	const deRegistro = (modulo: string) => community && esDeRegistro(modulo);
	const sin = (modulo: string): Cobertura => (deRegistro(modulo) ? 'registro.sin' : 'licencia.sin');
	if (!clave) return community ? (m) => (esDePago(m) ? sin(m) : 'cubierta') : () => 'cubierta';
	const lic = await licenciaGuardada();
	const v = lic ? verificarLicencia(clave, lic) : null;
	return (modulo) => {
		if (!esDePago(modulo)) return 'cubierta';
		if (!v) return sin(modulo);
		if (!v.ok) {
			if (!/caducad|expired/i.test(v.motivo)) return sin(modulo);
			return deRegistro(modulo) ? 'registro.caducado' : 'licencia.caducada';
		}
		return licenciaPermite(v.licencia, modulo) ? 'cubierta' : sin(modulo);
	};
}
