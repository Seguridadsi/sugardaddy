declare global {
	namespace App {
		interface Locals {
			/* Quién está haciendo esta petición. Nulo si no ha entrado. */
			usuario: {
				nombre: string;
				correo: string;
				roles: string[];
				/* oid de la identidad: `local:<id>` (login local), `emergencia:<id>` o el de Entra.
				 * Ausente en el usuario de modo desarrollo. La autogestión solo mira los `local:`. */
				oid?: string;
				soporte?: boolean;
				emergencia?: boolean;
			} | null;
			/* Sin Entra configurado y en `vite dev`: todo el mundo es admin. */
			modoDesarrollo: boolean;
		}
	}
}

export {};
