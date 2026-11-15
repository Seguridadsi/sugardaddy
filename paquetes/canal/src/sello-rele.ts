/*
 * El sello de una señal del relé hacia la clave de su cliente (docs/diseno/rele-balizas.md,
 * «Señales selladas»). AÚN NO SE USA: es el formato, el mismo que sella el relé
 * (rele/sello.go) y probado contra el mismo vector (vectores/sello-rele.json), para
 * conectarlo sin tocar los cebos que ya hay.
 *
 * - El nodo tiene una clave X25519 de balizas; la privada no sale de él.
 * - Un token sellado lleva la pública: "k" + base64url(pública ‖ 16 bytes al azar).
 * - El relé sella cada línea hacia esa clave y solo deja en claro la ruta, un resumen
 *   del token. El panel encamina por la ruta y entrega el sello sin poder abrirlo.
 * - El nodo lo abre con su privada.
 */
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	randomBytes,
	type KeyObject
} from 'node:crypto';

const PREFIJO = 'k';
const LARGO = 65;
const INFO_SELLO = 'sugardaddy rele sello v1';
const INFO_RUTA = 'sugardaddy rele ruta v1|';
/* Cabeceras DER para una clave X25519 en bruto (RFC 8410). */
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');

export type Sellada = { v: 1; r: string; e: string; c: string };

const privadaDe = (cruda: Uint8Array) =>
	createPrivateKey({ key: Buffer.concat([PKCS8, cruda]), format: 'der', type: 'pkcs8' });
const publicaDe = (cruda: Uint8Array) =>
	createPublicKey({ key: Buffer.concat([SPKI, cruda]), format: 'der', type: 'spki' });
const cruda = (k: KeyObject) =>
	k.type === 'private'
		? k.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8.length)
		: k.export({ format: 'der', type: 'spki' }).subarray(SPKI.length);

/* Una clave de balizas nueva para el nodo: las dos mitades en bruto (32 bytes). */
export function nuevaClaveSello(): { publica: Buffer; privada: Buffer } {
	const { publicKey, privateKey } = generateKeyPairSync('x25519');
	return { publica: cruda(publicKey), privada: cruda(privateKey) };
}

/* Un token sellado nuevo para la clave pública de un nodo. */
export function tokenSellado(publica: Uint8Array, azar: Uint8Array = randomBytes(16)): string {
	if (publica.length !== 32 || azar.length !== 16) throw new Error('clave o azar mal formados');
	return PREFIJO + Buffer.concat([publica, azar]).toString('base64url');
}

/* La clave pública que lleva un token sellado; null si es de los de antes. */
export function claveDeToken(token: string): Buffer | null {
	if (token.length !== LARGO || !token.startsWith(PREFIJO)) return null;
	const b = Buffer.from(token.slice(PREFIJO.length), 'base64url');
	return b.length === 48 && b.toString('base64url') === token.slice(PREFIJO.length)
		? b.subarray(0, 32)
		: null;
}

/* Lo que el panel ve de un token sellado: 16 bytes de su SHA-256, en base64url. */
export function rutaDeToken(token: string): string {
	return createHash('sha256')
		.update(INFO_RUTA + token)
		.digest()
		.subarray(0, 16)
		.toString('base64url');
}

function llave(secreto: Buffer, efimera: Buffer, destino: Buffer): Buffer {
	return Buffer.from(
		hkdfSync('sha256', secreto, Buffer.concat([efimera, destino]), INFO_SELLO, 32)
	);
}

/*
 * Sella una línea hacia la clave del token. Lo hace el relé; aquí sirve para las
 * pruebas y para el banco. `efimera` solo la eligen las pruebas.
 */
export function sellar(token: string, linea: Uint8Array, efimera?: Uint8Array): Sellada {
	const destino = claveDeToken(token);
	if (!destino) throw new Error('el token no es sellado');
	const priv = efimera ? privadaDe(efimera) : generateKeyPairSync('x25519').privateKey;
	const pub = cruda(createPublicKey(priv));
	const secreto = diffieHellman({ privateKey: priv, publicKey: publicaDe(destino) });
	const ruta = rutaDeToken(token);
	const c = createCipheriv('aes-256-gcm', llave(secreto, pub, destino), Buffer.alloc(12));
	c.setAAD(Buffer.from(ruta));
	const cifrado = Buffer.concat([c.update(linea), c.final(), c.getAuthTag()]);
	return { v: 1, r: ruta, e: pub.toString('base64url'), c: cifrado.toString('base64url') };
}

/*
 * Abre un sello con la clave privada del nodo. null si no es para esa clave, se ha
 * tocado, o se ha pasado a otra ruta.
 */
export function abrir(s: Sellada, privada: Uint8Array): Buffer | null {
	try {
		if (s.v !== 1 || typeof s.r !== 'string' || typeof s.e !== 'string') return null;
		const priv = privadaDe(privada);
		const destino = cruda(createPublicKey(priv));
		const efimera = Buffer.from(s.e, 'base64url');
		const todo = Buffer.from(s.c, 'base64url');
		if (efimera.length !== 32 || todo.length < 16) return null;
		const secreto = diffieHellman({ privateKey: priv, publicKey: publicaDe(efimera) });
		const d = createDecipheriv('aes-256-gcm', llave(secreto, efimera, destino), Buffer.alloc(12));
		d.setAAD(Buffer.from(s.r));
		d.setAuthTag(todo.subarray(todo.length - 16));
		return Buffer.concat([d.update(todo.subarray(0, todo.length - 16)), d.final()]);
	} catch {
		return null;
	}
}
