/*
 * Hash de contraseñas con scrypt y sal por cuenta, compartido por el login local
 * de la consola y la entrada de emergencia del panel central.
 *
 * Reglas que no se tocan:
 *  - La contraseña NUNCA se guarda en claro ni cifrada de forma reversible: solo
 *    este hash. La comprobación es en tiempo constante.
 *  - El formato (scrypt$N$r$p$sal$hash, en base64) lo repite el sembrado del primer
 *    administrador de la consola (apps/consola/scripts/preparar-base.mjs): si cambia
 *    aquí, cámbialo también allí.
 *
 * Solo node:crypto: lo importan también los scripts de administración, con
 * `node --experimental-strip-types`.
 */
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';

/* Parámetros de scrypt. 2^15 de coste; maxmem explícito porque 2^15 pasa del tope por defecto. */
const N = 1 << 15;
const R = 8;
const P = 1;
const LONGITUD = 32;
const MAXMEM = 64 * 1024 * 1024;

export function hashClave(clave: string): string {
	const sal = randomBytes(16);
	const h = scryptSync(clave, sal, LONGITUD, { N, r: R, p: P, maxmem: MAXMEM });
	return `scrypt$${N}$${R}$${P}$${sal.toString('base64')}$${h.toString('base64')}`;
}

type PartesHash = { n: number; r: number; q: number; sal: Buffer; esperado: Buffer };

function partesHash(almacenado: string): PartesHash | null {
	const p = almacenado.split('$');
	if (p.length !== 6 || p[0] !== 'scrypt') return null;
	const n = Number(p[1]);
	const r = Number(p[2]);
	const q = Number(p[3]);
	if (
		!Number.isInteger(n) ||
		!Number.isInteger(r) ||
		!Number.isInteger(q) ||
		n < 2 ||
		r < 1 ||
		q < 1
	)
		return null;
	const sal = Buffer.from(p[4], 'base64');
	const esperado = Buffer.from(p[5], 'base64');
	if (sal.length === 0 || esperado.length === 0) return null;
	return { n, r, q, sal, esperado };
}

export function comprobarClave(clave: string, almacenado: string): boolean {
	const x = partesHash(almacenado);
	if (!x) return false;
	let h: Buffer;
	try {
		h = scryptSync(clave, x.sal, x.esperado.length, { N: x.n, r: x.r, p: x.q, maxmem: MAXMEM });
	} catch {
		return false;
	}
	return h.length === x.esperado.length && timingSafeEqual(h, x.esperado);
}

/*
 * Lo mismo sin bloquear el proceso: scrypt va al pool de libuv y, como mucho,
 * MAX_SCRYPT a la vez; el resto espera su turno. Con la versión síncrona, una
 * ráfaga de intentos de entrada (unos 60 ms cada uno) congelaba la consola
 * entera, también la recepción de eventos de los sensores.
 */
const MAX_SCRYPT = 2;
let scryptEnCurso = 0;
const scryptEnCola: (() => void)[] = [];

async function enTurno<T>(f: () => Promise<T>): Promise<T> {
	while (scryptEnCurso >= MAX_SCRYPT) await new Promise<void>((ok) => scryptEnCola.push(ok));
	scryptEnCurso++;
	try {
		return await f();
	} finally {
		scryptEnCurso--;
		scryptEnCola.shift()?.();
	}
}

export async function comprobarClaveAsync(clave: string, almacenado: string): Promise<boolean> {
	const x = partesHash(almacenado);
	if (!x) return false;
	try {
		const h = await enTurno(
			() =>
				new Promise<Buffer>((ok, mal) =>
					scrypt(
						clave,
						x.sal,
						x.esperado.length,
						{ N: x.n, r: x.r, p: x.q, maxmem: MAXMEM },
						(e, b) => (e ? mal(e) : ok(b))
					)
				)
		);
		return h.length === x.esperado.length && timingSafeEqual(h, x.esperado);
	} catch {
		return false;
	}
}
