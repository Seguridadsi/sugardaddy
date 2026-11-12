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
import { and, eq, gt, isNull } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { lineasDeClaves } from './claves';
import { lineasDePartner } from './catalogo-partner';
import { esCommunity } from './edicion';
import { db, schema as s } from './db';
import { credencialSensorRemoto } from './canal';
import type { Entorno } from '$lib/entorno';
import { crearSensor, prepararToken } from './gestion';
import { comprobarArquitectura } from './arquitectura-sh';
import { detectarRed } from './red-sh';
import { anadirSensorAlAcceso, entradaValida, leerAcceso } from './acceso';
import { raicesParaSensores } from './ca-nodo';
import { contenidaEn } from '@sugardaddy/canal';
import { direccionConsola } from './direccion-consola';

const VIDA = 24 * 60 * 60_000;
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const CARPETA = '/opt/sugardaddy-sensor';

/* Lo que se le dice a quien instala cuando el script sale sin hacer nada: la línea ya no vale. */
const LINEA_GASTADA =
	'this line has already been used: for the other machine, generate a new one in Sensors in the console.';

/*
 * Un error que se le puede enseñar tal cual a quien instala. El resto sale
 * con un mensaje genérico y queda en el registro de la consola.
 */
export class ErrorCliente extends Error {}

/*
 * La raíz de la CA de la consola, o null si su certificado es de una CA en la
 * que ya se confía. Mientras el nodo tiene preparada su CA propia
 * (docs/diseno/ca-nodo.md), también la nueva: el sensor sigue conectando
 * después del cambio.
 */
async function caRaiz(): Promise<string | null> {
	if (env.TLS_MODO === 'ficheros') return null;
	const raices = await raicesParaSensores();
	if (raices) return raices;
	throw new ErrorCliente(
		'This node is updating its configuration to the latest version. Try again in a few minutes.'
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
	v: { id: string; nombre: string; entorno?: Entorno | null },
	destino?: string,
	ip?: string
) {
	await caRaiz();
	/* Antes de crear nada: sin dirección no hay línea, y el sensor quedaría a medias. */
	direccionConsola();
	await comprobarAcceso(v.id, ip);
	/* Su red y su VLAN las cuenta su instalador (detectarRed); hasta entonces, sin indicar. */
	if (!(await crearSensor(quien, { ...v, red: null, vlan: null, remoto: true }, destino)))
		return null;
	return lineaSensorRemoto(quien, v.id, ip);
}

/*
 * Con el acceso a la consola limitado (docs/diseno/acceso-consola.md), la
 * máquina del sensor tiene que estar en la lista: si no, ni la línea de
 * instalación ni sus eventos llegarían al puerto de la consola.
 */
async function comprobarAcceso(sensor: string, ip?: string) {
	if (ip?.trim()) {
		const r = entradaValida(ip);
		if (!r || r.includes('/'))
			throw new ErrorCliente('Enter the IP address of the sensor machine.');
		return;
	}
	const a = await leerAcceso();
	if (a.estado !== 'restringida' || a.entradas.some((e) => e.sensor === sensor)) return;
	/* Ya conectaba desde una dirección que la lista cubre. */
	const [f] = await db
		.select({ direccion: s.sensores.direccion })
		.from(s.sensores)
		.where(eq(s.sensores.id, sensor));
	if (
		!f?.direccion ||
		!contenidaEn(
			f.direccion,
			a.entradas.map((e) => e.red)
		)
	)
		throw new ErrorCliente(
			'Access to this console is limited to a list of addresses: enter the IP address of the sensor machine so it can connect.'
		);
}

/* Una línea nueva para un sensor remoto que ya existe (otra máquina, o reinstalar). */
export async function lineaSensorRemoto(quien: string, sensor: string, ip?: string) {
	const ca = await caRaiz();
	const url = direccionConsola();
	const [f] = await db.select().from(s.sensores).where(eq(s.sensores.id, sensor));
	if (!f?.remoto) return null;
	await comprobarAcceso(sensor, ip);
	if (ip?.trim()) {
		const e = await anadirSensorAlAcceso(quien, sensor, f.nombre, ip);
		if (e) throw new ErrorCliente(e);
	}
	const codigo = randomBytes(24).toString('base64url');
	await db.insert(s.instaladoresSensor).values({
		codigoHash: hash(codigo),
		sensor,
		caduca: new Date(Date.now() + VIDA)
	});
	await db
		.insert(s.auditoria)
		.values({ quien, accion: 'remote sensor install line', detalle: { id: sensor } });
	/* Sin <( ): la línea funciona en cualquier shell (bash, dash, zsh, fish). */
	if (!ca) return `curl -fsSL ${url}/instalar-sensor/${codigo} | sudo bash`;
	/*
	 * La CA va a un fichero de la carpeta de quien pega la línea, con un nombre que no se
	 * puede adivinar. Antes era /tmp/sugardaddy-ca.pem: otro usuario de la máquina podía
	 * crearlo antes, cambiar la CA entre el echo y el curl y, con un MITM, servir su propio
	 * script, que corre como root.
	 */
	const fichero = `"$HOME/.sugardaddy-ca-${hash(codigo).slice(0, 12)}.pem"`;
	return `echo ${Buffer.from(ca).toString('base64')} | base64 -d > ${fichero} && curl -fsSL --cacert ${fichero} ${url}/instalar-sensor/${codigo} | sudo bash; rm -f ${fichero}`;
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
		/*
		 * El token sale aquí y solo aquí: va en el script y en la consola queda su hash.
		 * El anterior vale hasta que el sensor llega con este (rotación verificada).
		 */
		token = await prepararToken('installer', inst.sensor);
		if (!token) throw new Error('the sensor no longer exists');
	} catch (e) {
		await db
			.update(s.instaladoresSensor)
			.set({ usado: null })
			.where(eq(s.instaladoresSensor.codigoHash, inst.codigoHash));
		throw e;
	}
	const ca = await caRaiz();
	const r = cred.release;
	const conf = r.sensorRemoto;
	if (!r.servicios.sensor || !r.actualizador || !conf)
		throw new ErrorCliente(
			`Version ${r.version} of this node does not include what is needed to install sensors on other machines. Update the node.`
		);
	const url = direccionConsola();
	const dominio = new URL(url).hostname;

	/*
	 * El .env se escribe acabado en salto de línea, y lo que el script le añade después
	 * empieza por otro: sin él, SENSOR_PROPAGACION se pegaba a la última línea, que es la
	 * credencial del registro, y el sensor ya no podía descargar ninguna trampa (401).
	 */
	const entorno = [
		`# Generated by the Sugardaddy console. Contains secrets: it does not leave this machine.`,
		`SENSOR_ID=${inst.sensor}`,
		`CONSOLA_URL=${url}`,
		`DATOS=${CARPETA}/datos`,
		`CARPETA=${CARPETA}`,
		`SUGARDADDY_TOKEN=${token}`,
		...lineasDeClaves(),
		/* Su edición: su actualizador y su sensor solo aceptan versiones de ella. */
		`EDICION=${esCommunity() ? 'community' : 'cloud'}`,
		`REGISTRO=${cred.descarga.registro}`,
		`REGISTRO_USUARIO=${cred.descarga.usuario}`,
		`REGISTRO_TOKEN=${cred.descarga.token}`,
		...lineasDePartner(),
		...Object.entries(conf.entorno?.nuevas ?? {}).map(([k, v]) => `${k}=${v}`),
		...(conf.entorno?.generar ?? []).map((k) => `${k}=${randomBytes(32).toString('hex')}`)
	].join('\n');
	/* Con SUGARDADDY_CONFIGURACION: este compose es el firmado de la versión. */
	const versiones = [
		`# Written by the updater after installing a version. Do not edit by hand.`,
		`SUGARDADDY_VERSION=${r.version}`,
		`SENSOR_IMAGEN=${r.servicios.sensor}`,
		`ACTUALIZADOR_IMAGEN=${r.actualizador}`,
		`SUGARDADDY_CONFIGURACION=${r.version}`
	].join('\n');
	const compose = conf.ficheros['compose.yml'];

	await db.update(s.sensores).set({ version: r.version }).where(eq(s.sensores.id, inst.sensor));

	return `#!/usr/bin/env bash
# Installer for a Sugardaddy sensor (${inst.sensor}), generated by the console.
set -Eeuo pipefail
PASO="prepare"
trap 'echo "Sugardaddy: the step \"$PASO\" failed. Check the message above; if it does not fix itself, generate another line in Sensors in the console." >&2' ERR
[[ "$(id -u)" == 0 ]] || { echo "This must be run with sudo" >&2; exit 1; }
${comprobarArquitectura('this sensor', LINEA_GASTADA)}
DIR=${CARPETA}
PASO="install Docker"
if ! command -v docker >/dev/null; then
	command -v apt-get >/dev/null || { echo "Docker is required (automatic installation only on Ubuntu and Debian)"; exit 1; }
	echo "==> Installing Docker (it can take a few minutes; it needs the package repositories of this system)"
	. /etc/os-release
	# Con tope de espera: sin él, un repositorio que no contesta deja la instalación muda.
	APT="apt-get -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::Retries=2 -o DPkg::Lock::Timeout=180"
	echo "    updating the package list"
	$APT update -qq || { echo "Sugardaddy: the package repositories of this system do not answer (apt-get update failed). Check its DNS and its outbound access, and run a new line." >&2; exit 1; }
	$APT install -y -qq ca-certificates curl >/dev/null
	install -m 0755 -d /etc/apt/keyrings
	curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
	echo "    installing Docker Engine"
	$APT update -qq && $APT install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
fi
PASO="check the console"
getent hosts ${dominio} >/dev/null || { echo "Sugardaddy: this machine cannot resolve ${dominio}. Add it to DNS (or to /etc/hosts) and run the line again." >&2; exit 1; }
PASO="prepare the folder"
mkdir -p "$DIR/datos"
chmod 700 "$DIR/datos"
cd "$DIR"
umask 077
echo '${b64(entorno + '\n')}' | base64 -d > .env
umask 022
echo '${b64(versiones)}' | base64 -d > versiones.env
echo '${b64(compose)}' | base64 -d > compose.yml
${ca ? `echo '${b64(ca)}' | base64 -d > ca-consola.crt` : ': > ca-consola.crt'}
# La versión firmada de la que se instala: su catálogo es lo único que este sensor arranca.
mkdir -p firmado
echo '${b64(JSON.stringify(cred.firmada))}' | base64 -d > firmado/version.json
${r.catalogo ? 'echo 1 > firmado/exigir' : ': # sin catálogo en esta versión'}
PASO="download the images"
grep '^REGISTRO_TOKEN=' .env | cut -d= -f2- | docker login '${cred.descarga.registro}' -u '${cred.descarga.usuario}' --password-stdin >/dev/null
# Los discos de las trampas (docs/diseno/discos-trampa.md): el sensor los ve si su carpeta le
# llega con propagación. Solo si la máquina la admite; si no (un contenedor LXC con la raíz
# privada), Docker no arrancaría el sensor con ella.
PASO="check mount propagation"
if docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \\
	--mount "type=bind,source=$DIR/datos,target=/sd,readonly,bind-propagation=rslave" \\
	"$(grep '^SENSOR_IMAGEN=' versiones.env | cut -d= -f2-)" version >/dev/null 2>&1; then
	printf '\\nSENSOR_PROPAGACION=rslave\\n' >> .env
fi
echo "==> Starting the sensor"
PASO="start the sensor"
if ! docker compose --env-file .env --env-file versiones.env up -d --wait; then
	# En una máquina con varias direcciones, Docker saca a los contenedores por la primera de
	# la interfaz, que puede no ser la de la máquina: la consola ve llegar al sensor desde otra.
	SALIDA="$(ip -4 route get 1.1.1.1 2>/dev/null | head -1)"
	DEV="$(printf '%s' "$SALIDA" | sed -n 's/.* dev \\([^ ]*\\).*/\\1/p')"
	SRC="$(printf '%s' "$SALIDA" | sed -n 's/.* src \\([0-9.]*\\).*/\\1/p')"
	if [[ -n "$DEV" && "$(ip -4 -o addr show dev "$DEV" scope global 2>/dev/null | wc -l)" -gt 1 ]]; then
		echo "Sugardaddy: this machine has several addresses on $DEV. Its containers may leave through a different one than the machine itself ($SRC), and the console only lets in the address you entered in Sensors. Make the containers leave through $SRC (source NAT), or allow the other address in the console, and run a new line." >&2
	fi
	false
fi
# Su red y su VLAN, para Sensores: con el token del sensor, que no sale en la línea de órdenes.
PASO="report its network"
${detectarRed}
if [[ -n "$RED_DETECTADA$VLAN_DETECTADA" ]]; then
	printf 'Authorization: Bearer %s\n' "$(grep '^SUGARDADDY_TOKEN=' .env | cut -d= -f2-)" | curl -fsS ${ca ? '--cacert ca-consola.crt ' : ''}-H @- -H 'Content-Type: application/json' -d "{\"red\":\"$RED_DETECTADA\",\"vlan\":\"$VLAN_DETECTADA\"}" ${url}/api/sensor/red >/dev/null || echo "Sugardaddy: could not report its network to the console; enter it in Sensors."
fi
echo "Sensor ${inst.sensor} is running. It shows as online in Sensors in the console within a minute."
echo "Open the ports of the honeypots you deploy on it in this machine's firewall."
`;
}
