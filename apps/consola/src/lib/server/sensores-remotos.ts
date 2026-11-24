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
import { credencialSensorRemoto, releaseCompletaDelNodo } from './canal';
import type { Entorno } from '$lib/entorno';
import { crearSensor, prepararToken, reactivarSensor } from './gestion';
import { PROXY_SH } from './proxy-sh';
import { AISLAMIENTO_SH } from './aislamiento-sh';
import { POLITICA_SH } from './politica-sh';
import { normalizarIp } from './pruebas';
import { comprobarArquitectura } from './arquitectura-sh';
import { detectarRed } from './red-sh';
import { anadirSensorAlAcceso, entradaValida, leerAcceso } from './acceso';
import { raicesParaSensores } from './ca-nodo';
import { certificadoParaInstalador } from './ca-sensores';
import { contenidaEn, piezasInstalador, piezasInstaladorSensor } from '@sugardaddy/canal';
import { direccionConsola, direccionConsolaDe } from './direccion-consola';
import {
	ErrorCliente,
	type Descarga,
	comprobarConsola,
	comprobarIdSensor,
	entornoDelSensor,
	validarDescarga
} from './script-sensor';

const VIDA = 24 * 60 * 60_000;
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const CARPETA = '/opt/sugardaddy-sensor';

/* Lo que se le dice a quien instala cuando el script sale sin hacer nada: la línea ya no vale. */
const LINEA_GASTADA =
	'this line has already been used: for the other machine, generate a new one in Sensors in the console.';

/* Un error que se le puede enseñar tal cual a quien instala (script-sensor.ts). */
export { ErrorCliente };

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
 * La consola vista desde la máquina del sensor (en Sensores, «Address of this
 * console as seen from that machine»). La dirección que se da a un sensor remoto es el
 * nombre de la consola, el de su certificado; una máquina de fuera de la red del
 * cliente (un sensor en internet, otra sede sin su DNS) no lo resuelve. Con esta
 * IP, la línea baja el instalador con `curl --resolve` y el instalador deja la
 * resolución fija para el sensor y su actualizador (CONSOLA_FIJA en su .env, que
 * su compose lleva a extra_hosts): nadie toca /etc/hosts a mano, y el
 * certificado se sigue comprobando contra el nombre, no contra la IP.
 *
 * Vacío: null (la máquina resuelve el nombre). También null si la consola ya se
 * da por una IP: no hay nombre que resolver.
 */
export function ipDeConsola(
	texto: string | null | undefined,
	url = direccionConsola()
): string | null {
	const t = (texto ?? '').trim();
	if (!t) return null;
	const ip = normalizarIp(t);
	if (!ip)
		throw new ErrorCliente(
			'Enter the IP address at which that machine reaches this console, or leave it empty if it resolves the console name.'
		);
	return normalizarIp(new URL(url).hostname) ? null : ip;
}

/*
 * Lo que la consola propone en ese campo: la dirección por la que está entrando
 * quien da el alta, si es una IP y no es ya la dirección de la consola. Quien
 * entra por IP desde fuera suele estar donde estará el sensor. Si entra por
 * nombre, nada: lo normal es que la otra máquina también lo resuelva.
 */
export function ipDeConsolaPropuesta(anfitrion: string, url: string | null): string | null {
	const ip = normalizarIp(anfitrion);
	/* Desde la propia máquina de la consola (el bucle local) no se propone: no le vale a ninguna otra. */
	if (!ip || !url || contenidaEn(ip, ['127.0.0.0/8', '::1'])) return null;
	const propio = new URL(url).hostname;
	return normalizarIp(propio) ? null : ip;
}

/*
 * Para los formularios de alta: el nombre que el sensor tendrá que resolver
 * (null si la consola se da por una IP o no tiene dirección: no hay campo que
 * enseñar) y la IP que se propone, según por dónde entra quien mira.
 */
export function consolaParaAlta(anfitrion: string): {
	nombre: string | null;
	propuesta: string | null;
} {
	const url = direccionConsolaDe(env.ORIGIN, env.CONSOLA_URL);
	const nombre = url ? new URL(url).hostname : null;
	if (!nombre || normalizarIp(nombre)) return { nombre: null, propuesta: null };
	return { nombre, propuesta: ipDeConsolaPropuesta(anfitrion, url) };
}

/* Los argumentos de curl que fijan esa resolución para una petición a la consola. */
export function resolverConsola(url: string, ip: string | null): string {
	if (!ip) return '';
	const u = new URL(url);
	return `--resolve ${u.hostname}:${u.port || '443'}:${ip} `;
}

/*
 * Da de alta el sensor y devuelve su línea; null si ya hay uno con ese
 * identificador. Con destino, el sensor es el de ese destino sin sensor
 * («Instalar un sensor aquí»; si ya no puede, DestinoNoDisponible); sin él,
 * nace con un destino nuevo. Si el identificador es el de un sensor remoto
 * retirado (se quitó, pero su historia se conserva), lo reactiva con una línea
 * nueva en vez de rechazarlo: sus eventos siguen siendo suyos.
 */
export async function altaSensorRemoto(
	quien: string,
	v: { id: string; nombre: string; entorno?: Entorno | null },
	destino?: string,
	ip?: string,
	consola?: string
) {
	await caRaiz();
	/* Antes de crear nada: sin dirección no hay línea, y el sensor quedaría a medias. */
	const consolaIp = ipDeConsola(consola, direccionConsola());
	await comprobarAcceso(v.id, ip);
	/* Su red y su VLAN las cuenta su instalador (detectarRed); hasta entonces, sin indicar. */
	if (
		!(await crearSensor(quien, { ...v, consolaIp, red: null, vlan: null, remoto: true }, destino))
	) {
		/* Ya existe. Solo vale si es uno retirado, y no para colgarlo de otro destino: tiene el suyo. */
		if (destino || !(await reactivarSensor(quien, { ...v, consolaIp }))) return null;
	}
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

/*
 * Una línea nueva para un sensor remoto que ya existe (otra máquina, o reinstalar).
 * Con `consola` (aunque sea vacío) cambia en qué IP ve su máquina a la consola;
 * sin él, vale la que se indicó la última vez.
 */
/*
 * La línea se pega a mano, y con dos terminales abiertos es fácil pegarla en el propio
 * ordenador: allí «sudo» pedía su contraseña y el instalador habría intentado poner el
 * sensor en un Mac. Antes de pedir nada se comprueba que es un Linux. Con «;», «&&» y
 * «||» vale en bash, dash, zsh y fish; la comprobación va dos veces para no meter
 * paréntesis ni llaves, que fish no entiende.
 */
const SOLO_LINUX =
	`uname | grep -qx Linux || echo "Sugardaddy: this line installs the sensor on a Linux machine. Paste it on the sensor machine, not on this computer." >&2; ` +
	'uname | grep -qx Linux && ';

export async function lineaSensorRemoto(
	quien: string,
	sensor: string,
	ip?: string,
	consola?: string
) {
	const ca = await caRaiz();
	const url = direccionConsola();
	const [f] = await db.select().from(s.sensores).where(eq(s.sensores.id, sensor));
	if (!f?.remoto) return null;
	/* Uno retirado no se reinstala desde su fila: se da de alta otra vez, que es lo que lo reactiva. */
	if (f.retirado)
		throw new ErrorCliente(
			'That sensor was removed. To bring it back, enroll it again under "Install a remote sensor" with the same identifier.'
		);
	let consolaIp = f.consolaIp;
	if (consola !== undefined) {
		consolaIp = ipDeConsola(consola, url);
		if (consolaIp !== f.consolaIp)
			await db.update(s.sensores).set({ consolaIp }).where(eq(s.sensores.id, sensor));
	}
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
	/*
	 * Con el acceso limitado, la IP de esa máquina acaba de entrar en la lista y el
	 * cortafuegos del nodo tarda hasta medio minuto en aplicarla (el actualizador
	 * la recoge en su siguiente vuelta): mientras, el puerto rechaza la conexión.
	 * curl reintenta en vez de fallar a quien pega la línea enseguida. El código no
	 * se gasta en esos intentos: no llegan a la consola.
	 */
	const esperar =
		(await leerAcceso()).estado === 'restringida'
			? '--connect-timeout 10 --retry 8 --retry-delay 10 --retry-connrefused '
			: '';
	const curl = `curl -fsSL ${esperar}${resolverConsola(url, consolaIp)}`;
	/*
	 * Con la primera etapa de Cloud (docs/diseno/instalador-verificado.md, «Sensor remoto»):
	 * se descarga, se comprueba su sha256 (el publicado en la documentación) y solo ella
	 * corre como root. Comprueba la versión firmada y el guion del sensor con las claves que
	 * lleva grabadas; la consola solo le da datos.
	 */
	const etapa1 = await etapa1DelNodo();
	if (etapa1) {
		const id = hash(codigo).slice(0, 12);
		const guion = `"$HOME/.sugardaddy-install-${id}.sh"`;
		const fichero = `"$HOME/.sugardaddy-ca-${id}.pem"`;
		const u = new URL(url);
		const fijar = consolaIp ? ` ${u.hostname}:${u.port || '443'}:${consolaIp}` : '';
		const conCa = ca
			? `echo ${Buffer.from(ca).toString('base64')} | base64 -d > ${fichero} && `
			: '';
		const curlCa = ca ? `--cacert ${fichero} ` : '';
		const argCa = ca ? fichero : '-';
		return `${SOLO_LINUX}${conCa}${curl}${curlCa}${url}/instalar-sensor/etapa1.sh -o ${guion} && echo "${etapa1.huella}  "${guion} | sha256sum -c --quiet && sudo bash ${guion} ${url}/instalar-sensor/${codigo} ${argCa}${fijar}; rm -f ${guion}${ca ? ` ${fichero}` : ''}`;
	}
	/* Sin <( ): la línea funciona en cualquier shell (bash, dash, zsh, fish). */
	if (!ca) return `${SOLO_LINUX}${curl}${url}/instalar-sensor/${codigo} | sudo bash`;
	/*
	 * La CA va a un fichero de la carpeta de quien pega la línea, con un nombre que no se
	 * puede adivinar. Antes era /tmp/sugardaddy-ca.pem: otro usuario de la máquina podía
	 * crearlo antes, cambiar la CA entre el echo y el curl y, con un MITM, servir su propio
	 * script, que corre como root.
	 */
	const fichero = `"$HOME/.sugardaddy-ca-${hash(codigo).slice(0, 12)}.pem"`;
	return `${SOLO_LINUX}echo ${Buffer.from(ca).toString('base64')} | base64 -d > ${fichero} && ${curl}--cacert ${fichero} ${url}/instalar-sensor/${codigo} | sudo bash; rm -f ${fichero}`;
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

/*
 * Lo que necesita el instalador de un sensor remoto, ya comprobado: los datos
 * de esta máquina (sin código). El guion (GUION_SENSOR_REMOTO) es el mismo para
 * todos los sensores y viaja firmado en la versión (instaladorSensor,
 * docs/diseno/instalador-verificado.md): la consola solo entrega estos datos.
 */
export type DatosSensorRemoto = {
	sensor: string;
	url: string;
	dominio: string;
	/* La IP de la consola si esa máquina no resuelve su nombre (ipDeConsola); vacía si no. */
	fija: string;
	/* El .env: secretos y ajustes de ese sensor. */
	entorno: string;
	versiones: string;
	compose: string;
	ca: string | null;
	certificado: string | null;
	/* La versión firmada instalada, tal cual: {release, firma, firmas}. */
	firmada: string;
	exigir: boolean;
	version: string;
};

/*
 * Gasta el código y arma los datos (si algo falla, devuelve el código). null si
 * el código no vale.
 */
async function datosSensorRemoto(codigo: string): Promise<DatosSensorRemoto | null> {
	if (!/^[A-Za-z0-9_-]{32}$/.test(codigo)) return null;
	const inst = await gastar(codigo);
	if (!inst) return null;
	let token: string | null,
		certificado: string | null,
		cred: Awaited<ReturnType<typeof credencialSensorRemoto>>,
		descarga: Descarga;
	try {
		cred = await credencialSensorRemoto(inst.sensor);
		/*
		 * La credencial llega del panel sin firma: se vuelve a acotar aquí, donde se usa
		 * (canal.ts ya la comprobó), antes de rotar el token. Ni ella ni nada del .env va
		 * en código de shell.
		 */
		descarga = validarDescarga(cred.descarga);
		comprobarIdSensor(inst.sensor);
		/*
		 * El token sale aquí y solo aquí: va en el script y en la consola queda su hash.
		 * El anterior vale hasta que el sensor llega con este (rotación verificada).
		 */
		token = await prepararToken('installer', inst.sensor);
		if (!token) throw new Error('the sensor no longer exists');
		/*
		 * Su certificado de cliente (docs/diseno/mtls-sensores.md), con la clave hecha
		 * aquí: va en estos datos de un solo uso, como el token. Sin CLAVE_SECRETOS, null:
		 * el sensor entra solo con su token y la consola lo avisa.
		 */
		certificado = await certificadoParaInstalador(inst.sensor);
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
	comprobarConsola(url, dominio);
	/* En qué IP ve esta máquina a la consola, si no resuelve su nombre (ipDeConsola). */
	const [fila] = await db
		.select({ consolaIp: s.sensores.consolaIp, retirado: s.sensores.retirado })
		.from(s.sensores)
		.where(eq(s.sensores.id, inst.sensor));
	if (fila?.retirado)
		throw new ErrorCliente(
			'this sensor was removed from the console. Enroll it again under Sensors to get a new line.'
		);
	const fija = normalizarIp(dominio) ? null : (fila?.consolaIp ?? null);
	const compose = conf.ficheros['compose.yml'];
	/* La resolución fija la aplica el compose del sensor: uno anterior la ignoraría sin decir nada. */
	if (fija && !compose.includes('CONSOLA_FIJA'))
		throw new ErrorCliente(
			`Version ${r.version} of this node cannot pin the console address for a sensor. Update the node.`
		);

	/*
	 * El .env se escribe acabado en salto de línea, y lo que el script le añade después
	 * empieza por otro: sin él, SENSOR_PROPAGACION se pegaba a la última línea, que es la
	 * credencial del registro, y el sensor ya no podía descargar ninguna trampa (401).
	 */
	const entorno = entornoDelSensor([
		`# Generated by the Sugardaddy console. Contains secrets: it does not leave this machine.`,
		`SENSOR_ID=${inst.sensor}`,
		`CONSOLA_URL=${url}`,
		`DATOS=${CARPETA}/datos`,
		`CARPETA=${CARPETA}`,
		`SUGARDADDY_TOKEN=${token}`,
		/*
		 * nombre:IP. Su compose la pone en /etc/hosts del sensor y del actualizador
		 * (extra_hosts) y el actualizador se la da a su auxiliar: sobrevive a
		 * reinicios y a cada versión nueva, que conserva el .env.
		 */
		...(fija ? [`CONSOLA_FIJA=${dominio}:${fija}`] : []),
		...lineasDeClaves(),
		/* Su edición: su actualizador y su sensor solo aceptan versiones de ella. */
		`EDICION=${esCommunity() ? 'community' : 'cloud'}`,
		`REGISTRO=${descarga.registro}`,
		`REGISTRO_USUARIO=${descarga.usuario}`,
		`REGISTRO_TOKEN=${descarga.token}`,
		...lineasDePartner(),
		...Object.entries(conf.entorno?.nuevas ?? {}).map(([k, v]) => `${k}=${v}`),
		...(conf.entorno?.generar ?? []).map((k) => `${k}=${randomBytes(32).toString('hex')}`)
	]);
	/* Con SUGARDADDY_CONFIGURACION: este compose es el firmado de la versión. */
	const versiones = [
		`# Written by the updater after installing a version. Do not edit by hand.`,
		`SUGARDADDY_VERSION=${r.version}`,
		`SENSOR_IMAGEN=${r.servicios.sensor}`,
		`ACTUALIZADOR_IMAGEN=${r.actualizador}`,
		`SUGARDADDY_CONFIGURACION=${r.version}`
	].join('\n');

	await db.update(s.sensores).set({ version: r.version }).where(eq(s.sensores.id, inst.sensor));
	return {
		sensor: inst.sensor,
		url,
		dominio,
		fija: fija ?? '',
		entorno: entorno + '\n',
		versiones,
		compose,
		ca,
		certificado,
		firmada: JSON.stringify(cred.firmada),
		exigir: !!r.catalogo,
		version: r.version
	};
}

/*
 * El guion del sensor remoto, sin ningún dato: lee los de la carpeta $SD_DATOS
 * (sensor, url, dominio, fija, env, versiones.env, compose.yml, ca-consola.crt,
 * cliente.pem, version.json y exigir) y los vuelve a comprobar. Es el mismo
 * texto para todos: despliegue/sensor-remoto/instalar.sh lo lleva tal cual
 * (instalar-sensor-sh.spec.ts lo comprueba) y viaja firmado en cada versión.
 */
export const GUION_SENSOR_REMOTO = `set -Eeuo pipefail
PASO="prepare"
trap 'echo "Sugardaddy: the step \\"$PASO\\" failed. Check the message above; if it does not fix itself, generate another line in Sensors in the console." >&2' ERR
[[ "$(id -u)" == 0 ]] || { echo "This must be run with sudo" >&2; exit 1; }
[[ -d "\${SD_DATOS:-}" ]] || { echo "Sugardaddy: the installer needs the folder with this sensor's data" >&2; exit 1; }
# Los datos que da la consola, comprobados uno a uno: ninguno se evalúa.
sd_dato() { tr -d '\\n' < "$SD_DATOS/$1"; }
SD_SENSOR="$(sd_dato sensor)"
SD_URL="$(sd_dato url)"
SD_DOMINIO="$(sd_dato dominio)"
SD_FIJA="$(sd_dato fija 2>/dev/null || true)"
[[ $SD_SENSOR =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { echo "Sugardaddy: malformed sensor identifier" >&2; exit 1; }
[[ $SD_URL =~ ^https://[][A-Za-z0-9._:-]+(/[A-Za-z0-9._~/-]*)?$ ]] || { echo "Sugardaddy: malformed console address" >&2; exit 1; }
[[ $SD_DOMINIO =~ ^[A-Za-z0-9._-]+$|^\\[[0-9a-fA-F:.]+\\]$ ]] || { echo "Sugardaddy: malformed console name" >&2; exit 1; }
[[ -z $SD_FIJA || $SD_FIJA =~ ^[0-9a-fA-F:.]+$ ]] || { echo "Sugardaddy: malformed console IP address" >&2; exit 1; }
SD_RESOLVER=()
if [[ -n $SD_FIJA ]]; then
	SD_PUERTO=443
	[[ $SD_URL =~ ^https://[^/]*[^]]:([0-9]{1,5})(/|$) ]] && SD_PUERTO="\${BASH_REMATCH[1]}"
	SD_RESOLVER=(--resolve "$SD_DOMINIO:$SD_PUERTO:$SD_FIJA")
fi
echo "==> Installing Sugardaddy sensor $SD_SENSOR"
${POLITICA_SH}
# El suelo de la política de cambios: sudo ACTUALIZACION_RETARDO_HORAS=72 bash (y las otras dos).
sd_politica_comprobar
${comprobarArquitectura('this sensor', LINEA_GASTADA)}
DIR=${CARPETA}
${PROXY_SH}
# Detrás de un proxy: sudo SUGARDADDY_PROXY=http://proxy:3128 bash (y SUGARDADDY_PROXY_CA, la
# CA de un proxy que inspecciona TLS). La consola nunca pasa por él.
PASO="set up the outbound proxy"
mkdir -p "$DIR"
sd_proxy_preparar "$DIR" "$SD_DOMINIO" \${SD_FIJA:+"$SD_FIJA"}
sd_proxy_sistema "$DIR"
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
sd_proxy_docker
PASO="check the console"
# Con la IP de la consola indicada al dar de alta el sensor, esta máquina no tiene que resolver su nombre.
if [[ -z $SD_FIJA ]]; then
	getent hosts "$SD_DOMINIO" >/dev/null || { echo "Sugardaddy: this machine cannot resolve $SD_DOMINIO. In Sensors in the console, generate a new line and fill in 'Address of this console as seen from that machine' with the IP address this machine reaches the console at." >&2; exit 1; }
fi
PASO="prepare the folder"
mkdir -p "$DIR/datos"
chmod 700 "$DIR/datos"
umask 077
# Al reinstalar, el suelo de la política de cambios que ya tenía la máquina se queda.
SD_POLITICA_ANTES="$(grep -E '^ACTUALIZACION_(POLITICA|RETARDO_HORAS|VENTANA)=' "$DIR/.env" 2>/dev/null || true)"
cp "$SD_DATOS/env" "$DIR/.env"
[[ -z "$SD_POLITICA_ANTES" ]] || printf '%s\n' "$SD_POLITICA_ANTES" >> "$DIR/.env"
sd_politica_env "$DIR/.env"
umask 022
cp "$SD_DATOS/versiones.env" "$DIR/versiones.env"
cp "$SD_DATOS/compose.yml" "$DIR/compose.yml"
# La raíz de la consola la lee el sensor (usuario 65532): 0644 siempre. Con cp conservaba el
# 0600 de los datos (escritos con umask 077) y el sensor no arrancaba.
if [[ -s "$SD_DATOS/ca-consola.crt" ]]; then install -m 0644 "$SD_DATOS/ca-consola.crt" "$DIR/ca-consola.crt"; else install -m 0644 /dev/null "$DIR/ca-consola.crt"; fi
# El certificado de cliente del sensor y su clave (mTLS con la consola). Lo leen el sensor
# (usuario 65532) y el actualizador (root, grupo 0); nadie más en esta máquina.
install -d -m 0711 "$DIR/tls"
if [[ -s "$SD_DATOS/cliente.pem" ]]; then
	install -m 0640 -o 65532 -g 0 "$SD_DATOS/cliente.pem" "$DIR/tls/cliente.pem.nuevo"
	mv -f "$DIR/tls/cliente.pem.nuevo" "$DIR/tls/cliente.pem"
fi
# La versión firmada de la que se instala: su catálogo es lo único que este sensor arranca.
# Legible para el sensor (uid 65532) aunque el instalador corra con umask 077, como en el nodo.
mkdir -p "$DIR/firmado"
chmod 755 "$DIR/firmado"
install -m 0644 "$SD_DATOS/version.json" "$DIR/firmado/version.json"
if [[ -e "$SD_DATOS/exigir" ]]; then
	echo 1 > "$DIR/firmado/exigir"
	chmod 644 "$DIR/firmado/exigir"
fi
cd "$DIR"
sd_proxy_env .env
sd_proxy_guion "$DIR"
PASO="download the images"
# Solo con credencial: un registro sin contraseña (el de desarrollo del panel, REGISTRO_DESARROLLO)
# la da vacía, y docker login fallaba con «username is empty». Igual que instalar.sh del nodo.
# El registro y el usuario salen del .env, nunca del texto del script: los da el panel sin firma.
if grep -q '^REGISTRO_TOKEN=.' .env; then
	grep '^REGISTRO_TOKEN=' .env | cut -d= -f2- | docker login "$(grep '^REGISTRO=' .env | cut -d= -f2-)" -u "$(grep '^REGISTRO_USUARIO=' .env | cut -d= -f2-)" --password-stdin >/dev/null
fi
# Los discos de las trampas (docs/diseno/discos-trampa.md): el sensor los ve si su carpeta le
# llega con propagación. Solo si la máquina la admite; si no (un contenedor LXC con la raíz
# privada), Docker no arrancaría el sensor con ella.
PASO="check mount propagation"
if docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \\
	--mount "type=bind,source=$DIR/datos,target=/sd,readonly,bind-propagation=rslave" \\
	"$(grep '^SENSOR_IMAGEN=' versiones.env | cut -d= -f2-)" version >/dev/null 2>&1; then
	printf '\\nSENSOR_PROPAGACION=rslave\\n' >> .env
fi
# El aislamiento de las trampas (docs/diseno/aislamiento-trampas.md), como en el nodo: el
# perfil AppArmor y sd-discos. Lo que la máquina no admite se queda sin ello y la consola lo
# dice; cada versión lo vuelve a poner (auxiliar «aislar-anfitrion»).
PASO="isolate the decoys"
${AISLAMIENTO_SH}
sd_aislar_trampas "$DIR/.env" "$DIR/datos" "$(grep '^SENSOR_IMAGEN=' versiones.env | cut -d= -f2-)"
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
	SD_TLS=()
	[[ -s ca-consola.crt ]] && SD_TLS+=(--cacert ca-consola.crt)
	[[ -s tls/cliente.pem ]] && SD_TLS+=(--cert tls/cliente.pem)
	printf 'Authorization: Bearer %s\\n' "$(grep '^SUGARDADDY_TOKEN=' .env | cut -d= -f2-)" | curl -fsS "\${SD_RESOLVER[@]}" "\${SD_TLS[@]}" -H @- -H 'Content-Type: application/json' -d "{\\"red\\":\\"$RED_DETECTADA\\",\\"vlan\\":\\"$VLAN_DETECTADA\\"}" "$SD_URL/api/sensor/red" >/dev/null || echo "Sugardaddy: could not report its network to the console; enter it in Sensors."
fi
echo "Sensor $SD_SENSOR is running. It shows as online in Sensors in the console within a minute."
echo "Open the ports of the honeypots you deploy on it in this machine's firewall."
`;

/* despliegue/sensor-remoto/instalar.sh: el guion tal cual, con la carpeta de datos como argumento. */
export const INSTALAR_SENSOR_SH = `#!/usr/bin/env bash
# Installer for a Sugardaddy sensor on another machine. The same file for every
# sensor: it is signed with each release (instaladorSensor) and run by the
# verified first stage, which passes the folder with this sensor's data.
# Generated from apps/consola/src/lib/server/sensores-remotos.ts: do not edit by hand.
SD_DATOS="\${1:-}"
${GUION_SENSOR_REMOTO}`;

/* Los ficheros de la carpeta de datos, con su contenido. */
export function ficherosDatosSensor(d: DatosSensorRemoto): Record<string, string> {
	return {
		sensor: d.sensor,
		url: d.url,
		dominio: d.dominio,
		fija: d.fija,
		env: d.entorno,
		'versiones.env': d.versiones,
		'compose.yml': d.compose,
		'ca-consola.crt': d.ca ?? '',
		...(d.certificado ? { 'cliente.pem': d.certificado } : {}),
		'version.json': d.firmada,
		...(d.exigir ? { exigir: '1' } : {})
	};
}

/*
 * El guion de `curl … | sudo bash` (la línea de siempre y Community): los datos
 * van en base64 a una carpeta temporal y detrás el mismo guion que el firmado.
 */
export async function scriptSensorRemoto(codigo: string) {
	const d = await datosSensorRemoto(codigo);
	if (!d) return null;
	const ficheros = Object.entries(ficherosDatosSensor(d))
		.map(([n, v]) => `echo '${b64(v)}' | base64 -d > "$SD_DATOS/${n}"`)
		.join('\n');
	return `#!/usr/bin/env bash
# Installer for a Sugardaddy sensor (${d.sensor}), generated by the console.
set -Eeuo pipefail
[[ "$(id -u)" == 0 ]] || { echo "This must be run with sudo" >&2; exit 1; }
SD_DATOS="$(mktemp -d)"
trap 'rm -rf "$SD_DATOS"' EXIT
chmod 700 "$SD_DATOS"
umask 077
${ficheros}
umask 022
${GUION_SENSOR_REMOTO}`;
}

/*
 * Para la primera etapa verificada (etapa1.sh --sensor): los datos como
 * registros «dato <nombre> <base64>», sin una línea de código. Gasta el código.
 */
export async function registrosDatosSensor(codigo: string): Promise<string | null> {
	const d = await datosSensorRemoto(codigo);
	if (!d) return null;
	return Object.entries(ficherosDatosSensor(d))
		.map(([n, v]) => `dato ${n} ${b64(v)}\n`)
		.join('');
}

/* ---------- la línea verificada (docs/diseno/instalador-verificado.md, «Sensor remoto») ---------- */

/*
 * La primera etapa del instalador de Cloud de la versión del nodo, si esa versión
 * trae también el guion firmado del sensor: con ella, la línea de un sensor remoto
 * no ejecuta nada de la consola. null en Community (su versión no lleva primera
 * etapa) o si no se puede saber: entonces, la línea de siempre.
 */
export async function etapa1DelNodo(): Promise<{ texto: string; huella: string } | null> {
	if (esCommunity()) return null;
	try {
		const { release } = await releaseCompletaDelNodo();
		const texto = release.instalador?.etapa1?.texto;
		if (!texto || !piezasInstaladorSensor(release)) return null;
		return { texto, huella: hash(texto) };
	} catch {
		return null;
	}
}

const registro = (tipo: string, ...campos: string[]) => `${tipo} ${campos.join(' ')}\n`;
export const errorEtapa1 = (mensaje: string, sigue = false) =>
	`sugardaddy-error ${sigue ? 'sigue' : 'fin'} ${b64(mensaje)}\n`;

/*
 * Lo que pide la primera etapa antes de gastar nada (GET …/datos): la versión firmada
 * del nodo tal cual, sus firmas y las piezas que comprueba contra ella. Sin datos del
 * sensor ni secretos. null si el código no vale (sin gastarlo).
 */
export async function versionParaEtapa1(codigo: string): Promise<string | null> {
	if (!/^[A-Za-z0-9_-]{32}$/.test(codigo)) return null;
	const [f] = await db
		.select({ sensor: s.instaladoresSensor.sensor })
		.from(s.instaladoresSensor)
		.where(
			and(
				eq(s.instaladoresSensor.codigoHash, hash(codigo)),
				isNull(s.instaladoresSensor.usado),
				gt(s.instaladoresSensor.caduca, new Date())
			)
		);
	if (!f) return null;
	const { firmada, release } = await releaseCompletaDelNodo();
	const nodo = piezasInstalador(release);
	const sensor = piezasInstaladorSensor(release);
	if (!nodo || !sensor)
		throw new ErrorCliente(
			`Version ${release.version} of this node cannot install verified sensors. Update the node, or generate the line again.`
		);
	return [
		'sugardaddy-version 1\n',
		registro('release', b64(firmada.release)),
		...(firmada.firma ? [registro('firma', firmada.firma)] : []),
		...(firmada.firmas ?? []).map((x) => registro('firmas', x.clave, x.firma)),
		registro('fichero', 'imagenes.env', b64(nodo['imagenes.env'])),
		registro('fichero', 'entorno.txt', b64(nodo['entorno.txt'])),
		registro('fichero', 'sensor-instalar.sh', b64(sensor['instalar.sh'])),
		registro('fichero', 'sensor-compose.yml', b64(sensor['compose.yml']))
	].join('');
}

/* Los nombres del .env que la primera etapa recibe como datos; el resto lo pone ella. */
const DATOS_ETAPA1: Record<string, string> = {
	SENSOR_ID: 'SENSOR',
	SUGARDADDY_TOKEN: 'TOKEN',
	REGISTRO: 'REGISTRO',
	REGISTRO_USUARIO: 'REGISTRO_USUARIO',
	REGISTRO_TOKEN: 'REGISTRO_TOKEN',
	PARTNER: 'PARTNER',
	REGISTRO_PARTNER: 'REGISTRO_PARTNER',
	REGISTRO_PARTNER_USUARIO: 'REGISTRO_PARTNER_USUARIO',
	REGISTRO_PARTNER_TOKEN: 'REGISTRO_PARTNER_TOKEN'
};

/*
 * Los datos del sensor para la primera etapa (POST …/datos), como registros: los de
 * una línea en «dato», la CA de la consola y el certificado de cliente en «archivo».
 * Gasta el código. null si no vale.
 */
export async function datosParaEtapa1(codigo: string): Promise<string | null> {
	const d = await datosSensorRemoto(codigo);
	if (!d) return null;
	const datos: string[] = ['sugardaddy-datos 1\n'];
	for (const l of d.entorno.split('\n')) {
		const i = l.indexOf('=');
		const nombre = DATOS_ETAPA1[l.slice(0, i)];
		if (i > 0 && nombre) datos.push(registro('dato', nombre, b64(l.slice(i + 1))));
	}
	datos.push(registro('dato', 'FIJA', b64(d.fija)));
	if (d.ca) datos.push(registro('archivo', 'ca', b64(d.ca)));
	if (d.certificado) datos.push(registro('archivo', 'cliente', b64(d.certificado)));
	return datos.join('');
}
