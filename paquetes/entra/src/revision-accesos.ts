/*
 * Revisión de accesos (plan de fortificación §4.6): la cuenta que no entra en N
 * días (90 de serie) se desactiva sola, sin borrarse; y cada trimestre un
 * administrador confirma la lista de personas con acceso. Lo puro, sin base, y
 * las mismas reglas en la consola y en el panel central (cada uno con su
 * lib/server/revision-accesos.ts).
 */
const DIA = 24 * 3600_000;

export const DIAS_INACTIVIDAD_POR_DEFECTO = 90;
export const DIAS_INACTIVIDAD_MINIMO = 30;
export const DIAS_INACTIVIDAD_MAXIMO = 365;
/* Un trimestre y un día de margen: la revisión de cada trimestre, no la de cada 90 días exactos. */
export const DIAS_ENTRE_REVISIONES = 92;

export type CuentaAcceso = {
	oid: string;
	roles: readonly string[];
	visto: Date;
	ultimaEntrada: Date | null;
	reactivada: Date | null;
	desactivada: Date | null;
};

/* Desde cuándo cuenta la inactividad: la última entrada, la reactivación o el alta. */
export function referencia(c: CuentaAcceso): number {
	return Math.max(c.visto.getTime(), c.ultimaEntrada?.getTime() ?? 0, c.reactivada?.getTime() ?? 0);
}

const esAdmin = (c: Pick<CuentaAcceso, 'roles'>) => c.roles.includes('admin');

/*
 * Las cuentas activas que llevan más de `dias` sin entrar, de la más antigua a la
 * más reciente. Nunca el último administrador activo: la consola no se queda sin
 * nadie que la administre por no haber entrado en vacaciones.
 */
export function aDesactivar(cuentas: readonly CuentaAcceso[], dias: number, ahora: number) {
	const activas = cuentas.filter((c) => !c.desactivada);
	let admins = activas.filter(esAdmin).length;
	const limite = ahora - dias * DIA;
	const viejas = activas
		.filter((c) => referencia(c) < limite)
		.sort((a, b) => referencia(a) - referencia(b));
	const fuera: string[] = [];
	for (const c of viejas) {
		if (esAdmin(c)) {
			if (admins <= 1) continue;
			admins--;
		}
		fuera.push(c.oid);
	}
	return fuera;
}

/* ¿Se puede desactivar esta cuenta a mano? No, si es el último administrador activo. */
export function esUltimoAdmin(cuentas: readonly CuentaAcceso[], oid: string) {
	const c = cuentas.find((x) => x.oid === oid);
	if (!c || c.desactivada || !esAdmin(c)) return false;
	return cuentas.filter((x) => !x.desactivada && esAdmin(x)).length <= 1;
}

/* Los días de inactividad pedidos; null si no valen. */
export function diasValidos(v: unknown): number | null {
	const texto = String(v ?? '').trim();
	if (!/^\d{1,3}$/.test(texto)) return null;
	const n = Number(texto);
	return n >= DIAS_INACTIVIDAD_MINIMO && n <= DIAS_INACTIVIDAD_MAXIMO ? n : null;
}

/*
 * Cuándo toca la siguiente revisión: un trimestre después de la última o, si no
 * ha habido ninguna, de la cuenta más antigua (una consola recién instalada no
 * nace con la revisión vencida). Null si no hay cuentas.
 */
export function proximaRevision(ultima: Date | null, primeraCuenta: Date | null): Date | null {
	const desde = ultima ?? primeraCuenta;
	return desde ? new Date(desde.getTime() + DIAS_ENTRE_REVISIONES * DIA) : null;
}

export const revisionVencida = (ultima: Date | null, primeraCuenta: Date | null, ahora: number) => {
	const p = proximaRevision(ultima, primeraCuenta);
	return !!p && p.getTime() < ahora;
};

/* De dónde viene la cuenta, por su oid. */
export function origenCuenta(oid: string): 'local' | 'oidc' | 'saml' | 'entra' {
	if (oid.startsWith('local:')) return 'local';
	if (oid.startsWith('oidc:')) return 'oidc';
	if (oid.startsWith('saml:')) return 'saml';
	return 'entra';
}
