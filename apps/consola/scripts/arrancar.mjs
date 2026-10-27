/*
 * Arranque de la consola dentro de su imagen: pone la base de datos al día
 * (preparar-base.mjs: migraciones, identidad del nodo, sensor local y
 * destinos) y levanta el servidor.
 *
 * Si la migración falla, no arranca: el actualizador lo verá como no sano y
 * volverá a la versión anterior. Lo que importa este fichero tiene que
 * viajar en la imagen: el COPY de scripts del Dockerfile (lo vigila
 * migracion-destinos.spec.ts).
 */
import postgres from 'postgres';
import { prepararBase } from './preparar-base.mjs';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Falta DATABASE_URL');

const conexion = postgres(url, { max: 1, onnotice: () => {} });
await prepararBase(conexion, process.env);
await conexion.end();
console.log('[arranque] base de datos al día');

/*
 * Modo «cualquier IP/nombre»: el instalador deja ORIGIN vacío y pone
 * PROTOCOL_HEADER/HOST_HEADER para que el servidor saque el origen de las
 * cabeceras de Caddy. adapter-node no admite ORIGIN='' (lo da por URL inválida),
 * así que un ORIGIN vacío se quita aquí para que lo trate como no definido.
 */
if (process.env.ORIGIN === '') delete process.env.ORIGIN;

await import('../build/index.js');
