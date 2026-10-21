/*
 * Los secretos que el cliente pone en su consola (el token de su SIEM, la
 * contraseña de su correo, la URL de su webhook de Teams…), cifrados con la
 * clave del nodo.
 *
 * La clave es CLAVE_SECRETOS del .env del nodo: 32 bytes en hexadecimal que
 * genera instalar.sh y, en un nodo instalado antes, el actualizador al
 * aplicar la versión (está en «generar» de despliegue/nodo/entorno.json).
 * No sale de esa máquina más que en sus copias cifradas (copia.sh). La base
 * de datos solo guarda lo cifrado: un volcado de Postgres no dice nada.
 *
 * AES-256-GCM: cifra y autentica. Cada sobre lleva el id de la clave con que
 * se hizo y va ligado a su dueño (el contexto, p. ej. «salida:<id>»), así
 * que no sirve copiarlo a otra fila. Si la clave falta o es otra (el nodo
 * se reinstaló sin su .env, o se restauró la base de datos en otra máquina),
 * no se puede leer: quien lo usa pide que se vuelva a poner. Nunca se
 * intenta adivinar ni se cae a guardarlo sin cifrar.
 *
 * Un secreto no se enseña entero en ningún sitio, ni se escribe en los
 * registros ni en la auditoría: como mucho sus 4 últimos caracteres (final)
 * y, en un error que lo repita, tapado (tapar).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';

const VERSION = 'v1';
const ALGORITMO = 'aes-256-gcm';

export type Clave = { bytes: Buffer; id: string };
export type EstadoClave = 'lista' | 'falta' | 'mal-formada';

/* El id de una clave: no la revela y sirve para saber con cuál se cifró un sobre. */
const idDe = (bytes: Buffer) =>
	createHash('sha256')
		.update('sugardaddy/clave-secretos\n')
		.update(bytes)
		.digest('hex')
		.slice(0, 16);

export function estadoClave(): EstadoClave {
	const v = env.CLAVE_SECRETOS?.trim() ?? '';
	if (!v) return 'falta';
	return /^[0-9a-fA-F]{64}$/.test(v) ? 'lista' : 'mal-formada';
}

export function claveDelNodo(): Clave | null {
	if (estadoClave() !== 'lista') return null;
	const bytes = Buffer.from(env.CLAVE_SECRETOS!.trim(), 'hex');
	return { bytes, id: idDe(bytes) };
}

const b64 = (b: Buffer) => b.toString('base64url');
const aad = (id: string, contexto: string) => Buffer.from(`${VERSION}|${id}|${contexto}`, 'utf8');

/*
 * Cifra un objeto id → valor para un dueño. Sin clave lanza: quien llama
 * comprueba antes estadoClave() y se lo dice al cliente.
 */
export function cifrar(
	valores: Record<string, string>,
	contexto: string,
	clave = claveDelNodo()
): string {
	if (!clave) throw new Error('Este nodo no tiene clave para cifrar secretos (CLAVE_SECRETOS)');
	const iv = randomBytes(12);
	const c = createCipheriv(ALGORITMO, clave.bytes, iv);
	c.setAAD(aad(clave.id, contexto));
	const datos = Buffer.concat([c.update(JSON.stringify(valores), 'utf8'), c.final()]);
	return [VERSION, clave.id, b64(iv), b64(datos), b64(c.getAuthTag())].join('.');
}

export type Descifrado =
	| { ok: true; valores: Record<string, string> }
	/* sin-clave: el nodo no tiene; otra-clave: se cifró con otra; ilegible: no cuadra (o se tocó). */
	| { ok: false; motivo: 'sin-clave' | 'otra-clave' | 'ilegible' };

export function descifrar(sobre: string, contexto: string, clave = claveDelNodo()): Descifrado {
	const partes = sobre.split('.');
	if (partes.length !== 5 || partes[0] !== VERSION) return { ok: false, motivo: 'ilegible' };
	if (!clave) return { ok: false, motivo: 'sin-clave' };
	const [, id, iv, datos, etiqueta] = partes;
	if (id !== clave.id) return { ok: false, motivo: 'otra-clave' };
	try {
		const d = createDecipheriv(ALGORITMO, clave.bytes, Buffer.from(iv, 'base64url'));
		d.setAAD(aad(id, contexto));
		d.setAuthTag(Buffer.from(etiqueta, 'base64url'));
		const texto = Buffer.concat([d.update(Buffer.from(datos, 'base64url')), d.final()]).toString(
			'utf8'
		);
		const valores = JSON.parse(texto) as unknown;
		if (!valores || typeof valores !== 'object' || Array.isArray(valores))
			return { ok: false, motivo: 'ilegible' };
		for (const v of Object.values(valores))
			if (typeof v !== 'string') return { ok: false, motivo: 'ilegible' };
		return { ok: true, valores: valores as Record<string, string> };
	} catch {
		return { ok: false, motivo: 'ilegible' };
	}
}

/* Lo que se dice al cliente cuando un secreto guardado no se puede leer. */
export const TEXTO_ILEGIBLE: Record<Exclude<Descifrado, { ok: true }>['motivo'], string> = {
	'sin-clave':
		'Este nodo no tiene su clave para leer secretos (CLAVE_SECRETOS en su .env): vuelve a poner el secreto cuando la tenga.',
	'otra-clave':
		'El secreto se guardó con otra clave del nodo (p. ej. tras reinstalarlo o restaurar una copia en otra máquina): vuelve a ponerlo.',
	ilegible: 'El secreto guardado no se puede leer: vuelve a ponerlo.'
};

/* Los 4 últimos caracteres, solo si es lo bastante largo como para que no digan casi nada. */
export const final = (secreto: string): string | null =>
	secreto.length >= 16 ? secreto.slice(-4) : null;

/* Un trozo que parece de un secreto y no una palabra: 16 caracteres o más, o 8 con algo que no es una letra. */
const pareceSecreto = (t: string) => t.length >= 16 || (t.length >= 8 && /[^\p{L}]/u.test(t));

const descodificar = (t: string) => {
	try {
		return decodeURIComponent(t);
	} catch {
		return t;
	}
};

/*
 * Los trozos de un secreto que un destino puede repetir sueltos: en una URL
 * (la de Teams o Slack), cada trozo de la ruta, cada valor de la query y el
 * usuario y la contraseña; en lo demás (una cabecera Authorization «Bearer
 * …»), lo que va separado por espacios, comas, «;», «&» o «=». Solo los que
 * parecen de un secreto: «workflows» o «Bearer» no se tapan.
 */
export function trozosSecreto(s: string): string[] {
	let partes: string[];
	try {
		const u = new URL(s);
		if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('no es web');
		partes = [
			...u.pathname.split('/'),
			...u.search
				.slice(1)
				.split('&')
				.flatMap((p) => p.split('=').slice(1)),
			u.username,
			u.password
		];
	} catch {
		partes = s.split(/[\s,;&=]+/);
	}
	return [...new Set(partes.flatMap((p) => [p, descodificar(p)]))].filter(pareceSecreto);
}

/*
 * Un texto (un error del destino, p. ej.) con cada secreto tapado, también
 * como va en una URL y también a trozos (trozosSecreto: un 401 que repite
 * solo el token de «Bearer …» o solo la firma de la URL de Teams). Es la
 * última defensa: lo que se guarda o se registra pasa por aquí antes.
 */
export function tapar(texto: string, secretos: Iterable<string>): string {
	const formas = new Set<string>();
	for (const s of secretos) {
		if (s.length < 4) continue;
		for (const x of [s, ...trozosSecreto(s)]) {
			formas.add(x);
			formas.add(encodeURIComponent(x));
		}
	}
	let t = texto;
	/* Lo más largo primero: que no quede a la vista el resto de un secreto tras tapar un trozo. */
	for (const forma of [...formas].sort((a, b) => b.length - a.length))
		t = t.split(forma).join('••••');
	return t;
}
