/*
 * Trampas de partner: PIEZA DE CLOUD. La edición community no tiene central ni
 * partner, así que aquí queda solo lo que el catálogo, el plan y el canal
 * esperan, con la respuesta de un nodo sin partner: no hay trampas de partner,
 * no se ofrecen y no se acepta ningún paquete.
 */
import type { CatalogoPartnerFirmado } from '@sugardaddy/canal';
import type { Honeycosa } from '@sugardaddy/contrato';

type Leido =
	| {
			ok: true;
			serie: number;
			partner: string;
			prefijo: string;
			caduca: string;
			firmado: CatalogoPartnerFirmado;
			modulos: Honeycosa[];
	  }
	| { ok: false; motivo: string };

const SIN_PARTNER = 'this edition has no partner honeypots';

export const partnerDelNodo = (): string | null => null;

export function leerPaquetePartner(texto: string, ahora = Date.now()): Leido {
	void texto;
	void ahora;
	return { ok: false, motivo: SIN_PARTNER };
}

export async function partnerAlDia(
	ahora = Date.now()
): Promise<Extract<Leido, { ok: true }> | null> {
	void ahora;
	return null;
}

export function olvidarPartner() {}

export const honeycosasDePartner = (): Honeycosa[] => [];

export const esDePartner = (id: string) => {
	void id;
	return false;
};

export const catalogoPartnerFirmado = async (): Promise<CatalogoPartnerFirmado | null> => null;

export const huellaCatalogoPartner = async (): Promise<string | null> => null;

export async function quitarCatalogoPartner() {}

export async function guardarCatalogoPartner(
	huella: string,
	texto: string
): Promise<string | null> {
	void huella;
	void texto;
	return SIN_PARTNER;
}

export const lineasDePartner = (): string[] => [];
