/*
 * El candado de licencia en la consola (capa 4, defensa en profundidad): qué
 * trampas de PAGO cubre la licencia que llegó del panel. La de verdad está
 * dentro del binario cerrado de cada trampa de pago; aquí sirve para que el
 * plan no mande al sensor una de pago sin licencia y para que el catálogo no
 * ofrezca «Desplegar» en una que se quedaría en espera.
 *
 * Se verifica con la clave de PUBLICACIÓN (la del binario), no con la del
 * panel, para que valga aunque el panel mienta sobre los módulos. Las trampas
 * gratis (MODULOS_GRATIS) no pasan por aquí, y sin clave para cotejar todas
 * cuentan como cubiertas: la licencia la juzga solo la trampa.
 */
import { eq } from 'drizzle-orm';
import { licenciaPermite, verificarLicencia, type LicenciaFirmada } from '@sugardaddy/canal';
import { env } from '$env/dynamic/private';
import { db, schema as s } from './db';
import { esDePago } from './modulos-gratis';

/* La licencia de pago guardada, o null si el nodo no tiene (edición gratis). */
export async function licenciaGuardada(): Promise<LicenciaFirmada | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'licencia'));
	return (f?.valor as LicenciaFirmada | undefined) ?? null;
}

/* Cubierta, o el código de espera con que se queda fuera del plan. */
export type Cobertura = 'cubierta' | 'licencia.sin' | 'licencia.caducada';

/* Cómo cubre la licencia de este nodo cada módulo: se lee y se verifica una vez. */
export async function coberturaLicencia(): Promise<(modulo: string) => Cobertura> {
	const clave = env.PUBLICACION_CLAVE_PUBLICA;
	if (!clave) return () => 'cubierta';
	const lic = await licenciaGuardada();
	const v = lic ? verificarLicencia(clave, lic) : null;
	return (modulo) => {
		if (!esDePago(modulo)) return 'cubierta';
		if (!v) return 'licencia.sin';
		if (!v.ok) return v.motivo === 'licencia caducada' ? 'licencia.caducada' : 'licencia.sin';
		return licenciaPermite(v.licencia, modulo) ? 'cubierta' : 'licencia.sin';
	};
}
