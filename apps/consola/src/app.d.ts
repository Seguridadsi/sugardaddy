declare global {
	namespace App {
		interface Locals {
			/* Quién está haciendo esta petición. Nulo si no ha entrado. */
			usuario: {
				nombre: string;
				correo: string;
				roles: string[];
				soporte?: boolean;
				emergencia?: boolean;
			} | null;
			/* Sin Entra configurado y en `vite dev`: todo el mundo es admin. */
			modoDesarrollo: boolean;
		}
	}
}

export {};
