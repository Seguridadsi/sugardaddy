/*
 * Sensores en otras máquinas (otra VLAN, otra sede, la nube del cliente).
 *
 * La consola da una línea de instalación de un solo uso, como la del nodo.
 * La línea lleva la raíz de la CA de la consola para que curl la verifique
 * (nunca -k), y el script que devuelve deja en esa máquina solo un sensor y
 * su actualizador: sin base de datos, sin consola, sin nada que escuche
 * salvo las trampas. Todo lo abre el sensor hacia la consola.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db, schema as s } from './db';
import { credencialSensorRemoto } from './canal';
import { crearSensor, regenerarToken } from './gestion';
import { comprobarArquitectura } from './arquitectura-sh';

const VIDA = 24 * 60 * 60_000;
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const CARPETA = '/opt/sugardaddy-sensor';

/* Lo que se le dice a quien instala cuando el script sale sin hacer nada: la línea ya no vale. */
const LINEA_GASTADA =
	'esta línea ya se ha gastado: para la otra máquina, genera una nueva en Sensores de la consola.';

/*
 * Un error que se le puede enseñar tal cual a quien instala. El resto sale
 * con un mensaje genérico y queda en el registro de la consola.
 */
export class ErrorCliente extends Error {}

/* La raíz de la CA de la consola, o null si su certificado es de una CA en la que ya se confía. */
function caRaiz(): string | null {
	if (env.TLS_MODO === 'ficheros') return null;
	try {
		const pem = readFileSync(env.CA_RAIZ ?? '', 'utf8');
		if (pem.includes('BEGIN CERTIFICATE')) return pem;
	} catch {
		/* se explica abajo */
	}
	throw new ErrorCliente(
		'La configuración de este nodo se está poniendo al día con la última versión. Vuelve a intentarlo en unos minutos.'
	);
}

/*
 * Da de alta el sensor y devuelve su línea; null si ya hay uno con ese
 * identificador. Con destino, el sensor es el de ese destino sin sensor
 * («Instalar un sensor aquí»; si ya no puede, DestinoNoDisponible); sin él,
 * nace con un destino nuevo.
 */
export async function altaSensorRemoto(
	quien: string,
	v: { id: string; nombre: string; segmento: string },
	destino?: string
) {
	caRaiz();
	if (!(await crearSensor(quien, { ...v, remoto: true }, destino))) return null;
	return lineaSensorRemoto(quien, v.id);
}

/* Una línea nueva para un sensor remoto que ya existe (otra máquina, o reinstalar). */
export async function lineaSensorRemoto(quien: string, sensor: string) {
	const ca = caRaiz();
	const url = env.ORIGIN;
	if (!url?.startsWith('https://'))
		throw new Error('La consola no tiene dirección HTTPS (ORIGIN).');
	const [f] = await db.select().from(s.sensores).where(eq(s.sensores.id, sensor));
	if (!f?.remoto) return null;
	const codigo = randomBytes(24).toString('base64url');
	await db.insert(s.instaladoresSensor).values({
		codigoHash: hash(codigo),
		sensor,
		caduca: new Date(Date.now() + VIDA)
	});
	await db
		.insert(s.auditoria)
		.values({ quien, accion: 'línea de instalación de sensor remoto', detalle: { id: sensor } });
	/* Sin <( ): la línea funciona en cualquier shell (bash, dash, zsh, fish). */
	if (!ca) return `curl -fsSL ${url}/instalar-sensor/${codigo} | sudo bash`;
	return `echo ${Buffer.from(ca).toString('base64')} | base64 -d > /tmp/sugardaddy-ca.pem && curl -fsSL --cacert /tmp/sugardaddy-ca.pem ${url}/instalar-sensor/${codigo} | sudo bash`;
}

/* Gasta el código; si luego algo falla del lado de la consola o el panel, lo devuelve. */
async function gastar(codigo: string) {
	return db.transaction(async (tx) => {
		const [f] = await tx
			.select()
			.from(s.instaladoresSensor)
			.where(
				and(
					eq(s.instaladoresSensor.codigoHash, hash(codigo)),
					isNull(s.instaladoresSensor.usado),
					gt(s.instaladoresSensor.caduca, new Date())
				)
			)
			.for('update');
		if (!f) return null;
		await tx
			.update(s.instaladoresSensor)
			.set({ usado: new Date() })
			.where(eq(s.instaladoresSensor.codigoHash, f.codigoHash));
		return f;
	});
}

const b64 = (t: string) => Buffer.from(t).toString('base64');

export async function scriptSensorRemoto(codigo: string) {
	if (!/^[A-Za-z0-9_-]{32}$/.test(codigo)) return null;
	const inst = await gastar(codigo);
	if (!inst) return null;
	let token: string | null, cred: Awaited<ReturnType<typeof credencialSensorRemoto>>;
	try {
		cred = await credencialSensorRemoto(inst.sensor);
		/* El token sale aquí y solo aquí: va en el script y en la consola queda su hash. */
		token = await regenerarToken('instalador', inst.sensor);
		if (!token) throw new Error('el sensor ya no existe');
	} catch (e) {
		await db
			.update(s.instaladoresSensor)
			.set({ usado: null })
			.where(eq(s.instaladoresSensor.codigoHash, inst.codigoHash));
		throw e;
	}
	const ca = caRaiz();
	const r = cred.release;
	const conf = r.sensorRemoto;
	if (!r.servicios.sensor || !r.actualizador || !conf)
		throw new ErrorCliente(
			`La versión ${r.version} de este nodo no trae lo necesario para instalar sensores en otras máquinas. Actualiza el nodo.`
		);
	const url = env.ORIGIN!;
	const dominio = new URL(url).hostname;

	const entorno = [
		`# Generado por la consola de Sugardaddy. Contiene secretos: no sale de esta máquina.`,
		`SENSOR_ID=${inst.sensor}`,
		`CONSOLA_URL=${url}`,
		`DATOS=${CARPETA}/datos`,
		`CARPETA=${CARPETA}`,
		`SUGARDADDY_TOKEN=${token}`,
		`PUBLICACION_CLAVE_PUBLICA=${env.PUBLICACION_CLAVE_PUBLICA ?? ''}`,
		`REGISTRO=${cred.descarga.registro}`,
		`REGISTRO_USUARIO=${cred.descarga.usuario}`,
		`REGISTRO_TOKEN=${cred.descarga.token}`,
		...Object.entries(conf.entorno?.nuevas ?? {}).map(([k, v]) => `${k}=${v}`),
		...(conf.entorno?.generar ?? []).map((k) => `${k}=${randomBytes(32).toString('hex')}`)
	].join('\n');
	/* Con SUGARDADDY_CONFIGURACION: este compose es el firmado de la versión. */
	const versiones = [
		`# Lo escribe el actualizador tras instalar una versión. No editar a mano.`,
		`SUGARDADDY_VERSION=${r.version}`,
		`SENSOR_IMAGEN=${r.servicios.sensor}`,
		`ACTUALIZADOR_IMAGEN=${r.actualizador}`,
		`SUGARDADDY_CONFIGURACION=${r.version}`
	].join('\n');
	const compose = conf.ficheros['compose.yml'];

	await db.update(s.sensores).set({ version: r.version }).where(eq(s.sensores.id, inst.sensor));

	return `#!/usr/bin/env bash
# Instalador de un sensor de Sugardaddy (${inst.sensor}), generado por la consola.
set -Eeuo pipefail
PASO="preparar"
trap 'echo "Sugardaddy: falló el paso «$PASO». Revisa el mensaje de arriba; si no se arregla, genera otra línea en Sensores de la consola." >&2' ERR
[[ "$(id -u)" == 0 ]] || { echo "Hay que ejecutarlo con sudo" >&2; exit 1; }
${comprobarArquitectura('este sensor', LINEA_GASTADA)}
DIR=${CARPETA}
PASO="instalar Docker"
if ! command -v docker >/dev/null; then
	command -v apt-get >/dev/null || { echo "Hace falta Docker (instalación automática solo en Ubuntu y Debian)"; exit 1; }
	echo "==> Instalando Docker"
	. /etc/os-release
	apt-get update -qq && apt-get install -y -qq ca-certificates curl >/dev/null
	install -m 0755 -d /etc/apt/keyrings
	curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
	apt-get update -qq && apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
fi
PASO="comprobar la consola"
getent hosts ${dominio} >/dev/null || { echo "Sugardaddy: esta máquina no resuelve ${dominio}. Añádelo al DNS (o a /etc/hosts) y vuelve a lanzar la línea." >&2; exit 1; }
PASO="preparar la carpeta"
mkdir -p "$DIR/datos"
cd "$DIR"
umask 077
echo '${b64(entorno)}' | base64 -d > .env
umask 022
echo '${b64(versiones)}' | base64 -d > versiones.env
echo '${b64(compose)}' | base64 -d > compose.yml
${ca ? `echo '${b64(ca)}' | base64 -d > ca-consola.crt` : ': > ca-consola.crt'}
PASO="descargar las imágenes"
grep '^REGISTRO_TOKEN=' .env | cut -d= -f2- | docker login '${cred.descarga.registro}' -u '${cred.descarga.usuario}' --password-stdin >/dev/null
echo "==> Arrancando el sensor"
PASO="arrancar el sensor"
docker compose --env-file .env --env-file versiones.env up -d --wait
echo "Sensor ${inst.sensor} en marcha. En un minuto aparece vivo en Sensores de la consola."
echo "Abre en el cortafuegos de esta máquina los puertos de las trampas que despliegues en él."
`;
}
