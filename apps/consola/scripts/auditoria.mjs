/*
 * La auditoría inmutable de la consola (docs/diseno/auditoria-inmutable.md): lo
 * que hace falta para comprobarla y para firmar y verificar su sellado. Aparte y
 * en JavaScript para que lo usen igual la consola (lib/server/auditoria-cadena.ts)
 * y el comando de la máquina (scripts/verificar-auditoria.mjs), que corre en la
 * imagen sin compilar nada.
 *
 * La cadena la calcula la base (trigger auditoria_encadenar, migración 0058):
 *
 *   hash = SHA-256(hash_anterior || auditoria_canonica(fila)), en hex.
 *
 * Aquí se rehace en Node con la fila canónica que da la base: si alguien cambia
 * una fila sin rehacer su hash, no casa; si rehace su hash, no casa el
 * hash_anterior de la siguiente; si lo rehace todo hasta la cabeza, no casa con
 * el último sello, que ya salió de la máquina (al SIEM del cliente y al panel).
 */
import {
	createHash,
	createHmac,
	createPrivateKey,
	createPublicKey,
	sign,
	verify
} from 'node:crypto';

export const GENESIS = '0'.repeat(64);

/** La acción de la fila que deja la purga por plazo (auditoria_purgar). */
export const ACCION_PURGA = 'audit log purged';

/**
 * @param {string} anterior
 * @param {string} canonica
 */
export const hashFila = (anterior, canonica) =>
	createHash('sha256')
		.update(anterior + canonica, 'utf8')
		.digest('hex');

/**
 * @typedef {{ id: number; hashAnterior: string; hash: string; canonica: string; accion: string; detalle: Record<string, unknown> }} FilaCadena
 * @typedef {{ id: number; motivo: string }} Rotura
 */

/**
 * Comprueba una tira de filas seguidas, en orden de id. La primera cuelga del
 * génesis, de la fila de purga que dice su hash, o (con «desde») de lo que diga
 * ella: quien compruebe solo un tramo se fía de su principio.
 *
 * @param {FilaCadena[]} filas
 * @param {{ tramo?: boolean }} [opciones]
 * @returns {{ ok: boolean; filas: number; cabeza: { id: number; hash: string } | null; roturas: Rotura[] }}
 */
export function verificarFilas(filas, opciones = {}) {
	/** @type {Rotura[]} */
	const roturas = [];
	if (!filas.length) return { ok: true, filas: 0, cabeza: null, roturas };
	const primera = filas[0];
	if (!opciones.tramo && primera.hashAnterior !== GENESIS) {
		/* Una purga deja su fila con el hash de la última borrada: de ese cuelga la primera que queda. */
		const purga = filas.find(
			(f) =>
				f.accion === ACCION_PURGA &&
				f.detalle?.hash === primera.hashAnterior &&
				Number(f.detalle?.hasta) < primera.id
		);
		if (!purga)
			roturas.push({
				id: primera.id,
				motivo: 'the first entry does not hang from the start of the chain nor from a purge'
			});
	}
	let anterior = primera.hashAnterior;
	let idAnterior = -Infinity;
	for (const f of filas) {
		if (f.id <= idAnterior) roturas.push({ id: f.id, motivo: 'out of order' });
		if (f.hashAnterior !== anterior)
			roturas.push({
				id: f.id,
				motivo: 'does not hang from the previous entry (one was removed or changed)'
			});
		if (hashFila(f.hashAnterior, f.canonica) !== f.hash)
			roturas.push({ id: f.id, motivo: 'its content does not match its hash (it was changed)' });
		anterior = f.hash;
		idAnterior = f.id;
	}
	const ultima = filas[filas.length - 1];
	return {
		ok: !roturas.length,
		filas: filas.length,
		cabeza: { id: ultima.id, hash: ultima.hash },
		roturas
	};
}

/**
 * El texto que se firma en un sello. Lleva el nodo, para que un sello de otro
 * nodo no valga aquí.
 *
 * @param {{ nodo: string; hasta: number; hash: string; cuando: string }} s
 */
export const textoSello = (s) =>
	`sugardaddy/auditoria-sello\n${s.nodo}\n${s.hasta}\n${s.hash}\n${s.cuando}`;

/**
 * La clave con la que firma el nodo: la Ed25519 del canal con el panel si lo
 * tiene; si no (un nodo Community), un HMAC con CLAVE_SECRETOS.
 *
 * @typedef {{ algoritmo: 'ed25519'; privada: string; publica: string } | { algoritmo: 'hmac-sha256'; secreto: string }} ClaveSello
 */

/**
 * @param {string} b64
 */
const huellaPublica = (b64) =>
	createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').slice(0, 16);

/**
 * @param {string} hex
 */
const hmacClave = (hex) =>
	createHash('sha256')
		.update('sugardaddy/auditoria-sello\n')
		.update(Buffer.from(hex, 'hex'))
		.digest();

/**
 * @param {ClaveSello} clave
 * @param {{ nodo: string; hasta: number; hash: string; cuando: string }} s
 * @returns {{ algoritmo: 'ed25519' | 'hmac-sha256'; clave: string | null; firma: string }}
 */
export function firmarSello(clave, s) {
	const texto = Buffer.from(textoSello(s), 'utf8');
	if (clave.algoritmo === 'ed25519') {
		const k = createPrivateKey({
			key: Buffer.from(clave.privada, 'base64'),
			format: 'der',
			type: 'pkcs8'
		});
		return {
			algoritmo: 'ed25519',
			clave: huellaPublica(clave.publica),
			firma: sign(null, texto, k).toString('base64')
		};
	}
	return {
		algoritmo: 'hmac-sha256',
		clave: null,
		firma: createHmac('sha256', hmacClave(clave.secreto)).update(texto).digest('base64')
	};
}

/**
 * ¿Es buena la firma de un sello? null si no hay con qué comprobarla (un sello
 * HMAC sin CLAVE_SECRETOS, o uno Ed25519 de otra clave).
 *
 * @param {{ nodo: string; hasta: number; hash: string; cuando: string; algoritmo: string; clave: string | null; firma: string }} s
 * @param {{ publica?: string | null; secreto?: string | null }} claves
 * @returns {boolean | null}
 */
export function verificarSello(s, claves) {
	const texto = Buffer.from(textoSello(s), 'utf8');
	try {
		if (s.algoritmo === 'ed25519') {
			if (!claves.publica || (s.clave && s.clave !== huellaPublica(claves.publica))) return null;
			const k = createPublicKey({
				key: Buffer.from(claves.publica, 'base64'),
				format: 'der',
				type: 'spki'
			});
			return verify(null, texto, k, Buffer.from(s.firma, 'base64'));
		}
		if (s.algoritmo === 'hmac-sha256') {
			if (!claves.secreto) return null;
			const esperada = createHmac('sha256', hmacClave(claves.secreto))
				.update(texto)
				.digest('base64');
			return esperada === s.firma;
		}
	} catch {
		return false;
	}
	return false;
}

/**
 * Comprueba la auditoría entera (o desde un id) contra la base y sus sellos.
 * Lee de mil en mil: no carga la tabla en memoria.
 *
 * @param {import('postgres').Sql} sql
 * @param {{ desde?: number; nodo: string; publica?: string | null; secreto?: string | null }} opciones
 */
export async function verificarAuditoria(sql, opciones) {
	const desde = opciones.desde ?? null;
	/** @type {Rotura[]} */
	const roturas = [];
	let filas = 0;
	/** @type {{ id: number; hash: string } | null} */
	let cabeza = null;
	/** @type {FilaCadena | null} */
	let ultima = null;
	let id = desde === null ? -1 : desde - 1;
	for (;;) {
		const lote = (
			await sql`select id, hash_anterior, hash, accion, detalle,
				auditoria_canonica(id, cuando, quien, accion, detalle) as canonica
				from auditoria where id > ${id} order by id limit 1000`
		).map((f) => ({
			id: Number(f.id),
			hashAnterior: String(f.hash_anterior),
			hash: String(f.hash),
			accion: String(f.accion),
			detalle: typeof f.detalle === 'string' ? JSON.parse(f.detalle) : f.detalle,
			canonica: String(f.canonica)
		}));
		if (!lote.length) break;
		/* Cada lote se comprueba junto con la última fila del anterior: así no se pierde la costura. */
		const r = verificarFilas(ultima ? [ultima, ...lote] : lote, { tramo: true });
		/* La primera de todas cuelga del génesis o de una purga, que puede estar más adelante. */
		if (!ultima && desde === null && lote[0].hashAnterior !== GENESIS) {
			const purga = await sql`select 1 from auditoria
				where accion = ${ACCION_PURGA} and detalle->>'hash' = ${lote[0].hashAnterior}
				and (detalle->>'hasta')::bigint < ${lote[0].id} limit 1`;
			if (!purga.length)
				roturas.push({
					id: lote[0].id,
					motivo: 'the first entry does not hang from the start of the chain nor from a purge'
				});
		}
		for (const x of r.roturas)
			if (!roturas.some((y) => y.id === x.id && y.motivo === x.motivo)) roturas.push(x);
		filas += lote.length;
		ultima = lote[lote.length - 1];
		cabeza = { id: ultima.id, hash: ultima.hash };
		id = ultima.id;
		if (roturas.length > 100) break;
	}

	/* Los sellos: su firma, y que la fila sellada siga ahí con el mismo hash. */
	const sellos = await sql`select s.id, s.cuando, s.hasta, s.hash, s.algoritmo, s.clave, s.firma,
		a.hash as hash_fila
		from auditoria_sellos s left join auditoria a on a.id = s.hasta
		where ${desde === null} or s.hasta >= ${desde ?? 0}
		order by s.id`;
	let sellosBien = 0;
	let sellosSinComprobar = 0;
	/** @type {{ id: number; motivo: string }[]} */
	const sellosMal = [];
	for (const s of sellos) {
		const cuando = new Date(s.cuando).toISOString();
		const firma = verificarSello(
			{
				nodo: opciones.nodo,
				hasta: Number(s.hasta),
				hash: s.hash,
				cuando,
				algoritmo: s.algoritmo,
				clave: s.clave,
				firma: s.firma
			},
			{ publica: opciones.publica, secreto: opciones.secreto }
		);
		if (firma === false) sellosMal.push({ id: Number(s.id), motivo: 'bad signature' });
		else if (s.hash_fila === null || s.hash_fila === undefined)
			sellosMal.push({ id: Number(s.id), motivo: `the sealed entry ${s.hasta} is missing` });
		else if (s.hash_fila !== s.hash)
			sellosMal.push({ id: Number(s.id), motivo: `the sealed entry ${s.hasta} has changed` });
		else if (firma === null) sellosSinComprobar++;
		else sellosBien++;
	}
	return {
		ok: !roturas.length && !sellosMal.length,
		filas,
		cabeza,
		roturas,
		sellos: {
			total: sellos.length,
			bien: sellosBien,
			sinComprobar: sellosSinComprobar,
			mal: sellosMal
		}
	};
}
