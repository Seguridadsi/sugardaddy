/*
 * Las credenciales que capturan las trampas, cifradas en la base de datos
 * (B-09 de la fortificación para banca, PLAN-FORTIFICACION §9.3.A).
 *
 * Lo que un atacante teclea en una trampa (contraseñas, hashes NetNTLM,
 * cabeceras Authorization, tokens) puede ser un secreto válido de la propia
 * empresa: alguien de dentro que se equivoca de servidor. Se guarda completo
 * (decisión de producto), pero nunca en claro:
 *
 *  - La línea del evento se guarda con esos campos ENMASCARADOS (`P*****d1`).
 *    Todo lo que la lee (la lista de eventos, la visita, incidentes, las
 *    salidas, el webhook, la API) ve la máscara sin saber nada de esto. El hash
 *    del evento (columna `hash`, la cadena del sensor) es el de la línea tal
 *    como llegó: no cambia.
 *  - Los valores de verdad van en un sobre AES-256-GCM (`credencial`), con una
 *    clave derivada de CLAVE_SECRETOS y ligado al hash del evento: no sirve
 *    copiarlo a otra fila.
 *  - La contraseña (el campo que declara el traductor de la trampa) lleva
 *    además una huella HMAC-SHA256 con otra clave derivada: agrupa y cuenta en
 *    «Captured passwords» y deja comprobar si se probó una contraseña concreta
 *    sin descifrar nada.
 *
 * Descifrar es «revelar»: solo con el permiso ver-credenciales y cada vez queda
 * en la auditoría encadenada (credenciales.ts, revelarDeEvento). Una salida
 * solo las manda completas si se marca en ella (reglas.credenciales).
 *
 * Sin clave en el nodo no se guarda nada en claro: se queda la máscara, el sobre
 * vacío ('') y se pierde el valor (como secretos.ts, nunca se cae a guardarlo
 * sin cifrar).
 */
import { createHmac } from 'node:crypto';
import { claveDelNodo, claveDerivada, cifrar, descifrar, type Clave } from './secretos';

/* Lo que se guarda de cada valor como mucho: lo que pasa de aquí no es una credencial. */
export const MAXIMO_CREDENCIAL = 4096;

/*
 * Campos del detalle que son material de credencial en cualquier trampa,
 * además del que declara su traductor como contraseña. LISTA CERRADA, por
 * nombre exacto: `hash` a secas es el de un fichero descargado (un IOC, lo usa
 * Respuesta) y `clave` en memcached es la clave de la caché, así que no van.
 * Ampliable al estrenar una trampa que capture otra cosa.
 */
export const CAMPOS_CREDENCIAL: readonly string[] = [
	'password',
	'password_cruda',
	'passwd',
	'contrasena',
	'ntlm_hash',
	'scram',
	'credencial',
	'token',
	'secret',
	'secreto',
	'authorization'
];

export const esCampoCredencial = (k: string, declarado?: string | null) =>
	k === declarado || CAMPOS_CREDENCIAL.includes(k);

/*
 * El `token` de un evento de baliza no lo escribe el atacante: es el nuestro,
 * el que ata el evento a su honeycosa. Se deja a la vista para poder ver y
 * buscar qué baliza saltó.
 */
const esTokenDeBaliza = (x: unknown, k: string) =>
	k === 'token' && !!x && typeof x === 'object' && (x as { accion?: unknown }).accion === 'baliza';

/*
 * La máscara: primera letra y dos últimas si es larga, todo tapado si es corta.
 * Dice la longitud (hasta 12; más larga, con un «…») y nada que sirva para
 * adivinarla.
 */
export function mascara(v: string): string {
	const n = [...v].length;
	if (n === 0) return '';
	const letras = [...v];
	if (n < 8) return '*'.repeat(n);
	const medio = Math.min(n - 3, 12);
	return `${letras[0]}${'*'.repeat(medio)}${n - 3 > 12 ? '…' : ''}${letras.slice(-2).join('')}`;
}

/* Lo que se enseña en lugar de un valor que no es texto (una lista, un objeto). */
export const OCULTO = '[encrypted]';

const enmascarar = (v: unknown) => (typeof v === 'string' ? mascara(v) : OCULTO);

/* ¿Hay algo que proteger en este valor? Números y sí/no (p. ej. «usando_password») no. */
const protegible = (v: unknown) =>
	(typeof v === 'string' && v.length > 0) ||
	(Array.isArray(v) && v.length > 0) ||
	(!!v && typeof v === 'object' && Object.keys(v).length > 0);

export const claveCredenciales = (base = claveDelNodo()) =>
	claveDerivada('credenciales-capturadas', base);
export const claveHuella = (base = claveDelNodo()) => claveDerivada('huella-credenciales', base);

/* La huella de una contraseña: HMAC con la clave del nodo, 32 hex. Sin clave, null. */
export function huella(v: string, clave: Clave | null = claveHuella()): string | null {
	if (!clave) return null;
	return createHmac('sha256', clave.bytes).update(v, 'utf8').digest('hex').slice(0, 32);
}

export const contextoDe = (hash: string) => `credencial:${hash}`;

/* Lo que va en el sobre: los campos del detalle tal cual llegaron y la contraseña. */
export type Credencial = { detalle: Record<string, unknown>; contrasena: string | null };

export type Protegida = {
	/* La línea a guardar: la misma si no había nada que proteger. */
	linea: string;
	/* El sobre; '' si había algo y no se pudo cifrar; null si no había nada. */
	credencial: string | null;
	contrasenaHuella: string | null;
	contrasenaMascara: string | null;
	/* Había algo que proteger. */
	protegida: boolean;
	/* Había algo y no se pudo cifrar (el nodo no tiene clave): solo queda la máscara. */
	perdida: boolean;
};

/*
 * Protege una línea antes de guardarla. declarado: el campo de contraseña de su
 * traductor. contrasena: la que ya se sacó (credencialDe), por si la línea no la
 * trae en ese campo (una fila antigua con la columna puesta). hash: el del evento.
 * Una línea que no es JSON se deja como está: no es de un evento.
 */
export function proteger(
	linea: string,
	hash: string,
	declarado: string | null | undefined,
	contrasena: string | null = null,
	base: Clave | null = claveDelNodo()
): Protegida {
	let dato: { detalle?: Record<string, unknown> } | null = null;
	try {
		const x = JSON.parse(linea);
		if (x && typeof x === 'object' && !Array.isArray(x)) dato = x;
	} catch {
		/* no es JSON */
	}
	const detalle =
		dato?.detalle && typeof dato.detalle === 'object' && !Array.isArray(dato.detalle)
			? dato.detalle
			: {};
	const campos: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(detalle))
		if (esCampoCredencial(k, declarado) && !esTokenDeBaliza(dato, k) && protegible(v))
			campos[k] = v;
	const declarada =
		declarado && typeof campos[declarado] === 'string' ? (campos[declarado] as string) : null;
	const laContrasena = (declarada ?? contrasena) || null;
	if (!Object.keys(campos).length && !laContrasena)
		return {
			linea,
			credencial: null,
			contrasenaHuella: null,
			contrasenaMascara: null,
			protegida: false,
			perdida: false
		};

	const recortada = laContrasena?.slice(0, MAXIMO_CREDENCIAL) ?? null;
	const cifra = claveCredenciales(base);
	const sobre: Credencial = { detalle: campos, contrasena: recortada };
	/* '' (y no null): se protegió pero no se pudo cifrar. Así no se vuelve a tomar por de antes. */
	const credencial = cifra ? cifrar({ d: JSON.stringify(sobre) }, contextoDe(hash), cifra) : '';
	let nueva = linea;
	if (dato && Object.keys(campos).length) {
		const tapado = { ...detalle };
		for (const [k, v] of Object.entries(campos)) tapado[k] = enmascarar(v);
		nueva = JSON.stringify({ ...dato, detalle: tapado });
	}
	return {
		linea: nueva,
		credencial,
		contrasenaHuella: recortada ? huella(recortada, claveHuella(base)) : null,
		contrasenaMascara: recortada ? mascara(recortada) : null,
		protegida: true,
		perdida: credencial === ''
	};
}

/*
 * Una línea que no se guarda como evento (la cuarentena) o una fila de antes de la
 * 0063 (la exportación), con los campos de credencial enmascarados. No cifra nada:
 * lo que no es un evento no tiene sobre, y la cuarentena es para ver qué falló, no
 * para recuperar lo que tecleó nadie. extra: los campos que declaran los traductores
 * (credenciales.ts, clavesCredencial). contrasena: la de la columna vieja: un campo
 * del detalle con ese mismo valor también se tapa, aunque ninguna lista lo conozca.
 *
 *  - JSON con detalle: como proteger(), campo a campo del detalle.
 *  - Lo demás (no es JSON, va cortada o trae la credencial fuera del detalle): por
 *    texto, cualquier «"campo": "valor"» de la lista, a cualquier profundidad.
 *
 * Es idempotente: una máscara enmascarada da la misma máscara, y OCULTO se queda.
 */
export function enmascararLinea(
	linea: string,
	extra: readonly string[] = [],
	contrasena: string | null = null
): string {
	const claves = new Set([...CAMPOS_CREDENCIAL, ...extra]);
	try {
		if (esTokenDeBaliza(JSON.parse(linea), 'token')) claves.delete('token');
	} catch {
		/* no es JSON */
	}
	const tapar = (v: unknown) =>
		v === OCULTO ? v : typeof v === 'string' ? mascara(v) : protegible(v) ? OCULTO : v;
	let salida = linea;
	try {
		const x = JSON.parse(linea);
		if (x && typeof x === 'object' && !Array.isArray(x)) {
			const d = (x as { detalle?: unknown }).detalle;
			if (d && typeof d === 'object' && !Array.isArray(d)) {
				const tapado: Record<string, unknown> = { ...(d as Record<string, unknown>) };
				let cambia = false;
				for (const [k, v] of Object.entries(tapado))
					if ((claves.has(k) || (contrasena && v === contrasena)) && protegible(v)) {
						const t = tapar(v);
						if (t !== v) {
							tapado[k] = t;
							cambia = true;
						}
					}
				if (cambia) salida = JSON.stringify({ ...x, detalle: tapado });
			}
		}
	} catch {
		/* no es JSON: por texto */
	}
	const nombres = [...claves]
		.filter((k) => /^[A-Za-z0-9_-]+$/.test(k))
		.map((k) => k.replace(/-/g, '\\-'))
		.join('|');
	salida = salida.replace(
		new RegExp(`("(?:${nombres})"\\s*:\\s*)"((?:[^"\\\\]|\\\\.)*)("|$)`, 'g'),
		(_t, pre: string, v: string, fin: string) =>
			v && v !== OCULTO ? `${pre}"${mascara(v)}${fin}` : `${pre}"${v}${fin}`
	);
	return salida;
}

export type Revelada =
	| { ok: true; credencial: Credencial }
	| { ok: false; motivo: 'sin-clave' | 'otra-clave' | 'ilegible' };

/* Abre el sobre de un evento. No audita: quien llama decide (revelarDeEvento, salidas). */
export function abrir(sobre: string, hash: string, base: Clave | null = claveDelNodo()): Revelada {
	const d = descifrar(sobre, contextoDe(hash), claveCredenciales(base));
	if (!d.ok) return d;
	try {
		const x = JSON.parse(d.valores.d ?? '') as Credencial;
		if (!x || typeof x !== 'object' || typeof x.detalle !== 'object' || !x.detalle)
			return { ok: false, motivo: 'ilegible' };
		return {
			ok: true,
			credencial: {
				detalle: x.detalle,
				contrasena: typeof x.contrasena === 'string' ? x.contrasena : null
			}
		};
	} catch {
		return { ok: false, motivo: 'ilegible' };
	}
}

/*
 * El evento con sus credenciales de vuelta en el detalle: para una salida que
 * las pide completas y para volver a calcular las alertas.
 */
export function restaurar<E extends { detalle?: Record<string, unknown> }>(
	evento: E,
	c: Credencial
): E {
	if (!Object.keys(c.detalle).length) return evento;
	return { ...evento, detalle: { ...(evento.detalle ?? {}), ...c.detalle } };
}
