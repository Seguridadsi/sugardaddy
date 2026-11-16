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
 *
 * Caducidad y revocación (docs/diseno/licencias-de-pago.md, DORA art. 30.3.f, B-06): una
 * licencia caducada no quita lo que ya estaba puesto hasta su fecha firmada funcionaHasta,
 * solo impide poner trampas de pago nuevas. Lo que la quita antes es una revocación firmada
 * por SeguridadSI, que llega en el latido y la consola no olvida.
 */
import { eq } from 'drizzle-orm';
import {
	funcionaHastaDe,
	licenciaDeRegistro,
	licenciaFunciona,
	licenciaPermite,
	revocacionDe,
	verificarLicencia,
	verificarRevocacion,
	MAX_REVOCACIONES,
	type LicenciaFirmada,
	type RevocacionFirmada
} from '@sugardaddy/canal';
import { env } from '$env/dynamic/private';
import { esDePartner } from './catalogo-partner';
import { confianza } from './claves';
import { db, schema as s } from './db';
import { esCommunity } from './edicion';
import { esDePago, esDeRegistro } from './modulos-gratis';

/* La licencia de pago guardada, o null si el nodo no tiene (edición gratis). */
export async function licenciaGuardada(): Promise<LicenciaFirmada | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'licencia'));
	return (f?.valor as LicenciaFirmada | undefined) ?? null;
}

/* Las revocaciones de licencias que ha entregado el panel (canal.ts, guardarRevocaciones). */
export async function revocacionesGuardadas(): Promise<RevocacionFirmada[]> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'revocaciones'));
	return Array.isArray(f?.valor) ? (f.valor as RevocacionFirmada[]) : [];
}

/*
 * Junta las revocaciones nuevas con las que ya había: solo las que se comprueban con la
 * clave de licencias, sin repetir y sin quitar nunca ninguna (el panel puede dejar de
 * mandarlas, pero no deshacerlas). Devuelve la lista nueva y cuántas se han añadido.
 */
export function juntarRevocaciones(
	antes: RevocacionFirmada[],
	llegan: unknown,
	clave = confianza()
): { lista: RevocacionFirmada[]; nuevas: RevocacionFirmada[] } {
	const lista = [...antes];
	const nuevas: RevocacionFirmada[] = [];
	if (!clave || !Array.isArray(llegan)) return { lista, nuevas };
	const vistas = new Set(lista.map((r) => r.revocacion));
	for (const x of llegan.slice(0, MAX_REVOCACIONES)) {
		const v = verificarRevocacion(clave, x);
		if (!v.ok) continue;
		const r = x as RevocacionFirmada;
		if (vistas.has(r.revocacion)) continue;
		vistas.add(r.revocacion);
		const limpia = {
			revocacion: r.revocacion,
			firma: r.firma,
			...(r.firmas?.length ? { firmas: r.firmas } : {})
		};
		lista.push(limpia);
		nuevas.push(limpia);
	}
	/* Las más recientes, si alguna vez pasaran del tope. */
	return { lista: lista.slice(-MAX_REVOCACIONES), nuevas };
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
	| 'cubierta'
	| 'licencia.sin'
	| 'licencia.caducada'
	| 'licencia.revocada'
	| 'registro.sin'
	| 'registro.caducado';

/*
 * Cómo cubre la licencia de este nodo cada módulo: se lee y se verifica una vez.
 * desplegada: cuándo se puso la trampa (el plan la da; el catálogo y el alta, no). Con la
 * licencia caducada, una trampa puesta cuando valía sigue cubierta hasta funcionaHasta (la
 * fecha firmada que comprueba la trampa al arrancar; sin ella, nada): la caducidad solo
 * impide poner trampas de pago nuevas. Revocada, nada de pago queda cubierto.
 */
export async function coberturaLicencia(): Promise<
	(modulo: string, desplegada?: Date | null) => Cobertura
> {
	const clave = confianza();
	const community = esCommunity();
	const deRegistro = (modulo: string) => community && esDeRegistro(modulo);
	const sin = (modulo: string): Cobertura => (deRegistro(modulo) ? 'registro.sin' : 'licencia.sin');
	if (!clave) return community ? (m) => (esDePago(m) ? sin(m) : 'cubierta') : () => 'cubierta';
	const lic = await licenciaGuardada();
	const v = lic ? verificarLicencia(clave, lic) : null;
	/* Auténtica, sin mirar el reloj: para saber si está revocada aunque haya caducado. */
	const autentica = lic ? verificarLicencia(clave, lic, 0) : null;
	const revocada =
		lic && autentica?.ok
			? !!revocacionDe(clave, await revocacionesGuardadas(), lic, autentica.licencia)
			: false;
	/*
	 * Si valía cuando se puso la trampa y aún funciona (funcionaHasta, lo mismo que comprueba
	 * la trampa al arrancar).
	 */
	const valiaEn = (cuando: Date, modulo: string) => {
		if (!lic || !autentica?.ok || !licenciaFunciona(autentica.licencia)) return false;
		if (cuando.getTime() > Date.now()) return false;
		const entonces = verificarLicencia(clave, lic, cuando.getTime());
		return entonces.ok && licenciaPermite(entonces.licencia, modulo);
	};
	return (modulo, desplegada) => {
		/* Una del partner de este nodo no lleva nuestra licencia: la autoriza su firma. */
		if (esDePartner(modulo)) return 'cubierta';
		if (!esDePago(modulo)) return 'cubierta';
		if (!v) return sin(modulo);
		if (revocada) return 'licencia.revocada';
		if (!v.ok) {
			if (!/caducad|expired/i.test(v.motivo)) return sin(modulo);
			if (desplegada && valiaEn(desplegada, modulo)) return 'cubierta';
			return deRegistro(modulo) ? 'registro.caducado' : 'licencia.caducada';
		}
		return licenciaPermite(v.licencia, modulo) ? 'cubierta' : sin(modulo);
	};
}

/*
 * Las fechas de la licencia Cloud de este nodo, para enseñárselas al cliente: hasta cuándo
 * despliega o cambia trampas de pago (caduca) y hasta cuándo siguen funcionando las ya
 * desplegadas (funcionaHasta; sin él, caduca). Null en Community, sin licencia o si no se
 * puede comprobar.
 */
export async function fechasLicencia(ahora = Date.now()): Promise<{
	caduca: string;
	funcionaHasta: string;
	caducada: boolean;
	funciona: boolean;
} | null> {
	const clave = confianza();
	if (!clave || esCommunity()) return null;
	const lic = await licenciaGuardada();
	const v = lic ? verificarLicencia(clave, lic, 0) : null;
	if (!v?.ok) return null;
	return {
		caduca: v.licencia.caduca,
		funcionaHasta: funcionaHastaDe(v.licencia),
		caducada: Date.parse(v.licencia.caduca) < ahora,
		funciona: licenciaFunciona(v.licencia, ahora)
	};
}
