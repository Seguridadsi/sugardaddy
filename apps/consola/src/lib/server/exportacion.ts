/*
 * La exportación completa de la consola (Ajustes → Export; brecha B-11 de DORA,
 * estrategia de salida; docs/negocio/plan-de-salida.md).
 *
 * Todo lo que la consola guarda, en formatos abiertos, en un .tar.gz que sale
 * por la respuesta según se lee de la base:
 *
 *   - una sola transacción REPEATABLE READ de solo lectura: todas las tablas son
 *     la misma foto, y la cabeza de la auditoría casa con sus filas;
 *   - cada tabla con un cursor, en trozos de TAMANO_TROZO: ni la tabla de eventos
 *     entera en memoria ni ficheros temporales en el nodo;
 *   - las columnas con secretos (hashes de contraseña, claves, secretos cifrados de
 *     las salidas…) se quitan en la propia consulta, y los ajustes pasan por
 *     sinSecretos.
 *
 * Queda en la auditoría (auditoria.exportacion en el SIEM): al empezar, y al
 * terminar con el SHA-256 del archivo entero y el del manifiesto, o el fallo.
 */
import { Transform, PassThrough, Readable, pipeline, type Writable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { db } from './db';
import { auditar } from './consultas';
import { identidadSello } from './auditoria-cadena';
import { esCommunity } from './edicion';
import { clavesCredencial } from './credenciales';
import { enmascararLinea } from './credenciales-protegidas';
import {
	FORMATO_EXPORTACION,
	LEEME,
	TAMANO_TROZO,
	entradaTar,
	finTar,
	firmarExportacion,
	lineaCef,
	sha256,
	sinSecretos,
	sumas,
	type FicheroManifiesto,
	type FilaEventoExport
} from './exportacion-formato';

type Seccion = 'events' | 'incidents' | 'audit' | 'configuration' | 'users' | 'settings';

export type TablaExport = {
	tabla: string;
	seccion: Seccion;
	/* El nombre de los ficheros: events → events/events-0001.jsonl. */
	nombre: string;
	orden: string;
	/* Columnas que no salen nunca (secretos). */
	quitar?: string[];
	/* Además en CEF (solo eventos). */
	cef?: boolean;
	/* La expresión de la fila, si no es to_jsonb(t) menos las columnas quitadas. */
	fila?: string;
	/* Lo que se hace con cada fila antes de escribirla (JSON y CEF); se prepara una vez por exportación. */
	transformar?: () => (f: Record<string, unknown>) => Record<string, unknown>;
};

/*
 * Un evento sin sus credenciales (B-09): nunca el sobre (credencial), ni la huella
 * HMAC (contrasena_huella), ni la columna vieja en claro (contrasena). Sale la
 * máscara. Una fila de antes de la 0063 que aún no se ha cifrado (el nodo sin
 * CLAVE_SECRETOS) lleva la línea tal cual llegó: se enmascara aquí, también el campo
 * del detalle que tenga el valor de la columna vieja.
 */
export const COLUMNAS_CREDENCIAL = ['credencial', 'contrasena_huella', 'contrasena'];
export function eventoSinCredenciales(
	f: Record<string, unknown>,
	extra: readonly string[] = clavesCredencial()
): Record<string, unknown> {
	const { __contrasena_vieja: vieja, __protegida: protegida, ...resto } = f;
	if (!protegida && typeof resto.linea === 'string')
		resto.linea = enmascararLinea(
			resto.linea,
			extra,
			typeof vieja === 'string' && vieja ? vieja : null
		);
	return resto;
}

/*
 * Qué sale y en qué orden. Lo que NO está aquí no sale, a propósito: sesiones (su id
 * es la cookie), códigos de recuperación y de instalación de sensores, nonces,
 * colas de envío, cuarentena y caché de enriquecimiento (datos derivados).
 */
export const TABLAS_EXPORT: readonly TablaExport[] = [
	{
		tabla: 'eventos',
		seccion: 'events',
		nombre: 'events',
		orden: 't.recibido, t.id',
		cef: true,
		quitar: COLUMNAS_CREDENCIAL,
		fila: `(to_jsonb(t) - ARRAY[${COLUMNAS_CREDENCIAL.map((c) => `'${c}'`).join(', ')}]::text[]) || jsonb_build_object('__contrasena_vieja', t.contrasena, '__protegida', t.credencial IS NOT NULL)`,
		transformar: () => {
			const extra = clavesCredencial();
			return (f) => eventoSinCredenciales(f, extra);
		}
	},
	{
		tabla: 'incidentes_abiertos',
		seccion: 'incidents',
		nombre: 'incidents',
		orden: 't.abierto, t.id'
	},
	{ tabla: 'triaje', seccion: 'incidents', nombre: 'triage', orden: 't.cuando, t.evento' },
	{ tabla: 'artefactos', seccion: 'incidents', nombre: 'artifacts', orden: 't.id' },
	{
		tabla: 'ejecuciones',
		seccion: 'incidents',
		nombre: 'response-executions',
		orden: 't.cuando, t.id'
	},
	{ tabla: 'aprobaciones', seccion: 'incidents', nombre: 'response-approvals', orden: 't.id' },
	{ tabla: 'rupturas', seccion: 'incidents', nombre: 'chain-breaks', orden: 't.id' },
	{
		tabla: 'auditoria',
		seccion: 'audit',
		nombre: 'audit-log',
		orden: 't.id',
		/* La fila canónica, tal cual la hasheó la base (migración 0061): se comprueba fuera sin Postgres. */
		fila: `to_jsonb(t) || jsonb_build_object('canonica', auditoria_canonica(t.id, t.cuando, t.quien, t.accion, t.detalle))`
	},
	{ tabla: 'auditoria_sellos', seccion: 'audit', nombre: 'seals', orden: 't.id' },
	{
		tabla: 'sensores',
		seccion: 'configuration',
		nombre: 'sensors',
		orden: 't.id',
		quitar: ['clave_hash', 'clave_hash_siguiente']
	},
	{ tabla: 'destinos', seccion: 'configuration', nombre: 'targets', orden: 't.id' },
	{ tabla: 'trampas', seccion: 'configuration', nombre: 'decoys', orden: 't.id' },
	{
		tabla: 'balizas',
		seccion: 'configuration',
		nombre: 'beacons',
		orden: 't.token',
		quitar: ['clave', 'nonce']
	},
	{ tabla: 'plantillas', seccion: 'configuration', nombre: 'templates', orden: 't.id' },
	{
		tabla: 'salidas',
		seccion: 'configuration',
		nombre: 'outputs',
		orden: 't.id',
		quitar: ['secretos_cifrados']
	},
	{
		tabla: 'salidas_alcance',
		seccion: 'configuration',
		nombre: 'output-scope',
		orden: 't.salida, t.nivel, t.objeto'
	},
	{ tabla: 'reglas', seccion: 'configuration', nombre: 'response-rules', orden: 't.id' },
	{
		tabla: 'respuestas_config',
		seccion: 'configuration',
		nombre: 'response-settings',
		orden: 't.modulo',
		quitar: ['secretos_cifrados']
	},
	{ tabla: 'reglas_triaje', seccion: 'configuration', nombre: 'triage-rules', orden: 't.id' },
	{ tabla: 'silencios', seccion: 'configuration', nombre: 'silences', orden: 't.id' },
	{ tabla: 'listas', seccion: 'configuration', nombre: 'ip-lists', orden: 't.id' },
	{ tabla: 'origenes_conocidos', seccion: 'configuration', nombre: 'known-sources', orden: 't.id' },
	{ tabla: 'ventanas_pentest', seccion: 'configuration', nombre: 'pentest-windows', orden: 't.id' },
	{
		tabla: 'usuarios_locales',
		seccion: 'users',
		nombre: 'local-users',
		orden: 't.id',
		quitar: ['clave_hash', 'intentos_fallidos', 'bloqueado_hasta']
	},
	{
		tabla: 'llaves_emergencia',
		seccion: 'users',
		nombre: 'emergency-keys',
		orden: 't.id',
		quitar: ['clave_publica', 'contador']
	},
	{ tabla: 'tokens_api', seccion: 'users', nombre: 'api-tokens', orden: 't.id', quitar: ['hash'] },
	{ tabla: 'peticiones_api', seccion: 'users', nombre: 'api-requests', orden: 't.id' },
	{ tabla: 'preferencias_usuario', seccion: 'users', nombre: 'preferences', orden: 't.oid' },
	{ tabla: 'ajustes', seccion: 'settings', nombre: 'settings', orden: 't.clave' }
];

/* Un destino que puede cerrarse a medias (el navegador cancela la descarga). */
function escribir(destino: Writable, b: Buffer): Promise<void> {
	if (destino.destroyed || destino.writableEnded)
		return Promise.reject(new Error('The download was closed.'));
	if (destino.write(b)) return Promise.resolve();
	return new Promise((ok, mal) => {
		const fuera = () => {
			destino.off('drain', listo);
			destino.off('close', cerrado);
			destino.off('error', cerrado);
		};
		const listo = () => {
			fuera();
			ok();
		};
		const cerrado = () => {
			fuera();
			mal(new Error('The download was closed.'));
		};
		destino.once('drain', listo);
		destino.once('close', cerrado);
		destino.once('error', cerrado);
	});
}

export type ResumenExportacion = {
	archivoSha256: string;
	bytes: number;
	manifiestoSha256: string;
	filas: Record<string, number>;
	firma: string;
};

type Sql = typeof db.$client;

/*
 * Escribe el tar (sin comprimir) en `destino`. Devuelve lo que va a la auditoría,
 * salvo el hash del archivo entero, que lo pone quien comprime.
 */
export async function escribirExportacion(
	destino: Writable,
	quien: string,
	ahora = new Date()
): Promise<Omit<ResumenExportacion, 'archivoSha256' | 'bytes'>> {
	const sql = db.$client as Sql;
	const ficheros: FicheroManifiesto[] = [];
	const tablas: { tabla: string; filas: number; partes: number; quitadas: string[] }[] = [];
	const filasPorTabla: Record<string, number> = {};

	const fichero = async (
		ruta: string,
		contenido: Buffer,
		datos: Omit<FicheroManifiesto, 'ruta' | 'bytes' | 'sha256'>,
		enManifiesto = true
	) => {
		for (const b of entradaTar(ruta, contenido, ahora)) await escribir(destino, b);
		if (enManifiesto)
			ficheros.push({ ruta, bytes: contenido.length, sha256: sha256(contenido), ...datos });
	};

	await fichero('README.txt', Buffer.from(LEEME, 'utf8'), {
		tabla: null,
		formato: 'text',
		filas: null
	});

	const { nodo: idNodo, clave } = await identidadSello();
	let cabeza: { ultimo: number; hash: string } | null = null;
	let sello: Record<string, unknown> | null = null;
	let nombreNodo = 'Unnamed node';

	await sql.begin('isolation level repeatable read read only', async (tx) => {
		const [n] = await tx<{ valor: { nombre?: string } }[]>`
			SELECT valor FROM ajustes WHERE clave = 'nodo'`;
		if (n?.valor?.nombre) nombreNodo = n.valor.nombre;
		const nombres = {
			trampas: new Map(
				(await tx<{ id: string; nombre: string }[]>`SELECT id, nombre FROM trampas`).map((t) => [
					t.id,
					t.nombre
				])
			),
			sensores: new Map(
				(await tx<{ id: string; nombre: string }[]>`SELECT id, nombre FROM sensores`).map((t) => [
					t.id,
					t.nombre
				])
			)
		};
		const version = env.SUGARDADDY_VERSION ?? 'dev';

		for (const t of TABLAS_EXPORT) {
			const [{ existe }] = await tx<{ existe: boolean }[]>`
				SELECT EXISTS (
					SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = ${t.tabla}
				) AS existe`;
			if (!existe) continue;
			const quitar = t.quitar ?? [];
			const expresion = t.fila ?? 'to_jsonb(t) - $1::text[]';
			/* Nombres de tabla y orden: constantes de TABLAS_EXPORT, nunca de la petición. */
			const consulta = tx.unsafe(
				`SELECT ${expresion} AS f FROM "${t.tabla}" t ORDER BY ${t.orden}`,
				t.fila ? [] : [quitar]
			);
			const transformar = t.transformar?.();
			let parte = 0;
			let filas = 0;
			let enParte = 0;
			let json: string[] = [];
			let cef: string[] = [];
			let tam = 0;
			const cerrar = async () => {
				parte++;
				const base = `${t.seccion}/${t.nombre}-${String(parte).padStart(4, '0')}`;
				await fichero(`${base}.jsonl`, Buffer.from(json.join(''), 'utf8'), {
					tabla: t.tabla,
					formato: 'jsonl',
					filas: enParte
				});
				if (t.cef)
					await fichero(`${base}.cef`, Buffer.from(cef.join(''), 'utf8'), {
						tabla: t.tabla,
						formato: 'cef',
						filas: enParte
					});
				json = [];
				cef = [];
				tam = 0;
				enParte = 0;
			};
			for await (const lote of consulta.cursor(500)) {
				for (const r of lote as unknown as { f: Record<string, unknown> }[]) {
					const fila =
						t.seccion === 'settings' ? sinSecretos(r.f) : transformar ? transformar(r.f) : r.f;
					const linea = JSON.stringify(fila) + '\n';
					json.push(linea);
					tam += Buffer.byteLength(linea);
					if (t.cef) {
						const c =
							lineaCef(
								fila as unknown as FilaEventoExport,
								nombres,
								{ id: idNodo, nombre: nombreNodo },
								version
							) + '\n';
						cef.push(c);
						tam += Buffer.byteLength(c);
					}
					filas++;
					enParte++;
					if (tam >= TAMANO_TROZO) await cerrar();
				}
			}
			/* Una tabla vacía también deja su fichero (vacío): se ve que se exportó. */
			if (enParte > 0 || parte === 0) await cerrar();
			tablas.push({ tabla: t.tabla, filas, partes: parte, quitadas: quitar });
			filasPorTabla[t.tabla] = filas;
		}

		const [c] = await tx<{ ultimo: number; hash: string }[]>`
			SELECT ultimo::float8 AS ultimo, hash FROM auditoria_cabeza WHERE id = 1`;
		cabeza = c ? { ultimo: Number(c.ultimo), hash: c.hash } : null;
		const [s] = await tx<Record<string, unknown>[]>`
			SELECT to_jsonb(t) AS f FROM auditoria_sellos t ORDER BY id DESC LIMIT 1`;
		sello = (s?.f as Record<string, unknown>) ?? null;
	});

	const cabezaJson = Buffer.from(JSON.stringify({ cabeza, ultimoSello: sello }, null, 2), 'utf8');
	await fichero('audit/head.json', cabezaJson, {
		tabla: 'auditoria_cabeza',
		formato: 'json',
		filas: 1
	});

	const manifiesto = Buffer.from(
		JSON.stringify(
			{
				formato: FORMATO_EXPORTACION,
				generado: ahora.toISOString(),
				nodo: { id: idNodo, nombre: nombreNodo },
				edicion: esCommunity() ? 'community' : 'cloud',
				version: env.SUGARDADDY_VERSION ?? 'dev',
				exportadoPor: quien,
				instantanea:
					'One read-only REPEATABLE READ transaction: every file is the same point in time.',
				auditoria: { cabeza, ultimoSello: sello },
				tablas,
				ficheros
			},
			null,
			2
		) + '\n',
		'utf8'
	);
	const firma = firmarExportacion(clave, idNodo, manifiesto);
	await fichero('manifest.json', manifiesto, { tabla: null, formato: 'json', filas: null }, false);
	await fichero(
		'manifest.sig.json',
		Buffer.from(JSON.stringify(firma, null, 2) + '\n', 'utf8'),
		{ tabla: null, formato: 'json', filas: null },
		false
	);
	if (firma.publica)
		await fichero(
			'public-key.pem',
			Buffer.from(firma.publica, 'utf8'),
			{ tabla: null, formato: 'text', filas: null },
			false
		);
	const todas: FicheroManifiesto[] = [
		...ficheros,
		{
			ruta: 'manifest.json',
			tabla: null,
			formato: 'json',
			filas: null,
			bytes: manifiesto.length,
			sha256: firma.manifiestoSha256
		}
	];
	await fichero(
		'SHA256SUMS',
		Buffer.from(sumas(todas), 'utf8'),
		{
			tabla: null,
			formato: 'text',
			filas: null
		},
		false
	);
	await escribir(destino, finTar());

	return {
		manifiestoSha256: firma.manifiestoSha256,
		filas: filasPorTabla,
		firma: firma.algoritmo
	};
}

/*
 * La descarga: el tar pasa por gzip y por un contador que saca el SHA-256 del
 * archivo tal cual le llega al cliente. Al acabar (bien o mal) queda en la auditoría.
 */
export async function exportacionCompleta(quien: string): Promise<ReadableStream<Uint8Array>> {
	await auditar(quien, 'full data export started', { formato: FORMATO_EXPORTACION });
	const tar = new PassThrough();
	const gz = createGzip({ level: 6 });
	const hash = createHash('sha256');
	let bytes = 0;
	const contador = new Transform({
		transform(trozo: Buffer, _codificacion, listo) {
			hash.update(trozo);
			bytes += trozo.length;
			listo(null, trozo);
		}
	});
	let fallo: Error | null = null;
	const resumen = new Promise<Omit<ResumenExportacion, 'archivoSha256' | 'bytes'>>((ok, mal) => {
		escribirExportacion(tar, quien)
			.then((r) => {
				tar.end();
				ok(r);
			})
			.catch((e) => {
				tar.destroy(e);
				mal(e);
			});
	});
	pipeline(tar, gz, contador, (e) => {
		if (e) fallo = e;
	});
	const terminado = new Promise<void>((ok) => contador.once('close', ok));
	void (async () => {
		try {
			const r = await resumen;
			await terminado;
			if (fallo || !contador.readableEnded) throw fallo ?? new Error('The download was closed.');
			await auditar(quien, 'full data export completed', {
				...r,
				archivoSha256: hash.digest('hex'),
				bytes
			});
		} catch (e) {
			await auditar(quien, 'full data export failed', {
				motivo: e instanceof Error ? e.message : String(e)
			}).catch(() => {});
		}
	})();
	return Readable.toWeb(contador) as ReadableStream<Uint8Array>;
}

/* Las últimas exportaciones, para la pestaña History (de la auditoría). */
export async function historialExportaciones(limite = 50) {
	const sql = db.$client as Sql;
	return sql<
		{ id: number; cuando: Date; quien: string; accion: string; detalle: Record<string, unknown> }[]
	>`
		SELECT id::float8 AS id, cuando, quien, accion, detalle FROM auditoria
		WHERE accion IN ('full data export completed', 'full data export failed')
		ORDER BY id DESC LIMIT ${limite}`;
}
