/*
 * Las copias del nodo, fuera de la máquina (docs/diseno/copias-fuera.md; plan de
 * fortificación §8.2). copia.sh las crea cada noche; el actualizador las sube al
 * destino que se elige en Ajustes → Backups (una carpeta compartida SMB, un bucket
 * compatible con S3 o un contenedor de Azure Blob con una URL SAS), deja allí las
 * últimas N y hace la prueba de restauración una vez al mes.
 *
 * Aquí vive lo de la consola: el destino (ajuste «copias-destino», con el secreto
 * cifrado con la clave del nodo, secretos.ts), lo que cuenta el actualizador
 * (ajuste «copias-estado»), la auditoría de cada cosa y los avisos de salud
 * (salud.copias-*), que salen al SIEM como los demás. La consola nunca habla con
 * el destino: solo se lo da, descifrado, al actualizador por su puerta local.
 */
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Severidad } from '@sugardaddy/contrato';
import { db, schema as s } from './db';
import { cifrar, descifrar, estadoClave, final, tapar, TEXTO_ILEGIBLE } from './secretos';

export const AJUSTE_DESTINO = 'copias-destino';
export const AJUSTE_ESTADO = 'copias-estado';
const CONTEXTO = 'copias-destino';

export type TipoDestino = 's3' | 'azure' | 'smb';
export const TIPOS: readonly TipoDestino[] = ['s3', 'azure', 'smb'];

/* Lo que se guarda: todo menos el secreto, que va en `secreto` (cifrado). */
export type Destino = {
	version: number;
	activo: boolean;
	tipo: TipoDestino;
	conservar: number;
	inmutable: { dias: number; modo: 'compliance' | 'governance' } | null;
	s3?: {
		endpoint: string;
		region: string;
		bucket: string;
		prefijo: string;
		estiloRuta: boolean;
		claveId: string;
	};
	/* La URL del contenedor sin la SAS (que va en el secreto). */
	azure?: { contenedor: string; prefijo: string };
	smb?: {
		servidor: string;
		recurso: string;
		carpeta: string;
		usuario: string;
		dominio: string;
		cifrado: boolean;
	};
	secreto: string;
	/* Los 4 últimos caracteres del secreto, si es largo (para reconocerlo). */
	final: string | null;
	cambiado: string;
	quien: string;
	/* Lo pedido desde la página y aún no hecho por el actualizador. */
	pedidos?: { comprobar?: Pedido; prueba?: Pedido };
};
type Pedido = { id: string; cuando: string; quien: string };

export type Comprobacion = {
	resultado: 'ok' | 'sin-clave' | 'fallo';
	detalle: string;
	nombre: string;
	bytes?: number;
	huella?: 'coincide' | 'distinta' | 'sin-apuntar';
	descifrada?: boolean;
	cuando: string;
	pedida: boolean;
};

export type EstadoCopias = {
	/* La última vez que contó algo el actualizador. */
	informe: string | null;
	/* La huella del destino de la que habla lo de abajo. */
	huella: string | null;
	local: { nombre: string; bytes: number; cuando: string } | null;
	ultimaSubida: { nombre: string; bytes: number; sha256: string; cuando: string } | null;
	ultimoError: { detalle: string; cuando: string; desde: string } | null;
	remotas: { nombre: string; bytes: number }[];
	remotasCuando: string | null;
	bloqueadas: number;
	avisos: string[];
	prueba: Comprobacion | null;
	conexion: { ok: boolean; detalle: string; cuando: string } | null;
};

const ESTADO_INICIAL: EstadoCopias = {
	informe: null,
	huella: null,
	local: null,
	ultimaSubida: null,
	ultimoError: null,
	remotas: [],
	remotasCuando: null,
	bloqueadas: 0,
	avisos: [],
	prueba: null,
	conexion: null
};

/* La prueba de restauración: cada 30 días; tras un fallo, al día siguiente. */
export const PRUEBA_CADA_DIAS = 30;
const DIA = 24 * 3600_000;
/* Sin una copia nueva (en la máquina o en el destino) en este tiempo, se avisa. */
export const HORAS_SIN_COPIA = 48;
export const CONSERVAR_DEFECTO = 30;

/* Como consultas.auditar, sin importar consultas.ts (salidas/salud.ts nos importa y sus pruebas simulan la base). */
async function auditar(quien: string, accion: string, detalle: Record<string, unknown> = {}) {
	await db.insert(s.auditoria).values({ quien, accion, detalle });
}

async function leer<T>(clave: string): Promise<T | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, clave));
	return (f?.valor as T | undefined) ?? null;
}

async function escribir(clave: string, valor: unknown) {
	await db
		.insert(s.ajustes)
		.values({ clave, valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
}

export const leerDestino = () => leer<Destino>(AJUSTE_DESTINO);
export async function leerEstado(): Promise<EstadoCopias> {
	return { ...ESTADO_INICIAL, ...((await leer<EstadoCopias>(AJUSTE_ESTADO)) ?? {}) };
}

/*
 * La huella del destino: cambia si cambia adónde van las copias (o su credencial,
 * que se vuelve a cifrar). Con otra huella el actualizador empieza de cero allí.
 * No cuenta lo que no cambia el sitio (cuántas conservar, activo).
 */
export function huellaDestino(d: Destino): string {
	return createHash('sha256')
		.update(
			JSON.stringify({
				t: d.tipo,
				s3: d.s3 ?? null,
				az: d.azure ?? null,
				smb: d.smb ?? null,
				i: d.inmutable,
				x: d.secreto
			})
		)
		.digest('hex')
		.slice(0, 32);
}

/* ---------- Lo que se escribe en el formulario ---------- */

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{2,40}$/;
const SERVIDOR = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const IP = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]+$/;
const RECURSO = /^[A-Za-z0-9 ._$-]{1,80}$/;
const USUARIO = /^[A-Za-z0-9 ._@$-]{1,104}$/;
const TROZO = /^[A-Za-z0-9._-]{1,100}$/;

/* La carpeta dentro del destino, como la entiende el actualizador (copias.Prefijo). */
export function prefijo(p: string): string | null {
	const limpio = p.trim().replace(/^\/+|\/+$/g, '');
	if (!limpio) return '';
	const trozos = limpio.split('/');
	if (trozos.some((t) => !t || t === '.' || t === '..' || !TROZO.test(t))) return null;
	return limpio;
}

export type Formulario = Record<string, string | undefined>;

export type Validado =
	| {
			ok: true;
			destino: Omit<Destino, 'version' | 'secreto' | 'final' | 'cambiado' | 'quien' | 'pedidos'>;
			/* Vacío: se queda el que había. */
			secreto: string;
	  }
	| { ok: false; error: string };

/*
 * Valida el formulario. Un secreto vacío vale si ya había uno del mismo tipo
 * (se deja como estaba); si no, hace falta.
 */
export function validar(f: Formulario, previo: Destino | null): Validado {
	const tipo = f.tipo as TipoDestino;
	if (!TIPOS.includes(tipo)) return { ok: false, error: 'Choose where to send the backups.' };
	const conservar = Number(f.conservar || CONSERVAR_DEFECTO);
	if (!Number.isInteger(conservar) || conservar < 1 || conservar > 365)
		return { ok: false, error: 'Keep between 1 and 365 backups in your storage.' };
	const dias = Number(f.inmutableDias || 0);
	if (!Number.isInteger(dias) || dias < 0 || dias > 3650)
		return { ok: false, error: 'Immutability: between 0 (off) and 3650 days.' };
	const modo = f.inmutableModo === 'governance' ? 'governance' : 'compliance';
	const inmutable = dias > 0 ? { dias, modo: modo as 'compliance' | 'governance' } : null;
	const secreto = (f.secreto ?? '').trim();
	const haySecreto = !!previo && previo.tipo === tipo && !!previo.secreto;
	if (!secreto && !haySecreto) return { ok: false, error: 'Enter the credential.' };
	const pre = prefijo(f.prefijo ?? '');
	if (pre === null)
		return {
			ok: false,
			error: 'Folder: use letters, digits, «-», «_» and «.» separated by «/».'
		};
	const base = { activo: f.activo !== 'no', tipo, conservar, inmutable };

	if (tipo === 's3') {
		const endpoint = (f.endpoint ?? '').trim().replace(/\/+$/, '');
		if (endpoint) {
			let u: URL;
			try {
				u = new URL(endpoint);
			} catch {
				return { ok: false, error: 'Endpoint: just https://server[:port].' };
			}
			if (!['https:', 'http:'].includes(u.protocol) || u.pathname !== '/' || u.search || u.username)
				return { ok: false, error: 'Endpoint: just https://server[:port].' };
			if (u.protocol === 'http:')
				return {
					ok: false,
					error: 'Endpoint: use https://. The access key would travel in the clear.'
				};
		}
		const bucket = (f.bucket ?? '').trim();
		const region = (f.region ?? '').trim() || 'us-east-1';
		const claveId = (f.claveId ?? '').trim();
		if (!BUCKET.test(bucket)) return { ok: false, error: 'Invalid bucket name.' };
		if (!REGION.test(region)) return { ok: false, error: 'Invalid region.' };
		if (!claveId || claveId.length > 128 || /\s/.test(claveId))
			return { ok: false, error: 'Enter the access key ID.' };
		if (secreto.length > 256) return { ok: false, error: 'The secret key is too long.' };
		return {
			ok: true,
			secreto,
			destino: {
				...base,
				s3: {
					endpoint,
					region,
					bucket,
					prefijo: pre,
					/* Por ruta: lo que piden MinIO y casi todos los compatibles; en AWS, por nombre. */
					estiloRuta: f.estiloRuta === 'si' || (!!endpoint && f.estiloRuta !== 'no'),
					claveId
				}
			}
		};
	}
	if (tipo === 'azure') {
		let contenedor = previo?.tipo === 'azure' ? (previo.azure?.contenedor ?? '') : '';
		if (secreto) {
			let u: URL;
			try {
				u = new URL(secreto);
			} catch {
				return { ok: false, error: 'Paste the container SAS URL (https://…?sv=…&sig=…).' };
			}
			if (u.protocol !== 'https:')
				return { ok: false, error: 'The SAS URL must start with https://.' };
			if (!u.searchParams.get('sig') || !u.searchParams.get('sv'))
				return {
					ok: false,
					error:
						'That URL has no SAS (sv=…&sig=…): generate one for the container, not for the account.'
				};
			if (!u.pathname.replace(/\/+$/, '').slice(1))
				return { ok: false, error: 'The SAS URL must point to a container.' };
			if (u.pathname.replace(/^\/+|\/+$/g, '').includes('/'))
				return { ok: false, error: 'The SAS URL must point to a container, not to a blob.' };
			const sp = u.searchParams.get('sp') ?? '';
			const faltan = ['c', 'w', 'r', 'l', 'd'].filter((p) => !sp.includes(p));
			if (faltan.length)
				return {
					ok: false,
					error: `The SAS lacks permissions: it needs create, write, read, list and delete (sp=cwrld${inmutable ? 'i' : ''}).`
				};
			if (inmutable && !sp.includes('i'))
				return {
					ok: false,
					error:
						'To lock each backup the SAS needs the immutability permission too (sp=…i, «Set immutability policy»).'
				};
			contenedor = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
		}
		if (secreto.length > 2048) return { ok: false, error: 'The SAS URL is too long.' };
		return { ok: true, secreto, destino: { ...base, azure: { contenedor, prefijo: pre } } };
	}
	const servidor = (f.servidor ?? '').trim().replace(/^\\\\/, '');
	const recurso = (f.recurso ?? '').trim();
	const usuario = (f.usuario ?? '').trim();
	const dominio = (f.dominio ?? '').trim();
	if (!SERVIDOR.test(servidor) && !IP.test(servidor))
		return { ok: false, error: 'Server: its name or IP address, without \\\\ or the share.' };
	if (!RECURSO.test(recurso)) return { ok: false, error: 'Invalid share name.' };
	if (!USUARIO.test(usuario)) return { ok: false, error: 'Invalid user name.' };
	if (dominio && !USUARIO.test(dominio)) return { ok: false, error: 'Invalid domain.' };
	if (secreto.length > 256 || /[\0\r\n]/.test(secreto))
		return { ok: false, error: 'Invalid password.' };
	if (inmutable)
		return {
			ok: false,
			error:
				'A shared folder cannot lock backups: leave immutability at 0 and use the snapshots or WORM features of your file server.'
		};
	return {
		ok: true,
		secreto,
		destino: {
			...base,
			smb: {
				servidor,
				recurso,
				carpeta: pre,
				usuario,
				dominio,
				cifrado: f.cifrado !== 'no'
			}
		}
	};
}

/* El secreto de cada tipo, dentro del sobre cifrado. */
const CAMPO_SECRETO: Record<TipoDestino, string> = {
	s3: 'claveSecreta',
	azure: 'sas',
	smb: 'clave'
};

export class SinClave extends Error {}

/* Guarda el destino. Devuelve false si otro lo cambió mientras tanto. */
export async function guardarDestino(
	v: Extract<Validado, { ok: true }>,
	quien: string,
	versionVista: number | null
): Promise<boolean> {
	const previo = await leerDestino();
	if (versionVista !== null && (previo?.version ?? 0) !== versionVista) return false;
	let secreto = previo?.secreto ?? '';
	let fin = previo?.final ?? null;
	if (v.secreto) {
		if (estadoClave() !== 'lista') throw new SinClave(TEXTO_ILEGIBLE['sin-clave']);
		secreto = cifrar({ [CAMPO_SECRETO[v.destino.tipo]]: v.secreto }, CONTEXTO);
		fin = v.destino.tipo === 'azure' ? null : final(v.secreto);
	}
	const nuevo: Destino = {
		...v.destino,
		version: (previo?.version ?? 0) + 1,
		secreto,
		final: fin,
		cambiado: new Date().toISOString(),
		quien,
		pedidos: {}
	};
	await escribir(AJUSTE_DESTINO, nuevo);
	await auditar(quien, 'backup destination changed', {
		tipo: nuevo.tipo,
		activo: nuevo.activo,
		donde: dondeVa(nuevo),
		conservar: nuevo.conservar,
		inmutable: nuevo.inmutable,
		credencialNueva: !!v.secreto
	});
	return true;
}

export async function quitarDestino(quien: string): Promise<void> {
	const previo = await leerDestino();
	if (!previo) return;
	await db.delete(s.ajustes).where(eq(s.ajustes.clave, AJUSTE_DESTINO));
	await auditar(quien, 'backup destination removed', { tipo: previo.tipo, donde: dondeVa(previo) });
}

/* Adónde van, en una línea y sin secretos (para la página y la auditoría). */
export function dondeVa(d: Pick<Destino, 'tipo' | 's3' | 'azure' | 'smb'>): string {
	if (d.tipo === 's3' && d.s3)
		return `s3://${d.s3.bucket}/${d.s3.prefijo}${d.s3.endpoint ? ` (${d.s3.endpoint})` : ''}`;
	if (d.tipo === 'azure' && d.azure)
		return `${d.azure.contenedor}/${d.azure.prefijo}`.replace(/\/$/, '');
	if (d.tipo === 'smb' && d.smb)
		return `\\\\${d.smb.servidor}\\${d.smb.recurso}${d.smb.carpeta ? '\\' + d.smb.carpeta.replaceAll('/', '\\') : ''}`;
	return '';
}

/* Pide al actualizador comprobar la conexión o hacer la prueba de restauración ya. */
export async function pedir(que: 'comprobar' | 'prueba', quien: string): Promise<boolean> {
	const d = await leerDestino();
	if (!d?.activo) return false;
	d.pedidos = {
		...(d.pedidos ?? {}),
		[que]: { id: randomUUID(), cuando: new Date().toISOString(), quien }
	};
	await escribir(AJUSTE_DESTINO, d);
	await auditar(
		quien,
		que === 'prueba' ? 'backup restore test requested' : 'backup destination check requested',
		{
			donde: dondeVa(d)
		}
	);
	return true;
}

/* ---------- La puerta del actualizador ---------- */

export function pruebaToca(d: Destino, e: EstadoCopias, ahora = Date.now()): boolean {
	if (!d.activo) return false;
	if (d.pedidos?.prueba) return true;
	/* Sin nada subido a este destino aún no hay qué probar. */
	if (!e.ultimaSubida || e.huella !== huellaDestino(d)) return false;
	if (!e.prueba) return true;
	const hace = ahora - Date.parse(e.prueba.cuando);
	return e.prueba.resultado === 'fallo' ? hace >= DIA : hace >= PRUEBA_CADA_DIAS * DIA;
}

/* Lo que contesta GET /api/actualizador/copias: el destino con su secreto descifrado. */
export async function paraElActualizador(ahora = Date.now()) {
	const d = await leerDestino();
	const vacio = {
		activo: false,
		huella: '',
		destino: null,
		conservar: 0,
		pruebaToca: false,
		pedidos: { comprobar: '', prueba: '' }
	};
	if (!d) return vacio;
	const e = await leerEstado();
	const leido = descifrar(d.secreto, CONTEXTO);
	if (!leido.ok) return { ...vacio, motivo: TEXTO_ILEGIBLE[leido.motivo] };
	const secreto = leido.valores[CAMPO_SECRETO[d.tipo]] ?? '';
	const destino: Record<string, unknown> = { tipo: d.tipo, inmutable: d.inmutable ?? undefined };
	if (d.tipo === 's3' && d.s3) destino.s3 = { ...d.s3, claveSecreta: secreto };
	if (d.tipo === 'azure' && d.azure) destino.azure = { url: secreto, prefijo: d.azure.prefijo };
	if (d.tipo === 'smb' && d.smb) destino.smb = { ...d.smb, clave: secreto };
	return {
		activo: d.activo,
		huella: huellaDestino(d),
		destino,
		conservar: d.conservar,
		pruebaToca: pruebaToca(d, e, ahora),
		pedidos: { comprobar: d.pedidos?.comprobar?.id ?? '', prueba: d.pedidos?.prueba?.id ?? '' }
	};
}

const texto = (v: unknown, n = 500) => (typeof v === 'string' ? v.slice(0, n) : '');
const numero = (v: unknown) =>
	typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
const NOMBRE = /^sugardaddy-\d{8}-\d{6}\.tar\.age$/;
const SHA = /^[0-9a-f]{64}$/;

/* Lo que manda el actualizador (POST): se guarda, se audita y se limpian los pedidos hechos. */
export async function guardarInforme(
	b: Record<string, unknown>,
	ahora = new Date()
): Promise<void> {
	const d = await leerDestino();
	const e = await leerEstado();
	const cuando = ahora.toISOString();
	const huella = texto(b.huella, 64) || null;
	/* Lo que diga del destino solo vale si es del destino de ahora. */
	const delDeAhora = !!d && !!huella && huella === huellaDestino(d);
	const secretos = d ? secretosDe(d) : [];
	const limpio = (t: unknown, n = 500) => tapar(texto(t, n), secretos);
	const n: EstadoCopias = { ...e, informe: cuando };
	const local = b.local as Record<string, unknown> | null;
	n.local =
		local && NOMBRE.test(texto(local.nombre))
			? { nombre: texto(local.nombre), bytes: numero(local.bytes), cuando: texto(local.cuando, 40) }
			: null;
	if (delDeAhora) {
		if (n.huella !== huella) {
			/* Destino nuevo: lo de antes era de otro sitio. */
			Object.assign(n, {
				ultimaSubida: null,
				remotas: [],
				remotasCuando: null,
				prueba: null,
				bloqueadas: 0,
				avisos: []
			});
		}
		n.huella = huella;
		for (const x of Array.isArray(b.subidas) ? b.subidas : []) {
			const sub = x as Record<string, unknown>;
			if (!NOMBRE.test(texto(sub.nombre)) || !SHA.test(texto(sub.sha256))) continue;
			n.ultimaSubida = {
				nombre: texto(sub.nombre),
				bytes: numero(sub.bytes),
				sha256: texto(sub.sha256),
				cuando
			};
			await auditar('updater', 'backup uploaded off the machine', {
				copia: n.ultimaSubida.nombre,
				bytes: n.ultimaSubida.bytes,
				sha256: n.ultimaSubida.sha256,
				donde: dondeVa(d!)
			});
		}
		const error = limpio(b.error);
		if (error) {
			if (!e.ultimoError || e.ultimoError.detalle !== error)
				await auditar('updater', 'backup upload failed', { detalle: error, donde: dondeVa(d!) });
			n.ultimoError = { detalle: error, cuando, desde: e.ultimoError?.desde ?? cuando };
		} else if (
			e.ultimoError &&
			(b.listadas === true || (Array.isArray(b.subidas) && b.subidas.length))
		) {
			/* Solo un éxito de verdad (subir o listar) cierra el error. */
			n.ultimoError = null;
		}
		if (b.listadas === true) {
			n.remotas = (Array.isArray(b.remotas) ? b.remotas : [])
				.map((r) => r as Record<string, unknown>)
				.filter((r) => NOMBRE.test(texto(r.nombre)))
				.slice(0, 1000)
				.map((r) => ({ nombre: texto(r.nombre), bytes: numero(r.bytes) }));
			n.remotasCuando = cuando;
			n.bloqueadas = numero(b.bloqueadas);
			n.avisos = (Array.isArray(b.avisos) ? b.avisos : []).slice(0, 10).map((a) => limpio(a, 300));
		}
		const hechos = (b.hechos ?? {}) as Record<string, unknown>;
		if (hechos.comprobar && d!.pedidos?.comprobar?.id === hechos.comprobar) {
			n.conexion = error
				? { ok: false, detalle: error, cuando }
				: { ok: true, detalle: `${n.remotas.length} backup(s) found in your storage.`, cuando };
		}
		const p = b.prueba as Record<string, unknown> | undefined;
		if (p && ['ok', 'sin-clave', 'fallo'].includes(texto(p.resultado))) {
			n.prueba = {
				resultado: texto(p.resultado) as Comprobacion['resultado'],
				detalle: limpio(p.detalle),
				nombre: NOMBRE.test(texto(p.nombre)) ? texto(p.nombre) : '',
				bytes: numero(p.bytes),
				huella: (['coincide', 'distinta', 'sin-apuntar'] as const).find((h) => h === p.huella),
				descifrada: p.descifrada === true,
				cuando,
				pedida: !!hechos.prueba
			};
			await auditar('updater', 'backup restore test', {
				resultado: n.prueba.resultado,
				copia: n.prueba.nombre,
				huella: n.prueba.huella ?? null,
				descifrada: n.prueba.descifrada,
				detalle: n.prueba.detalle
			});
		}
		/* Los pedidos atendidos se quitan (si siguen siendo esos). */
		const quedan = { ...(d!.pedidos ?? {}) };
		let cambia = false;
		for (const k of ['comprobar', 'prueba'] as const)
			if (hechos[k] && quedan[k]?.id === hechos[k]) {
				delete quedan[k];
				cambia = true;
			}
		if (cambia) {
			const actual = await leerDestino();
			if (actual && actual.version === d!.version)
				await escribir(AJUSTE_DESTINO, { ...actual, pedidos: quedan });
		}
	}
	await escribir(AJUSTE_ESTADO, n);
}

function secretosDe(d: Destino): string[] {
	const l = descifrar(d.secreto, CONTEXTO);
	return l.ok ? Object.values(l.valores) : [];
}

/* ---------- Los avisos de salud ---------- */

export type ProblemaCopias = {
	clave: string;
	codigo: 'salud.copias-sin-subir' | 'salud.copias-sin-hacer' | 'salud.copias-prueba';
	severidad: Severidad;
	titulo: string;
	texto: string;
};

export const SOBRE_COPIAS = { tipo: 'nodo' as const, id: 'copias', nombre: 'Node backups' };

const horas = (ms: number) => Math.round(ms / 3600_000);

/*
 * Los problemas de las copias. Sin destino no se mira el de subir (no hay adónde);
 * que la máquina no haga copias se mira siempre que el actualizador lo cuente.
 */
export function problemasCopias(
	d: Destino | null,
	e: EstadoCopias,
	ahora = Date.now()
): ProblemaCopias[] {
	const out: ProblemaCopias[] = [];
	const limite = HORAS_SIN_COPIA * 3600_000;
	/* El actualizador lleva un rato sin contar nada (uno de antes, o parado): no se sabe. */
	const reciente = !!e.informe && ahora - Date.parse(e.informe) < limite;
	if (reciente) {
		const edad = e.local ? ahora - Date.parse(e.local.cuando) : Infinity;
		if (edad > limite)
			out.push({
				clave: 'copias:hacer',
				codigo: 'salud.copias-sin-hacer',
				severidad: 'alta',
				titulo: 'The node is not making its nightly backups',
				texto: e.local
					? `The newest backup on this machine is ${horas(edad)} hours old. Check the sugardaddy-copias timer (systemctl status sugardaddy-copias.timer) or run copia.sh by hand to see the error.`
					: 'There is no backup on this machine. Check the sugardaddy-copias timer (systemctl status sugardaddy-copias.timer) or run copia.sh by hand to see the error.'
			});
	}
	if (!d?.activo) return out;
	const deAhora = e.huella === huellaDestino(d);
	const desde = Date.parse(d.cambiado);
	if (e.ultimoError && deAhora)
		out.push({
			clave: 'copias:subir',
			codigo: 'salud.copias-sin-subir',
			severidad: 'alta',
			titulo: 'Node backups are not reaching your storage',
			texto: `${e.ultimoError.detalle.replace(/\.?$/, '.')} The backups stay on this machine meanwhile.`
		});
	else if (ahora - desde > limite) {
		const subida = deAhora && e.ultimaSubida ? Date.parse(e.ultimaSubida.cuando) : 0;
		if (ahora - subida > limite)
			out.push({
				clave: 'copias:subir',
				codigo: 'salud.copias-sin-subir',
				severidad: 'alta',
				titulo: 'Node backups are not reaching your storage',
				texto: subida
					? `No backup has reached your storage for ${horas(ahora - subida)} hours.`
					: `No backup has reached your storage since it was configured ${horas(ahora - desde)} hours ago. Check that the node updater is running.`
			});
	}
	if (deAhora && e.prueba?.resultado === 'fallo')
		out.push({
			clave: 'copias:prueba',
			codigo: 'salud.copias-prueba',
			severidad: 'alta',
			titulo: 'The restore test of the node backups failed',
			texto: `${e.prueba.detalle.replace(/\.?$/, '.')} Until a test passes, do not rely on these backups.`
		});
	return out;
}

/* Para revisarSalud (salidas/salud.ts). */
export async function problemasCopiasDeAhora(ahora = Date.now()): Promise<ProblemaCopias[]> {
	return problemasCopias(await leerDestino(), await leerEstado(), ahora);
}

/* Lo que se dice cuando se arregla. */
export function resueltoCopias(codigo: string): { titulo: string; texto: string } {
	if (codigo === 'salud.copias-sin-hacer')
		return {
			titulo: 'The node is making its backups again',
			texto: 'A new backup was made on this machine.'
		};
	if (codigo === 'salud.copias-prueba')
		return {
			titulo: 'The restore test of the node backups passes again',
			texto: 'The latest test did not find any problem.'
		};
	return {
		titulo: 'Node backups are reaching your storage again',
		texto: 'A backup was uploaded and listed in your storage.'
	};
}
