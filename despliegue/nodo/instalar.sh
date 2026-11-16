#!/usr/bin/env bash
#
# Instala un nodo de Sugardaddy en esta máquina.
#
#   despliegue/nodo/instalar.sh /opt/sugardaddy nodo-mad01 "Grupo Aldanza" gestion.aldanza.local
#
# HTTPS: por defecto con una CA propia del nodo, cuya raíz solo vale para la
# dirección de la consola (docs/diseno/ca-nodo.md); se deja en
# <carpeta>/ca-raiz.crt para instalarla en los equipos. Un nodo instalado antes
# que ella sigue con la CA de Caddy hasta que el administrador pasa a la propia
# desde la consola. Con TLS_MODO=ficheros se usa el certificado del cliente,
# que hay que dejar antes en <carpeta>/certs/certificado.pem y clave.pem.
#
# Las imágenes se toman de imagenes.env (al lado de este script): las de una
# versión firmada, siempre por digest. Genera los secretos del nodo una sola
# vez; si ya hay un .env, lo respeta y solo vuelve a arrancar.
#
# Normalmente no se llama a mano: lo llama el instalador que genera el panel
# (curl …/instalar/<código> | sudo bash), que le pasa por entorno el registro
# y su credencial, la configuración de Entra y el código de alta en el panel.
#
# Sin argumentos y delante de una terminal abre el asistente (asistente.sh), que
# comprueba la máquina, pregunta esos cuatro datos y vuelve a llamar aquí.
set -Eeuo pipefail
if [[ $# -eq 0 && -t 0 && -t 1 && -f "$(dirname "$0")/asistente.sh" ]]; then
	exec bash "$(dirname "$0")/asistente.sh"
fi
# Si algo falla, se dice en qué paso: quien instala no tiene a nadie al lado.
PASO="prepare"
trap 'echo "Sugardaddy: the step \"$PASO\" failed. Check the message above and run the line again; if it does not fix itself, tell whoever gave you this line." >&2' ERR

# Proxy de salida y CA corporativa: el mismo bloque que apps/consola/src/lib/server/proxy.sh
# (lo comprueba proxy-sh.spec.ts), que usa también el instalador del sensor remoto.
# --- proxy de salida (docs/diseno/proxy-salida.md) ---
SD_PROXY="" SD_NO_PROXY="" SD_PROXY_CLIENTE="" SD_PROXY_CA="" SD_PROXY_CAMBIO=""
sd_proxy_de_env() { # carpeta clave
	[[ -f "$1/.env" ]] && grep "^$2=" "$1/.env" | head -1 | cut -d= -f2- || true
}
sd_proxy_preparar() { # carpeta excepciones-propias…
	local dir="$1" x pem forma='^https?://([A-Za-z0-9._~%!*+,;=:-]+@)?[A-Za-z0-9.-]+(:[0-9]{1,5})?$'
	shift
	SD_PROXY="${SUGARDADDY_PROXY:-${HTTPS_PROXY:-${https_proxy:-$(sd_proxy_de_env "$dir" PROXY_SALIDA)}}}"
	[[ "$SD_PROXY" == none ]] && SD_PROXY=""
	SD_PROXY="${SD_PROXY%/}"
	if [[ -n "$SD_PROXY" && ! "$SD_PROXY" =~ $forma ]]; then
		echo "Sugardaddy: the proxy must look like http://proxy.example.com:3128 or http://user:password@proxy.example.com:3128, with any special character of the user or the password percent-encoded (\$ as %24, @ as %40). (code proxy.forma)" >&2
		return 1
	fi
	SD_PROXY_CLIENTE="${SUGARDADDY_NO_PROXY:-${NO_PROXY:-${no_proxy:-$(sd_proxy_de_env "$dir" PROXY_EXCEPCIONES_CLIENTE)}}}"
	[[ "$SD_PROXY_CLIENTE" == none ]] && SD_PROXY_CLIENTE=""
	SD_PROXY_CLIENTE="$(printf '%s' "$SD_PROXY_CLIENTE" | tr ' ;' ',,' | tr -cd 'A-Za-z0-9.,:/*_-' | tr -s ',' | sed -e 's/^,//' -e 's/,$//')"
	SD_NO_PROXY="localhost,127.0.0.1,::1,consola,postgres,https,sensor,actualizador"
	for x in "$@" "$SD_PROXY_CLIENTE"; do [[ -n "$x" ]] && SD_NO_PROXY+=",$x"; done
	mkdir -p "$dir/proxy"
	chmod 755 "$dir/proxy"
	if [[ "${SUGARDADDY_PROXY_CA:-}" == none ]]; then
		rm -f "$dir/proxy/ca.crt"
	elif [[ -n "${SUGARDADDY_PROXY_CA:-}" ]]; then
		# Solo certificados, todos los del fichero (raíz e intermedias), sin nada más.
		pem="$(openssl crl2pkcs7 -nocrl -certfile "$SUGARDADDY_PROXY_CA" 2>/dev/null | openssl pkcs7 -print_certs 2>/dev/null | sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p')"
		if [[ -z "$pem" ]]; then
			echo "Sugardaddy: $SUGARDADDY_PROXY_CA is not a PEM certificate. Give the proxy CA (the root your company installs on its computers) in PEM form. (code proxy.ca)" >&2
			return 1
		fi
		[[ "$(cat "$dir/proxy/ca.crt" 2>/dev/null)" == "$pem" ]] || SD_PROXY_CAMBIO=1
		printf '%s\n' "$pem" > "$dir/proxy/ca.crt.tmp"
		chmod 644 "$dir/proxy/ca.crt.tmp"
		mv "$dir/proxy/ca.crt.tmp" "$dir/proxy/ca.crt"
	fi
	SD_PROXY_CA=""
	[[ -s "$dir/proxy/ca.crt" ]] && SD_PROXY_CA=1
	if [[ -n "$SD_PROXY" ]]; then
		export http_proxy="$SD_PROXY" https_proxy="$SD_PROXY" HTTP_PROXY="$SD_PROXY" HTTPS_PROXY="$SD_PROXY"
		export no_proxy="$SD_NO_PROXY" NO_PROXY="$SD_NO_PROXY"
		echo "==> Outbound proxy: $(printf '%s' "$SD_PROXY" | sed -E 's#//[^@]*@#//***@#')"
	else
		unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY
	fi
}
sd_proxy_sistema() { # carpeta: apt y el almacén de CA del sistema
	local dir="$1" ancla="" orden=""
	if [[ -d /etc/apt/apt.conf.d ]]; then
		if [[ -n "$SD_PROXY" ]]; then
			printf 'Acquire::http::Proxy "%s";\nAcquire::https::Proxy "%s";\n' "$SD_PROXY" "$SD_PROXY" > /etc/apt/apt.conf.d/95sugardaddy-proxy
			chmod 600 /etc/apt/apt.conf.d/95sugardaddy-proxy
		else
			rm -f /etc/apt/apt.conf.d/95sugardaddy-proxy
		fi
	fi
	if [[ -d /usr/local/share/ca-certificates ]] && command -v update-ca-certificates >/dev/null; then
		ancla=/usr/local/share/ca-certificates/sugardaddy-proxy.crt orden="update-ca-certificates"
	elif [[ -d /etc/pki/ca-trust/source/anchors ]] && command -v update-ca-trust >/dev/null; then
		ancla=/etc/pki/ca-trust/source/anchors/sugardaddy-proxy.crt orden="update-ca-trust"
	fi
	[[ -n "$ancla" ]] || { [[ -z "$SD_PROXY_CA" ]] || echo "Sugardaddy: this system has no CA store this installer knows; add $dir/proxy/ca.crt to it by hand." >&2; return 0; }
	if [[ -n "$SD_PROXY_CA" ]]; then
		cmp -s "$dir/proxy/ca.crt" "$ancla" || { install -m 644 "$dir/proxy/ca.crt" "$ancla" && $orden >/dev/null 2>&1 && SD_PROXY_CAMBIO=1; }
	elif [[ -f "$ancla" ]]; then
		rm -f "$ancla" && $orden >/dev/null 2>&1 && SD_PROXY_CAMBIO=1
	fi
	return 0
}
sd_proxy_docker() { # el motor de Docker descarga las imágenes: necesita el proxy y relee la CA al arrancar
	local f=/etc/systemd/system/docker.service.d/sugardaddy-proxy.conf nuevo=""
	command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] || {
		[[ -z "$SD_PROXY" ]] || echo "Sugardaddy: this machine does not run systemd: set the proxy for the Docker engine by hand (docs: outbound proxy)." >&2
		return 0
	}
	if [[ -n "$SD_PROXY" ]]; then
		nuevo="$(printf '[Service]\nEnvironment="HTTP_PROXY=%s" "HTTPS_PROXY=%s" "NO_PROXY=%s"\n' "${SD_PROXY//%/%%}" "${SD_PROXY//%/%%}" "$SD_NO_PROXY")"
	fi
	if [[ "$(cat "$f" 2>/dev/null)" != "$nuevo" ]]; then
		if [[ -n "$nuevo" ]]; then
			mkdir -p "${f%/*}" && (umask 077 && printf '%s\n' "$nuevo" > "$f")
		else
			rm -f "$f"
		fi
		SD_PROXY_CAMBIO=1
	fi
	if [[ -n "$SD_PROXY_CAMBIO" ]] && systemctl cat docker.service >/dev/null 2>&1; then
		echo "==> Restarting Docker with the proxy settings"
		systemctl daemon-reload
		# En una máquina lenta el motor anterior tarda en soltar su pid y el arranque falla
		# («process … is still running»): se reintenta hasta un par de minutos. Si systemd
		# ya lo da por parado y su dockerd sigue vivo fuera de la unidad (visto en máquinas
		# emuladas), nada lo va a parar: se le pide que acabe y, si no, se le corta.
		local i viejo
		for i in $(seq 1 24); do
			systemctl restart docker 2>/dev/null && docker info >/dev/null 2>&1 && break
			viejo="$(cat /var/run/docker.pid 2>/dev/null || true)"
			if [[ "$viejo" =~ ^[0-9]+$ ]] && ! systemctl is-active -q docker \
				&& [[ "$(cat "/proc/$viejo/comm" 2>/dev/null)" == dockerd ]]; then
				kill -TERM "$viejo" 2>/dev/null || true
				sleep 20
				kill -0 "$viejo" 2>/dev/null && kill -KILL "$viejo" 2>/dev/null || true
			fi
			sleep 5
			systemctl reset-failed docker 2>/dev/null || true
		done
		docker info >/dev/null 2>&1 || { echo "Sugardaddy: Docker did not start again with the proxy settings: check «journalctl -u docker». (code proxy.docker)" >&2; return 1; }
		SD_PROXY_CAMBIO=""
	fi
	return 0
}
sd_proxy_env() { # fichero .env
	local k v
	for k in PROXY_SALIDA PROXY_EXCEPCIONES PROXY_EXCEPCIONES_CLIENTE PROXY_CA; do
		case $k in
			PROXY_SALIDA) v="$SD_PROXY" ;;
			PROXY_EXCEPCIONES) v="" && [[ -z "$SD_PROXY" ]] || v="$SD_NO_PROXY" ;;
			PROXY_EXCEPCIONES_CLIENTE) v="$SD_PROXY_CLIENTE" ;;
			PROXY_CA) v="$SD_PROXY_CA" ;;
		esac
		{ grep -v "^$k=" "$1" || true; echo "$k=$v"; } > "$1.tmp"
		chmod 600 "$1.tmp" && mv "$1.tmp" "$1"
	done
}
# Deja en la carpeta un proxy.sh para cambiar o quitar el proxy después, sin la línea de
# instalación (que es de un solo uso): sudo SUGARDADDY_PROXY=… <carpeta>/proxy.sh
sd_proxy_guion() { # carpeta
	{
		echo '#!/usr/bin/env bash'
		echo '# Cambia el proxy de salida de este nodo o sensor (docs: outbound proxy). Lo escribe su instalador.'
		echo '#   sudo SUGARDADDY_PROXY=http://[user:password@]proxy:3128 [SUGARDADDY_NO_PROXY=…] [SUGARDADDY_PROXY_CA=ca.pem] ./proxy.sh'
		echo '#   sudo SUGARDADDY_PROXY=none ./proxy.sh'
		echo 'set -Eeuo pipefail'
		echo 'SD_PROXY="" SD_NO_PROXY="" SD_PROXY_CLIENTE="" SD_PROXY_CA="" SD_PROXY_CAMBIO=""'
		declare -f sd_proxy_de_env sd_proxy_preparar sd_proxy_sistema sd_proxy_docker sd_proxy_env
		cat <<'FIN'
[[ "$(id -u)" == 0 ]] || { echo "Run it with sudo" >&2; exit 1; }
[[ -n "${SUGARDADDY_PROXY:-}${SUGARDADDY_NO_PROXY:-}${SUGARDADDY_PROXY_CA:-}" ]] || { sed -n '3,4p' "$0" | cut -c3- >&2; exit 1; }
DIR="$(cd "$(dirname "$0")" && pwd)"
url="$(sd_proxy_de_env "$DIR" CONSOLA_URL)" url="${url#*://}"
fija="$(sd_proxy_de_env "$DIR" CONSOLA_FIJA)"
sd_proxy_preparar "$DIR" "$(sd_proxy_de_env "$DIR" CONSOLA_DOMINIO)" "${url%%[:/]*}" "${fija#*:}" "$(sd_proxy_de_env "$DIR" SENSOR_LOCAL_RED)"
sd_proxy_sistema "$DIR"
sd_proxy_docker
sd_proxy_env "$DIR/.env"
cd "$DIR" && docker compose --env-file .env --env-file versiones.env up -d --wait >/dev/null
echo "Done: the outbound proxy is applied."
FIN
	} > "$1/proxy.sh.tmp"
	chmod 700 "$1/proxy.sh.tmp" && mv "$1/proxy.sh.tmp" "$1/proxy.sh"
}
# --- fin del proxy de salida ---

instalar_docker() {
	# Docker desde su repositorio oficial, en Ubuntu o Debian.
	command -v apt-get >/dev/null || { echo "Docker is required (automatic installation only on Ubuntu and Debian)"; exit 1; }
	echo "==> Installing Docker"
	. /etc/os-release
	apt-get update -qq && apt-get install -y -qq ca-certificates curl >/dev/null
	install -m 0755 -d /etc/apt/keyrings
	curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
	apt-get update -qq && apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
}
# Solo Docker: lo pide el asistente cuando hay que construir las imágenes antes de instalar.
if [[ "${1:-}" == --instalar-docker ]]; then
	[[ "$(id -u)" == 0 ]] || { echo "This must be run as root (sudo)"; exit 1; }
	# La arquitectura ya la ha mirado el asistente, que es quien llama así.
	PASO="install only Docker"
	sd_proxy_preparar "$(mktemp -d)"
	sd_proxy_sistema /nonexistent
	command -v docker >/dev/null || instalar_docker
	sd_proxy_docker
	exit 0
fi

DIR="${1:?Usage: instalar.sh <folder> <node-id> \"Customer name\" <console-url>}"
NODO_ID="${2:?The node id is missing (e.g. nodo-mad01)}"
NOMBRE="${3:?The customer name is missing}"
DOMINIO="${4:?The name used to reach the console is missing (e.g. gestion.aldanza.local)}"
TLS_MODO="${TLS_MODO:-interno}"
PUERTO="${CONSOLA_PUERTO:-443}"
URL="https://$DOMINIO$([[ $PUERTO == 443 ]] || echo ":$PUERTO")"
AQUI="$(cd "$(dirname "$0")" && pwd)"

[[ "$NODO_ID" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "Invalid node id: $NODO_ID"; exit 1; }
[[ "$DOMINIO" =~ ^[a-z0-9.-]+$ ]] || { echo "Invalid name: $DOMINIO"; exit 1; }
[[ "$TLS_MODO" == interno || "$TLS_MODO" == ficheros ]] || { echo "TLS_MODO must be interno or ficheros"; exit 1; }
[[ "$(id -u)" == 0 ]] || { echo "This must be run as root (sudo)"; exit 1; }
PASO="check the architecture"
# Las imágenes de Sugardaddy solo se publican para Linux amd64 (x86_64). En
# otro motor (arm64: Graviton, Ampere, Raspberry Pi o un Mac con Apple
# Silicon) sus contenedores no arrancan y se reinician sin fin con «exec
# format error». Se mira antes de escribir nada y en el motor, no con uname:
# con Docker Desktop o un motor remoto, la máquina no es la que cuenta. Sin
# Docker, la arquitectura de los paquetes que se instalarían. Si el motor no
# contesta, aquí no se decide: lo dirá el paso que lo necesite. La línea del
# panel ya se gastó al descargar este script: el texto dice qué hacer para la
# otra máquina, o quien instala pegaría la misma y le diría «ya se usó».
plataforma=""
if command -v docker >/dev/null; then
	plataforma="$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}' 2>/dev/null || true)"
elif command -v dpkg >/dev/null; then
	plataforma="linux/$(dpkg --print-architecture 2>/dev/null || true)"
fi
if [[ "$plataforma" =~ ^[a-z0-9]+/[a-z0-9_]+$ && "$plataforma" != linux/amd64 ]]; then
	echo "Sugardaddy: this node needs a Linux amd64 (x86_64) Docker engine, and this machine has $plataforma, where its containers would not start. Install it on an x86_64 machine or VM. Nothing was changed on this one, but this line has already been used: for the other machine, ask whoever gave it to you for a new one. (code instalar.arquitectura)" >&2
	exit 1
fi
# Antes de escribir nada: sin las imágenes de la versión no hay nada que instalar.
[[ -f "$AQUI/imagenes.env" ]] || { echo "$AQUI/imagenes.env is missing; it holds the images of the version"; exit 1; }
# La red de esta máquina (la de la interfaz por la que sale, p. ej.
# 10.70.0.0/24) y su VLAN si esa interfaz es una 802.1Q: la consola las pone
# al sensor local si aún no tiene. En cada instalación se vuelven a mirar; lo
# que alguien haya escrito en Sensores no se toca. Si no se saben, vacías.
# Mismo texto que detectarRed (apps/consola/src/lib/server/red-sh.ts).
interfaz="$(ip -4 route show default 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}' || true)"
RED_DETECTADA="" VLAN_DETECTADA=""
if [[ -n "$interfaz" ]]; then
	RED_DETECTADA="$(ip -4 route show dev "$interfaz" proto kernel scope link 2>/dev/null | awk '$1 ~ /\// { print $1; exit }' || true)"
	VLAN_DETECTADA="$(ip -d -o link show dev "$interfaz" 2>/dev/null | grep -o 'vlan protocol 802.1Q id [0-9]*' | awk '{ print $NF }' || true)"
fi
# Detrás de un proxy (un banco, una administración) nada sale directo: apt, Docker, la
# consola y el sensor salen por él. Va antes de instalar Docker, que ya lo necesita.
# La red del nodo y la dirección de la consola nunca pasan por el proxy.
PASO="set up the outbound proxy"
mkdir -p "$DIR"
sd_proxy_preparar "$DIR" "$DOMINIO" "$RED_DETECTADA"
sd_proxy_sistema "$DIR"
PASO="install Docker"
command -v docker >/dev/null || instalar_docker
sd_proxy_docker

mkdir -p "$DIR/datos/sensor" "$DIR/certs"
# Lo capturado (contraseñas y comandos del atacante, credenciales cebo) y los
# registros que lee el sensor: ningún otro usuario de la máquina entra ni los
# toca. Los contenedores no lo notan: Docker monta como root.
chmod 700 "$DIR/datos"
DIR="$(cd "$DIR" && pwd)"
cp "$AQUI/compose.yml" "$AQUI/Caddyfile" "$AQUI/copia.sh" "$AQUI/restaurar.sh" "$DIR/"
if [[ "$TLS_MODO" == ficheros && ! -f "$DIR/certs/certificado.pem" ]]; then
	echo "With TLS_MODO=ficheros, put the certificate in $DIR/certs/certificado.pem and clave.pem first"
	exit 1
fi
# versiones.env lleva lo que cambian las versiones (consola, sensor y, desde
# la 0.12, el propio actualizador) y lo reescribe el actualizador. Con
# SUGARDADDY_CONFIGURACION se apunta que este compose es el firmado de esa
# versión (lo pone el instalador del panel cuando lo es).
#
# Reinstalar encima: el compose de arriba es el de este instalador, así que
# las imágenes también (las de un nodo 0.11 no arrancan con él). Nunca hacia
# atrás: si el nodo ya tiene una versión más nueva, no se toca.
PASO="prepare the folder"
echo "==> Preparing $DIR"
nueva="$(grep '^SUGARDADDY_VERSION=' "$AQUI/imagenes.env" | cut -d= -f2- || true)"
# Guard anti-retroceso: solo frena entre versiones SEMVER LIMPIAS (X.Y.Z). Si la
# instalada es un build de desarrollo (p. ej. 9.9.9-local) no cuenta como «más
# nueva» y no debe bloquear una (re)instalación: esas no pasan por el panel.
semver='^[0-9]+\.[0-9]+\.[0-9]+$'
if [[ -f "$DIR/versiones.env" ]]; then
	actual="$(grep '^SUGARDADDY_VERSION=' "$DIR/versiones.env" | cut -d= -f2- || true)"
	if [[ "$actual" =~ $semver && "$nueva" =~ $semver && "$actual" != "$nueva" && "$(printf '%s\n' "$actual" "$nueva" | sort -V | tail -1)" == "$actual" ]]; then
		echo "This node already has version $actual, which is newer than this installer ($nueva). Ask whoever gave you this line for a new one."
		exit 1
	fi
fi
grep -E '^(SUGARDADDY_VERSION|CONSOLA_IMAGEN|SENSOR_IMAGEN|ACTUALIZADOR_IMAGEN)=' "$AQUI/imagenes.env" > "$DIR/versiones.env.tmp"
[[ -n "${SUGARDADDY_CONFIGURACION:-}" ]] && echo "SUGARDADDY_CONFIGURACION=$SUGARDADDY_CONFIGURACION" >> "$DIR/versiones.env.tmp"
mv "$DIR/versiones.env.tmp" "$DIR/versiones.env"

secreto() { openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48; }
# Acceso a la consola por IP (docs/diseno/acceso-consola.md): la IP de la sesión
# SSH desde la que se instala, como propuesta para la primera entrada. sudo
# borra SSH_CLIENT del entorno, así que se busca en los procesos de los que
# cuelga este (root puede leer su entorno). Instalando en local, no hay.
ip_ssh() {
	local pid=$$ ip
	for _ in 1 2 3 4 5 6 7 8; do
		pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
		[[ -n "$pid" && "$pid" -gt 1 ]] || return 0
		ip="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^SSH_CLIENT=\([^ ]*\).*/\1/p' | head -1)"
		[[ -n "$ip" ]] && { echo "$ip"; return 0; }
	done
}
ENV_ANTERIOR=""
[[ -f "$DIR/.env" ]] && ENV_ANTERIOR=1
if [[ ! -f "$DIR/.env" ]]; then
	umask 077
	cat > "$DIR/.env" <<FIN
# Generado por instalar.sh el $(date +%F). Contiene secretos: no sale de esta máquina.
# La consola nace cerrada (docs/diseno/acceso-consola.md): sin lista, el 443 solo deja
# entrar a la red de esta máquina y a la IP desde la que se instaló.
CONSOLA_NACE_CERRADA=1
NODO_DIR=$DIR
DATOS=$DIR/datos
NODO_ID=$NODO_ID
NODO_NOMBRE="$NOMBRE"
CONSOLA_URL=$URL
CONSOLA_DOMINIO=$DOMINIO
CONSOLA_PUERTO=$PUERTO
TLS_MODO=$TLS_MODO
# La CA del HTTPS de la consola (docs/diseno/ca-nodo.md): «nodo», la propia, en
# ca-nodo/. Un nodo de antes no la tiene y usa la de Caddy hasta que se cambia.
CA_NODO=$([[ "$TLS_MODO" == interno ]] && echo nodo)
POSTGRES_PASSWORD=$(secreto)
SENSOR_LOCAL_TOKEN=$(secreto)
ACTUALIZADOR_TOKEN=$(secreto)
# Cifra los secretos que se ponen en la consola (avisos y SIEM). Sin ella no se pueden leer.
CLAVE_SECRETOS=$(openssl rand -hex 32)
ACTUALIZADOR_IMAGEN=$(grep '^ACTUALIZADOR_IMAGEN=' "$AQUI/imagenes.env" | cut -d= -f2-)
PUBLICACION_CLAVE_PUBLICA=$(grep '^PUBLICACION_CLAVE_PUBLICA=' "$AQUI/imagenes.env" | cut -d= -f2-)
# Las claves de publicación por uso (docs/diseno/claves-y-catalogo.md); las renueva una versión firmada.
PUBLICACION_CLAVES=$(grep '^PUBLICACION_CLAVES=' "$AQUI/imagenes.env" | cut -d= -f2- || true)
# Registro privado de imágenes y su credencial de solo descarga.
REGISTRO=${REGISTRO:-ghcr.io}
REGISTRO_USUARIO=${REGISTRO_USUARIO:-}
REGISTRO_TOKEN=${REGISTRO_TOKEN:-}
# Trampas: puertos desplazados para no chocar con servicios reales (p. ej. 2200: SSH falso en el 2222).
TRAMPAS_DESPLAZAR=${TRAMPAS_DESPLAZAR:-0}
# Entra ID de SeguridadSI (modelo B2B de antes): solo para los nodos que aún lo
# tienen. Ningún alta nueva lo trae; el cliente conecta su propio Entra desde
# Ajustes (docs/diseno/identidad-clientes.md).
ENTRA_TENANT_ID=${ENTRA_TENANT_ID:-}
ENTRA_CLIENT_ID=${ENTRA_CLIENT_ID:-}
ENTRA_CLIENT_SECRET=${ENTRA_CLIENT_SECRET:-}
ENTRA_GRUPO_CLIENTE=${ENTRA_GRUPO_CLIENTE:-}
ENTRA_GRUPO_SOPORTE=${ENTRA_GRUPO_SOPORTE:-}
# Login local (usuario y contraseña del nodo): LOGIN_LOCAL=1 para activarlo (lo
# trae la línea del panel). En Cloud sin el Entra de SeguridadSI también está
# encendido aunque falte; LOGIN_LOCAL=0 lo apaga. Al activarlo, la consola crea
# un primer administrador y escribe su contraseña de un solo uso en su registro
# de arranque (sudo docker compose --env-file .env --env-file versiones.env logs consola,
# desde $DIR). Ver docs/diseno/auth-login.md.
LOGIN_LOCAL=${LOGIN_LOCAL:-}
# Entrar por CUALQUIER IP o nombre (ENTRAR_CUALQUIER_IP=1): Caddy escucha en :443
# para cualquier host y la consola saca el origen de las cabeceras. Vacío = solo la
# dirección dada al instalar (más seguro en nodos con IP pública).
ENTRAR_CUALQUIER_IP=${ENTRAR_CUALQUIER_IP:-}
# Panel central: el nodo se da de alta solo con este código la primera vez.
PANEL_URL=${PANEL_URL:-}
# Quién puede abrir la consola (docs/diseno/acceso-consola.md): IP o redes CIDR
# separadas por comas. Vacío = solo la red de esta máquina y la IP de la sesión SSH desde
# la que se instaló (CONSOLA_ACCESO_PROPUESTA), hasta que se guarde la lista en la consola.
CONSOLA_ACCESO=${CONSOLA_ACCESO:-}
CONSOLA_ACCESO_PROPUESTA=$(ip_ssh)
PANEL_ALTA_CODIGO=${PANEL_ALTA_CODIGO:-}
# Solo para pruebas contra un panel de desarrollo sin TLS.
PANEL_HTTP_PERMITIDO=${PANEL_HTTP_PERMITIDO:-}
FIN
	echo "Secrets generated in $DIR/.env"
fi
# La dirección de entrada a la consola (nombre o IP, el 4º argumento) puede
# cambiar entre reinstalaciones —por ejemplo pasar de un nombre a la IP de la
# máquina—: se actualiza SIEMPRE desde los argumentos, conservando los secretos
# y el resto del .env. Caddy saca un certificado nuevo para la dirección nueva.
fijar_env() { # clave valor
	grep -v "^$1=" "$DIR/.env" > "$DIR/.env.tmp" || true
	echo "$1=$2" >> "$DIR/.env.tmp"
	chmod 600 "$DIR/.env.tmp" && mv "$DIR/.env.tmp" "$DIR/.env"
}
fijar_env CONSOLA_URL "$URL"
fijar_env CONSOLA_DOMINIO "$DOMINIO"
# Modo de entrada. Fijo (por defecto): la consola se ancla al nombre/IP dado.
# «Cualquier IP/nombre» (ENTRAR_CUALQUIER_IP=1): Caddy escucha en :443 para
# cualquier host y la consola saca el origen de las cabeceras, así entras por la
# IP o el nombre que sea sin reinstalar. A cambio, en un nodo con IP pública Caddy
# puede emitir certificados a demanda a quien se los pida (riesgo menor; docs).
# El modo vive SOLO en .env (HOST_HEADER), no en el Caddyfile: el Caddyfile es
# uno, viaja firmado con cada versión y compose le pasa el modo.
if [[ "${ENTRAR_CUALQUIER_IP:-}" == 1 ]]; then
	fijar_env ORIGIN ""
	fijar_env PROTOCOL_HEADER "x-forwarded-proto"
	fijar_env HOST_HEADER "x-forwarded-host"
else
	fijar_env ORIGIN "$URL"
	fijar_env PROTOCOL_HEADER ""
	fijar_env HOST_HEADER ""
fi
# Reinstalar encima: el panel entrega una contraseña de descarga nueva (la
# anterior deja de valer), así que se actualiza aunque el .env ya existiera.
if [[ -n "${REGISTRO_TOKEN:-}" ]]; then
	for k in REGISTRO REGISTRO_USUARIO REGISTRO_TOKEN; do
		grep -v "^$k=" "$DIR/.env" > "$DIR/.env.tmp" || true
		echo "$k=${!k}" >> "$DIR/.env.tmp"
		chmod 600 "$DIR/.env.tmp" && mv "$DIR/.env.tmp" "$DIR/.env"
	done
fi
# Variables nuevas de la configuración firmada de la versión (las trae el
# instalador del panel): se añaden solo las que falten.
if [[ -s "$AQUI/entorno-extra.env" ]]; then
	while IFS= read -r linea; do
		[[ "$linea" =~ ^[A-Z][A-Z0-9_]*= ]] || continue
		grep -q "^${linea%%=*}=" "$DIR/.env" || echo "$linea" >> "$DIR/.env"
	done < "$AQUI/entorno-extra.env"
fi
SENSOR_LOCAL_RED="$RED_DETECTADA" SENSOR_LOCAL_VLAN="$VLAN_DETECTADA"
for k in SENSOR_LOCAL_RED SENSOR_LOCAL_VLAN; do
	grep -v "^$k=" "$DIR/.env" > "$DIR/.env.tmp" || true
	echo "$k=${!k}" >> "$DIR/.env.tmp"
	chmod 600 "$DIR/.env.tmp" && mv "$DIR/.env.tmp" "$DIR/.env"
done
# Un nodo instalado antes de la 0.15 no tiene la clave de los secretos: se
# crea ahora, una sola vez (el actualizador hace lo mismo con entorno.json).
# El proxy de salida y la CA corporativa, para la consola, el sensor y el actualizador, y
# el proxy.sh con el que se cambia después.
sd_proxy_env "$DIR/.env"
sd_proxy_guion "$DIR"
grep -q '^CLAVE_SECRETOS=.' "$DIR/.env" || echo "CLAVE_SECRETOS=$(openssl rand -hex 32)" >> "$DIR/.env"
# Las copias van cifradas con age a una clave pública (copia.sh). Quien instala
# puede dar la suya (SUGARDADDY_COPIAS_CLAVE=age1…, varias separadas por comas):
# así el nodo cifra sus copias sin poder leerlas. Si no, copia.sh crea un par
# más abajo. La clave-copias de antes (copias .tar.enc) se queda si ya estaba.
if [[ -n "${SUGARDADDY_COPIAS_CLAVE:-}" ]]; then
	PASO="set the backup key"
	claves="$(printf '%s' "$SUGARDADDY_COPIAS_CLAVE" | tr ', ' '\n\n' | sed '/^$/d')"
	while IFS= read -r c; do
		[[ "$c" =~ ^age1[02-9ac-hj-np-z]{58}$ ]] || { echo "Sugardaddy: SUGARDADDY_COPIAS_CLAVE must be age public keys (age1…), separated by commas. \"$c\" is not one." >&2; exit 1; }
	done <<< "$claves"
	printf '%s\n' "$claves" > "$DIR/clave-copias.pub"
	chmod 644 "$DIR/clave-copias.pub"
fi

cd "$DIR"
# La versión firmada de la que se instala, si la trae el instalador (el del panel la trae):
# su catálogo es lo único que el sensor arranca, desde el primer minuto (SEN-3). Sin ella
# (Community), el actualizador la pide a la consola en cuanto arranca.
if [[ -s "$AQUI/version-firmada.json" ]]; then
	mkdir -p "$DIR/firmado"
	cp "$AQUI/version-firmada.json" "$DIR/firmado/version.json"
	chmod 644 "$DIR/firmado/version.json"
	grep -q '"catalogo' "$DIR/firmado/version.json" && echo 1 > "$DIR/firmado/exigir"
fi
PASO="download the images"
echo "==> Downloading the images (this can take a few minutes)"
# Con imágenes privadas, docker necesita el token para la primera descarga.
if grep -q '^REGISTRO_TOKEN=.' .env; then
	grep '^REGISTRO_TOKEN=' .env | cut -d= -f2- | docker login "$(grep '^REGISTRO=' .env | cut -d= -f2-)" \
		-u "$(grep '^REGISTRO_USUARIO=' .env | cut -d= -f2-)" --password-stdin >/dev/null
fi
# Los discos de las trampas (docs/diseno/discos-trampa.md): el sensor los ve si su
# carpeta le llega con propagación desde la máquina. Solo se pide si la máquina la
# admite (lo prueba un contenedor de un instante con la imagen del sensor): en una
# que no, como un contenedor LXC con la raíz privada, Docker no arrancaría el
# sensor con ella, y sus trampas siguen con el vigilante de 10 s. Si ya estaba, se queda.
PASO="check mount propagation"
if docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
	--mount "type=bind,source=$DIR/datos/sensor,target=/sd,readonly,bind-propagation=rslave" \
	"$(grep '^SENSOR_IMAGEN=' versiones.env | cut -d= -f2-)" version >/dev/null 2>&1; then
	fijar_env SENSOR_PROPAGACION rslave
fi
# El aislamiento de las trampas (docs/diseno/aislamiento-trampas.md). Nada de esto
# para la instalación: lo que la máquina no admite, se queda sin ello y el panel lo
# dice (motor.aislamiento, disco.trampas).
PASO="isolate the decoys"
SENSOR_IMG="$(grep '^SENSOR_IMAGEN=' versiones.env | cut -d= -f2-)"
# 1. Perfil AppArmor de las trampas, si la máquina tiene AppArmor: sd-motor lo
# pone a cada trampa que corre con runc (con gVisor no hace falta).
if [[ -d /sys/kernel/security/apparmor ]] && command -v apparmor_parser >/dev/null; then
	mkdir -p /etc/apparmor.d
	cat > /etc/apparmor.d/sugardaddy-trampa <<'PERFIL'
# Perfil de las trampas de Sugardaddy (docs/diseno/aislamiento-trampas.md §4).
# El de Docker por defecto, más: sin enchufes crudos, sin ptrace, sin montar y
# sin escribir en /proc ni /sys. Lo instala instalar.sh; lo aplica sd-motor.
#include <tunables/global>
profile sugardaddy-trampa flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>
  network inet stream,
  network inet dgram,
  network inet6 stream,
  network inet6 dgram,
  network unix,
  network netlink dgram,
  deny network raw,
  deny network packet,
  file,
  deny mount,
  deny umount,
  deny pivot_root,
  deny ptrace,
  deny capability,
  signal (send,receive) peer=sugardaddy-trampa,
  signal (receive) peer=unconfined,
  deny @{PROC}/* w,
  deny @{PROC}/{[^1-9],[^1-9][^0-9],[^1-9s][^0-9y][^0-9s],[^1-9][^0-9][^0-9][^0-9/]*}/** w,
  deny @{PROC}/sys/** wklx,
  deny @{PROC}/sysrq-trigger rwklx,
  deny @{PROC}/kcore rwklx,
  deny @{PROC}/kmem rwklx,
  deny @{PROC}/mem rwklx,
  deny /sys/** wklx,
  deny /sys/firmware/** rwklx,
  deny /sys/kernel/security/** rwklx,
  deny /var/run/docker.sock rwklx,
  deny /run/docker.sock rwklx,
}
PERFIL
	if apparmor_parser -r -W /etc/apparmor.d/sugardaddy-trampa 2>/dev/null; then
		fijar_env TRAMPAS_APPARMOR sugardaddy-trampa
	else
		echo "WARNING: the AppArmor profile for decoys did not load; decoys run with seccomp only"
		fijar_env TRAMPAS_APPARMOR ""
	fi
fi
# 2. El servicio de discos del anfitrión (sd-discos): monta el disco de tamaño fijo
# de cada trampa sin contenedor privilegiado. Es el binario firmado del sensor con
# su orden discos-anfitrion, en una unidad con un único comando fijo. sd-motor le
# deja la petición en el buzón y la unidad .path la arranca.
if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null && [[ -n "$SENSOR_IMG" ]]; then
	mkdir -p /usr/local/lib/sugardaddy /var/lib/sugardaddy/discos
	chmod 700 /var/lib/sugardaddy/discos
	if docker run --rm --user 0:0 --network none --read-only --cap-drop ALL --cap-add DAC_OVERRIDE \
		-v /usr/local/lib/sugardaddy:/salida "$SENSOR_IMG" copiar-binario /salida/sd-discos >/dev/null; then
		cat > /etc/systemd/system/sd-discos.service <<UNIDAD
# Discos de las trampas de Sugardaddy (docs/diseno/aislamiento-trampas.md §5).
[Unit]
Description=Sugardaddy decoy disks
[Service]
Type=oneshot
ExecStart=/usr/local/lib/sugardaddy/sd-discos discos-anfitrion /var/lib/sugardaddy/discos $DIR/datos/sensor
# Montar un fichero en loop y formatearlo pide CAP_SYS_ADMIN; dejar las carpetas a
# quien las usa, CHOWN y FOWNER. Nada más. Sin red. Sin espacio de montaje propio
# (ProtectSystem, PrivateTmp…): los discos que monta tienen que verse en la máquina.
CapabilityBoundingSet=CAP_SYS_ADMIN CAP_CHOWN CAP_FOWNER CAP_DAC_OVERRIDE
AmbientCapabilities=
NoNewPrivileges=yes
PrivateNetwork=yes
RestrictAddressFamilies=AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
TimeoutStartSec=10min
UNIDAD
		cat > /etc/systemd/system/sd-discos.path <<UNIDAD
[Unit]
Description=Sugardaddy decoy disks: request mailbox
[Path]
PathExists=/var/lib/sugardaddy/discos/peticion.json
[Install]
WantedBy=multi-user.target
UNIDAD
		systemctl daemon-reload
		if systemctl enable --now sd-discos.path >/dev/null 2>&1; then
			: > /var/lib/sugardaddy/discos/instalado
		else
			echo "WARNING: the decoy disk service did not start; decoys run without their own disk"
		fi
	else
		echo "WARNING: could not install the decoy disk service; decoys run without their own disk"
	fi
fi
PASO="start the node"
# La consola monta la raíz de la CA: tiene que existir, como fichero normal
# (vacío hasta que haya raíz). Nunca un enlace.
[[ -L ca-raiz.crt ]] && rm -f ca-raiz.crt
[[ -e ca-raiz.crt ]] || : > ca-raiz.crt
CA_PROPIA="" CA_NUEVA=""
if [[ "$TLS_MODO" == interno ]] && grep -q '^CA_NODO=nodo$' .env; then
	# La CA propia: la que ya hay si cubre la dirección de la consola, o una
	# nueva (la primera vez, o si la dirección cambió). La crea el actualizador
	# de esta versión; la clave de la raíz no se escribe en ningún sitio.
	PASO="create the node CA"
	CA_PROPIA=1
	ca="$(docker compose --env-file .env --env-file versiones.env run --rm --no-deps -T actualizador ca-generar /nodo/ca-nodo "$DOMINIO" "$NODO_ID" | tail -1)"
	case "$ca" in
	new\ *) CA_NUEVA=1 ;;
	kept\ *) ;;
	*) echo "Sugardaddy: could not create the node certificate authority: $ca" >&2; exit 1 ;;
	esac
	if [[ -n "$CA_NUEVA" ]]; then
		# Los certificados que Caddy guardó de una CA anterior ya no casan con la nueva.
		docker compose --env-file .env --env-file versiones.env run --rm --no-deps -T --entrypoint rm https -rf /data/caddy/certificates/nodo
	fi
	openssl x509 -in ca-nodo/raiz.crt > ca-raiz.crt
	chmod 644 ca-raiz.crt
fi
PASO="start the node"
echo "==> Starting the node"
docker compose --env-file .env --env-file versiones.env up -d --wait
# El Caddyfile es un bind-mount y Caddy no recarga su contenido solo (admin off):
# `up` no recrea Caddy si solo cambió el CONTENIDO del fichero (p. ej. un arreglo
# o la dirección). Se fuerza su recreación para que lo relea, sin tocar el resto.
docker compose --env-file .env --env-file versiones.env up -d --no-deps --force-recreate https
if [[ "$TLS_MODO" == interno && -z "$CA_PROPIA" ]]; then
	# La raíz de la CA del nodo, para instalarla en los equipos que entren a la
	# consola. Lo que sale de Caddy no se copia tal cual: se saca a una carpeta
	# temporal y solo pasa un certificado de CA, escrito encima de ca-raiz.crt
	# (el mismo fichero que la consola ya tiene montado).
	PASO="export the CA root"
	tmp="$(mktemp -d)"
	for _ in 1 2 3 4 5; do
		rm -rf "$tmp/raiz.crt"
		if docker compose --env-file .env --env-file versiones.env cp https:/data/caddy/pki/authorities/local/root.crt "$tmp/raiz.crt" 2>/dev/null \
			&& [[ -f "$tmp/raiz.crt" && ! -L "$tmp/raiz.crt" ]] \
			&& openssl x509 -in "$tmp/raiz.crt" -noout -text 2>/dev/null | grep -q 'CA:TRUE'; then
			openssl x509 -in "$tmp/raiz.crt" > ca-raiz.crt
			chmod 644 ca-raiz.crt
			break
		fi
		sleep 2
	done
	rm -rf "$tmp"
fi
# El appliance lee la huella de esta línea: no cambiar su forma.
if [[ "$TLS_MODO" == interno && -s ca-raiz.crt ]]; then
	echo "Node CA root in $DIR/ca-raiz.crt (fingerprint $(openssl x509 -in ca-raiz.crt -noout -fingerprint -sha256 | cut -d= -f2))"
	[[ -n "$CA_PROPIA" ]] && echo "It only works for $DOMINIO: install it as a trusted root on the computers that open the console."
	if [[ -n "$CA_NUEVA" && -n "$ENV_ANTERIOR" ]]; then
		echo "Sugardaddy: the console address is not covered by the previous node root, so a new one was created. Install it on the computers that open the console: browsers will not open it until they trust it." >&2
	fi
fi
echo "Node running. Console at $URL"
echo "Until you choose who can open it, the console only answers this machine's network${RED_DETECTADA:+ ($RED_DETECTADA)} and the address you installed from."
echo "If you ever lock yourself out, run this on this machine: sudo touch $DIR/abrir-consola (it opens the console to everyone for 24 hours)"

# Copias de seguridad cada noche, encendidas por defecto (plan de fortificación
# §8.2): con systemd, un temporizador; sin él, cron. SUGARDADDY_COPIAS=0 las
# apaga (y quita lo que hubiera). Nada de esto para la instalación: si falla, se
# avisa y el nodo sigue.
PASO="schedule the backups"
CLAVE_COPIAS_NUEVA=""
if [[ "${SUGARDADDY_COPIAS:-1}" == 0 || "${SUGARDADDY_COPIAS:-1}" == no ]]; then
	if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null; then
		systemctl disable --now sugardaddy-copias.timer >/dev/null 2>&1 || true
		rm -f /etc/systemd/system/sugardaddy-copias.timer /etc/systemd/system/sugardaddy-copias.service
		systemctl daemon-reload || true
	fi
	rm -f /etc/cron.d/sugardaddy-copias
	echo "Nightly backups are OFF (SUGARDADDY_COPIAS=$SUGARDADDY_COPIAS): run $DIR/copia.sh yourself."
else
	[[ -s clave-copias.pub ]] || CLAVE_COPIAS_NUEVA=1
	if ! ./copia.sh --preparar >/dev/null; then
		CLAVE_COPIAS_NUEVA=""
		echo "WARNING: could not prepare the backup key; the nightly backup will try again."
	fi
	if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null; then
		cat > /etc/systemd/system/sugardaddy-copias.service <<UNIDAD
# Copia de seguridad del nodo de Sugardaddy (copia.sh). La programa instalar.sh.
[Unit]
Description=Sugardaddy node backup
Wants=docker.service
After=docker.service
[Service]
Type=oneshot
ExecStart="$DIR/copia.sh"
Nice=10
IOSchedulingClass=idle
UNIDAD
		cat > /etc/systemd/system/sugardaddy-copias.timer <<UNIDAD
[Unit]
Description=Sugardaddy node backup, every night
[Timer]
OnCalendar=*-*-* 03:15:00
# Si la máquina estaba apagada a esa hora, en cuanto arranca.
Persistent=true
RandomizedDelaySec=30min
[Install]
WantedBy=timers.target
UNIDAD
		systemctl daemon-reload
		if systemctl enable --now sugardaddy-copias.timer >/dev/null 2>&1; then
			rm -f /etc/cron.d/sugardaddy-copias
			echo "Nightly backups ON: $DIR/copias (systemctl list-timers sugardaddy-copias)"
		else
			echo "WARNING: could not schedule the nightly backups; run $DIR/copia.sh from your scheduler."
		fi
	elif [[ -d /etc/cron.d ]]; then
		printf '# Copia de seguridad del nodo de Sugardaddy. La programa instalar.sh.\nSHELL=/bin/bash\n15 3 * * * root "%s/copia.sh" >> "%s/copias/copia.log" 2>&1\n' "$DIR" "$DIR" > /etc/cron.d/sugardaddy-copias
		chmod 644 /etc/cron.d/sugardaddy-copias
		mkdir -p copias
		echo "Nightly backups ON: $DIR/copias (/etc/cron.d/sugardaddy-copias)"
	else
		echo "WARNING: this machine has neither systemd nor cron: run $DIR/copia.sh every night from your scheduler."
	fi
fi

# Lo que el cliente tiene que guardar, junto y una sola vez: la contraseña del
# primer administrador (si el nodo la acaba de crear, sale en el registro de la
# consola) y el código de emergencia (solo se crea si el nodo aún no tiene uno:
# al reinstalar encima, el que ya guardó sigue valiendo).
PASO="create the emergency code"
CLAVE_ADMIN="$(docker compose --env-file .env --env-file versiones.env logs --no-log-prefix consola 2>/dev/null \
	| sed -n -E 's/^  (Contraseña|Password):  //p' | tail -1 || true)"
CODIGO_EMERGENCIA="$(docker compose --env-file .env --env-file versiones.env exec -T consola node scripts/codigo-emergencia.mjs --si-no-hay)"
if [[ -n "$CLAVE_ADMIN" || -n "$CODIGO_EMERGENCIA" || -n "$CLAVE_COPIAS_NUEVA" ]]; then
	barra="$(printf '=%.0s' {1..64})"
	echo
	echo "$barra"
	echo "  SAVE THIS OUTSIDE THIS MACHINE: it will not be shown again"
	echo
	if [[ -n "$CLAVE_ADMIN" ]]; then
		echo "  First administrator:   admin"
		echo "  Initial password:      $CLAVE_ADMIN   (if you have not changed it yet)"
		echo
	fi
	if [[ -n "$CODIGO_EMERGENCIA" ]]; then
		echo "  Emergency code:        $CODIGO_EMERGENCIA"
		echo "  To sign in as administrator if you lose the password and"
		echo "  email does not arrive: $URL/emergencia"
		echo "  It works once; when you use it, the console gives you a new one."
	fi
	if [[ -n "$CLAVE_COPIAS_NUEVA" ]]; then
		[[ -n "$CLAVE_ADMIN" || -n "$CODIGO_EMERGENCIA" ]] && echo
		echo "  Backup key:            $DIR/clave-copias.age"
		echo "  Copy this file off the machine: without it the backups cannot be"
		echo "  restored. Once copied, you can delete it here so this machine"
		echo "  cannot read its own backups (it only needs clave-copias.pub)."
	fi
	echo "$barra"
fi
