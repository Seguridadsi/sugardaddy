/*
 * La CA propia del nodo (docs/diseno/ca-nodo.md).
 *
 * La consola no tiene el socket de Docker: lo que pasa en la máquina lo hace
 * el actualizador. Él cuenta aquí en qué CA está el HTTPS de la consola y, en
 * un nodo instalado antes de la propia, cuál ha preparado. El administrador la
 * instala en los equipos y confirma; el actualizador lo recoge, cambia y
 * cuenta cómo ha ido. Todo vive en el ajuste «ca-nodo».
 */
import { X509Certificate, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db, schema as s } from './db';

/* caddy: la CA de Caddy de antes; propia: la del nodo; ficheros: el certificado de la empresa. */
export type ModoCa = 'caddy' | 'propia' | 'ficheros';

export type ResultadoCambio = {
	estado: 'aplicada' | 'fallida';
	detalle: string;
	huella: string | null;
	cuando: string;
	/* Copias de las que se quitó la CA vieja, y las que no se pudieron leer. */
	limpias: number;
	ilegibles: string[];
};

export type EstadoCa = {
	modo: ModoCa;
	/* La raíz: la preparada (modo caddy) o la que usa (propia). Pública. */
	raiz: string | null;
	huella: string | null;
	direccion: string | null;
	/* Lo que no va bien en el nodo (la CA no se lee, no cubre la dirección…). */
	error: string | null;
	/* Cuándo informó el actualizador por última vez. */
	informado: string;
	/* El administrador confirmó que esta raíz ya está en los equipos. */
	aprobada: { huella: string; quien: string; cuando: string } | null;
	resultado: ResultadoCambio | null;
	/* La raíz de Caddy de antes, para decir cuál quitar de los equipos tras el cambio. */
	anterior?: { huella: string; nombre: string } | null;
};

const CLAVE = 'ca-nodo';
const MAX_DETALLE = 1000;

/* Un único certificado de CA en PEM, recodificado; null si no lo es. */
export function certificadoDeCA(pem: unknown): string | null {
	if (typeof pem !== 'string' || pem.length > 16_000) return null;
	const bloques = pem.match(
		/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/g
	);
	if (bloques?.length !== 1) return null;
	try {
		const c = new X509Certificate(bloques[0]);
		return c.ca ? c.toString() : null;
	} catch {
		return null;
	}
}

/* El nombre con el que sale en el almacén de certificados de los equipos (su CN). */
export function nombreDe(pem: string | null): string {
	if (!pem) return '';
	try {
		const sujeto = new X509Certificate(pem).subject;
		return sujeto.match(/^CN=(.*)$/m)?.[1] ?? sujeto.replace(/\n/g, ', ');
	} catch {
		return '';
	}
}

/* La huella SHA-256 como la enseñan openssl, Windows y el instalador (AA:BB:…). */
export function huellaDe(pem: string | null): string | null {
	if (!pem) return null;
	try {
		return new X509Certificate(pem).fingerprint256;
	} catch {
		return null;
	}
}

const limpiaHuella = (h: string) => h.replace(/[^0-9a-f]/gi, '').toUpperCase();
export const mismaHuella = (a: string | null | undefined, b: string | null | undefined) =>
	!!a && !!b && limpiaHuella(a).length === 64 && limpiaHuella(a) === limpiaHuella(b);

export async function leerCaNodo(): Promise<EstadoCa | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, CLAVE));
	return (f?.valor as EstadoCa | undefined) ?? null;
}

/* La raíz que usa hoy el HTTPS de la consola: la del fichero que montan el instalador y el actualizador. */
export function raizActiva(): string | null {
	if (env.TLS_MODO === 'ficheros') return null;
	try {
		return certificadoDeCA(readFileSync(env.CA_RAIZ ?? '', 'utf8'));
	} catch {
		return null;
	}
}

/*
 * Cambia el ajuste a partir de lo que hay en la base, con la fila bloqueada:
 * el informe del actualizador y la confirmación del administrador pueden
 * llegar a la vez. null si no había nada que cambiar.
 */
async function cambiar(
	nuevo: (antes: EstadoCa | null) => EstadoCa | null,
	auditoria?: { quien: string; accion: string; detalle: Record<string, unknown> }[]
): Promise<EstadoCa | null> {
	return db.transaction(async (tx) => {
		const [f] = await tx.select().from(s.ajustes).where(eq(s.ajustes.clave, CLAVE)).for('update');
		const antes = (f?.valor as EstadoCa | undefined) ?? null;
		const valor = nuevo(antes);
		if (!valor) return null;
		await tx
			.insert(s.ajustes)
			.values({ clave: CLAVE, valor })
			.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
		for (const a of auditoria ?? []) await tx.insert(s.auditoria).values(a);
		return valor;
	});
}

const texto = (v: unknown, max = MAX_DETALLE) => (typeof v === 'string' ? v.slice(0, max) : '');

/*
 * Lo que cuenta el actualizador (POST /api/actualizador/ca). false si no se
 * entiende. Una raíz nueva preparada y el resultado de un cambio quedan en la
 * auditoría.
 */
export async function informeDelNodo(b: unknown): Promise<boolean> {
	if (!b || typeof b !== 'object') return false;
	const i = b as Record<string, unknown>;
	if (!['caddy', 'propia', 'ficheros'].includes(i.modo as string)) return false;
	const modo = i.modo as ModoCa;
	const raiz = modo === 'ficheros' ? null : certificadoDeCA(i.raiz);
	if (i.raiz && modo !== 'ficheros' && !raiz) return false;
	const huella = huellaDe(raiz);
	let resultado: ResultadoCambio | null = null;
	const r = i.resultado as Record<string, unknown> | undefined;
	if (r && typeof r === 'object') {
		if (r.estado !== 'aplicada' && r.estado !== 'fallida') return false;
		const copias = (r.copias ?? {}) as Record<string, unknown>;
		resultado = {
			estado: r.estado,
			detalle: texto(r.detalle),
			huella: mismaHuella(texto(r.huella, 200), huella) ? huella : null,
			cuando: new Date().toISOString(),
			limpias: Number.isInteger(copias.limpias) ? (copias.limpias as number) : 0,
			ilegibles: Array.isArray(copias.ilegibles)
				? copias.ilegibles
						.filter((x): x is string => typeof x === 'string')
						.slice(0, 50)
						.map((x) => x.slice(0, 120))
				: []
		};
	}
	const auditoria: { quien: string; accion: string; detalle: Record<string, unknown> }[] = [];
	await cambiar((antes) => {
		let aprobada = antes?.aprobada ?? null;
		if (modo === 'caddy' && huella && antes?.huella !== huella)
			auditoria.push({ quien: 'machine', accion: 'node CA root prepared', detalle: { huella } });
		if (resultado) {
			auditoria.push({
				quien: 'machine',
				accion: resultado.estado === 'aplicada' ? 'node CA switched' : 'node CA switch failed',
				detalle: {
					huella: resultado.huella,
					detalle: resultado.detalle.slice(0, 300),
					...(resultado.ilegibles.length ? { copiasIlegibles: resultado.ilegibles } : {})
				}
			});
			/* Con el resultado, la confirmación ya se ha usado: si falló, hay que volver a darla. */
			aprobada = null;
		}
		/*
		 * Una confirmación de una raíz que el nodo ya no tiene preparada no vale,
		 * ni una que el nodo no puede aplicar ahora (por ejemplo, con una versión
		 * a medias): cuando se arregle, que se vuelva a confirmar.
		 */
		if (aprobada && (modo !== 'caddy' || !mismaHuella(aprobada.huella, huella) || texto(i.error)))
			aprobada = null;
		/* Con la CA de Caddy, la raíz que usa hoy es la que habrá que quitar después. */
		const hoy = modo === 'caddy' ? raizActiva() : null;
		const anterior = hoy
			? { huella: huellaDe(hoy)!, nombre: nombreDe(hoy) }
			: (antes?.anterior ?? null);
		return {
			modo,
			raiz,
			huella,
			direccion: texto(i.direccion, 260) || null,
			error: texto(i.error) || null,
			informado: new Date().toISOString(),
			aprobada,
			resultado: resultado ?? antes?.resultado ?? null,
			anterior
		};
	}, auditoria);
	return true;
}

/* Lo que pide el actualizador (GET): la huella confirmada, si es la de la raíz que tiene preparada. */
export async function paraElActualizador(): Promise<{ cambiar: string | null }> {
	const e = await leerCaNodo();
	if (e?.modo === 'caddy' && e.aprobada && mismaHuella(e.aprobada.huella, e.huella))
		return { cambiar: e.aprobada.huella };
	return { cambiar: null };
}

/*
 * Las raíces en las que tiene que confiar un sensor remoto, en PEM: la que usa
 * hoy la consola y, mientras hay una preparada, también esa. null con el
 * certificado de la empresa o si aún no hay raíz.
 */
export async function raicesParaSensores(): Promise<string | null> {
	const activa = raizActiva();
	if (!activa) return null;
	const e = await leerCaNodo();
	const raices = [activa];
	if (e?.modo === 'caddy' && e.raiz && !mismaHuella(huellaDe(e.raiz), huellaDe(activa)))
		raices.push(e.raiz);
	return raices.map((r) => r.trim()).join('\n') + '\n';
}

export const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

/* Apunta qué raíces dice tener un sensor remoto (el sha256 de su ca-consola.crt), solo si cambió. */
export async function apuntarRaicesSensor(sensor: string, tiene: string | null): Promise<void> {
	if (!tiene || !/^[0-9a-f]{64}$/.test(tiene)) return;
	await db
		.update(s.sensores)
		.set({ caConfiada: tiene })
		.where(
			and(
				eq(s.sensores.id, sensor),
				or(isNull(s.sensores.caConfiada), ne(s.sensores.caConfiada, tiene))
			)
		);
}

/* Los sensores remotos que aún no confían en las raíces de ahora (la nueva incluida). */
export async function sensoresSinRaizNueva(): Promise<
	{ id: string; nombre: string; ultimoLatido: Date | null }[]
> {
	const raices = await raicesParaSensores();
	if (!raices) return [];
	const objetivo = sha256(raices);
	const remotos = await db
		.select({
			id: s.sensores.id,
			nombre: s.sensores.nombre,
			ultimoLatido: s.sensores.ultimoLatido,
			caConfiada: s.sensores.caConfiada
		})
		.from(s.sensores)
		/* Uno retirado no va a recibir la raíz nueva: no tiene que frenar el cambio. */
		.where(and(eq(s.sensores.remoto, true), isNull(s.sensores.retirado)));
	return remotos
		.filter((r) => r.caConfiada !== objetivo)
		.map(({ id, nombre, ultimoLatido }) => ({ id, nombre, ultimoLatido }));
}

export type ResultadoAprobar = { ok: true } | { ok: false; error: string };

/*
 * El administrador confirma que la raíz preparada ya está en los equipos. No
 * se confirma otra que la que se le enseñó (huella), ni con sensores remotos
 * que aún no la tienen, salvo que lo diga (cortarSensores): perderían la consola.
 */
export async function aprobarCambio(
	quien: string,
	huella: string,
	cortarSensores = false
): Promise<ResultadoAprobar> {
	const e = await leerCaNodo();
	if (env.TLS_MODO === 'ficheros' || e?.modo === 'ficheros')
		return { ok: false, error: 'This console uses a certificate from your organization.' };
	if (e?.modo !== 'caddy' || !e.raiz || !e.huella)
		return { ok: false, error: 'There is no new root waiting on this node.' };
	if (e.error) return { ok: false, error: `The node reports a problem with its CA: ${e.error}` };
	if (!mismaHuella(huella, e.huella))
		return {
			ok: false,
			error:
				'The node prepared a different root since you opened this page (for example, the console address changed). Install the one shown now and confirm again.'
		};
	const fuera = await sensoresSinRaizNueva();
	if (fuera.length && !cortarSensores)
		return {
			ok: false,
			error: `These remote sensors do not trust the new root yet and would lose contact with the console: ${fuera
				.map((f) => f.nombre)
				.join(
					', '
				)}. Wait a few minutes for them to pick it up, or confirm that they will need a new install line.`
		};
	const hecho = await cambiar(
		(antes) =>
			antes?.modo === 'caddy' && mismaHuella(antes.huella, huella)
				? { ...antes, aprobada: { huella: antes.huella!, quien, cuando: new Date().toISOString() } }
				: null,
		[
			{
				quien,
				accion: 'node CA switch confirmed',
				detalle: { huella: e.huella, sensoresCortados: fuera.map((f) => f.id) }
			}
		]
	);
	if (!hecho)
		return {
			ok: false,
			error: 'The node changed its root while you confirmed. Review it and confirm again.'
		};
	return { ok: true };
}

/*
 * Lo que dice el aviso de arriba a quien puede decidirlo: hay una raíz nueva
 * que instalar, el nodo está cambiando o el cambio falló. A los demás, nada.
 */
export async function avisoCa(
	admin: boolean
): Promise<'pendiente' | 'cambiando' | 'fallida' | null> {
	if (!admin || env.TLS_MODO === 'ficheros') return null;
	const e = await leerCaNodo();
	if (e?.modo !== 'caddy' || !e.raiz || e.error) return null;
	if (e.aprobada) return 'cambiando';
	if (e.resultado?.estado === 'fallida' && mismaHuella(e.resultado.huella, e.huella))
		return 'fallida';
	return 'pendiente';
}
