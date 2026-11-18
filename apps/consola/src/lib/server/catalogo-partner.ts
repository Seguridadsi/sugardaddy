/*
 * Trampas de partner: PIEZA DE CLOUD. La edición community no tiene central ni
 * partner, así que aquí queda solo lo que el catálogo, el plan, el canal y la
 * franja esperan, con la respuesta de un nodo sin partner: no hay trampas de
 * partner, no se ofrecen, no se acepta ningún paquete y ninguna se para por él.
 * La verificación de firmas (canal y contrato) y la del sensor no entran.
 */
import type { Honeycosa } from '@sugardaddy/contrato';

type PartnerFuera = {
	motivo: 'caducado' | 'retirado';
	partner: string;
	caduca: string;
	modulos: { id: string; nombre: string }[];
};

const SIN_PARTNER = 'this edition has no partner honeypots';

export const partnerDelNodo = (): string | null => null;

export async function partnerAlDia(ahora = Date.now()): Promise<{ modulos: Honeycosa[] } | null> {
	void ahora;
	return null;
}

export function olvidarPartner() {}

export const honeycosasDePartner = (): Honeycosa[] => [];

export const esDePartner = (id: string) => {
	void id;
	return false;
};

export const partnerFuera = (): PartnerFuera | null => null;

export const motivoPartnerFuera = (id: string): PartnerFuera | null => {
	void id;
	return null;
};

export async function avisoPartnerFuera(): Promise<
	(Omit<PartnerFuera, 'modulos'> & { trampas: number }) | null
> {
	return null;
}

export const huellaCatalogoPartner = async (): Promise<string | null> => null;

export async function retirarCatalogoPartner() {}

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
