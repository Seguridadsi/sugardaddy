#!/usr/bin/env bash
#
# Asistente de instalación de un nodo de Sugardaddy: comprueba la máquina,
# pregunta lo que instalar.sh pide por argumentos, enseña un resumen y lo lanza.
#
#   sudo despliegue/nodo/asistente.sh        (o instalar.sh sin argumentos)
#
# No instala nada por su cuenta: todo lo hace instalar.sh, al que llama con los
# mismos argumentos y variables que se le pasarían a mano. Por eso el instalador
# del panel, el appliance y cualquier instalación desatendida siguen igual: no
# pasan por aquí.
#
# Con whiptail (viene en Ubuntu y Debian) las preguntas salen en pantallas; sin
# él, o con ASISTENTE_SIMPLE=1, como preguntas de texto que también se pueden
# contestar por la entrada estándar (así lo prueba pruebas/probar-asistente.sh).
set -Eeuo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"
INSTALADOR="${ASISTENTE_INSTALADOR:-$AQUI/instalar.sh}"
TITULO="Sugardaddy setup"

PANTALLAS=""
if [[ -z "${ASISTENTE_SIMPLE:-}" && -t 0 && -t 1 ]] && command -v whiptail >/dev/null; then
	PANTALLAS=1
fi

# --- Las cuatro piezas de la interfaz, en pantallas o en texto ---------------

cancelar() {
	echo "Sugardaddy: setup cancelled. Nothing was changed on this machine." >&2
	exit 1
}

mensaje() { # texto
	if [[ -n "$PANTALLAS" ]]; then
		whiptail --title "$TITULO" --msgbox "$1" 20 76 || cancelar
	else
		printf '\n%s\n' "$1"
	fi
}

confirmar() { # texto [botón sí] [botón no] → 0 si sí
	local r
	if [[ -n "$PANTALLAS" ]]; then
		whiptail --title "$TITULO" --yes-button "${2:-Yes}" --no-button "${3:-No}" --yesno "$1" 20 76
		return
	fi
	printf '\n%s\n' "$1"
	while true; do
		printf '%s / %s (y/n): ' "${2:-Yes}" "${3:-No}"
		IFS= read -r r || cancelar
		case "$r" in
		y | Y | yes | Yes) return 0 ;;
		n | N | no | No) return 1 ;;
		esac
	done
}

RESPUESTA=""
preguntar() { # texto [valor propuesto] → deja la respuesta en RESPUESTA
	if [[ -n "$PANTALLAS" ]]; then
		RESPUESTA="$(whiptail --title "$TITULO" --inputbox "$1" 16 76 "${2:-}" 3>&1 1>&2 2>&3)" || cancelar
	else
		printf '\n%s\n' "$1"
		if [[ -n "${2:-}" ]]; then printf '[%s]: ' "$2"; else printf ': '; fi
		IFS= read -r RESPUESTA || cancelar
		[[ -n "$RESPUESTA" ]] || RESPUESTA="${2:-}"
	fi
	# Sin espacios alrededor: se pegan al copiar.
	RESPUESTA="$(printf '%s' "$RESPUESTA" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
}

# --- Lo que se mira de la máquina --------------------------------------------

puerto_ocupado() { # puerto → 0 si algo escucha en él
	if command -v ss >/dev/null; then
		[[ -n "$(ss -ltnH "sport = :$1" 2>/dev/null)" ]]
	else
		(exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
	fi
}

quien_escucha() { # puerto → nombre del proceso, si se sabe
	ss -ltnpH "sport = :$1" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -1
}

# La IP de la sesión SSH desde la que se instala (mismo criterio que instalar.sh:
# sudo borra SSH_CLIENT, así que se busca en los procesos de los que cuelga este).
ip_ssh() {
	local pid=$$ ip
	for _ in 1 2 3 4 5 6 7 8; do
		pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
		[[ -n "$pid" && "$pid" -gt 1 ]] || return 0
		ip="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^SSH_CLIENT=\([^ ]*\).*/\1/p' | head -1)"
		[[ -n "$ip" ]] && { echo "$ip"; return 0; }
	done
}

ip_principal() {
	local ip
	ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}' || true)"
	[[ -n "$ip" ]] || ip="$(hostname -I 2>/dev/null | awk '{ print $1 }' || true)"
	echo "$ip"
}

libre_gb() { # carpeta → GB libres en el disco donde está (o estaría)
	local d="$1"
	while [[ ! -d "$d" && "$d" != / ]]; do d="$(dirname "$d")"; done
	df -Pk "$d" 2>/dev/null | awk 'NR == 2 { printf "%d", $4 / 1048576 }'
}

BIEN=() AVISOS=() BLOQUEOS=() FALTA_OPENSSL=""

comprobar() {
	local plataforma="" so="this system" memoria libre

	[[ "$(id -u)" == 0 ]] || BLOQUEOS+=("It must be run as root: run it again with sudo.")

	[[ -r /etc/os-release ]] && so="$(. /etc/os-release && echo "${PRETTY_NAME:-$ID}")"

	# Como instalar.sh: cuenta el motor de Docker, no la máquina.
	if command -v docker >/dev/null; then
		plataforma="$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}' 2>/dev/null || true)"
	fi
	if [[ -z "$plataforma" ]]; then
		case "$(uname -m)" in
		x86_64 | amd64) plataforma=linux/amd64 ;;
		*) plataforma="linux/$(uname -m)" ;;
		esac
	fi
	if [[ "$plataforma" == linux/amd64 ]]; then
		BIEN+=("$so, x86_64")
	else
		BLOQUEOS+=("Sugardaddy needs a Linux x86_64 (amd64) machine or VM, and this one is $plataforma.")
	fi

	if command -v docker >/dev/null; then
		if ! docker info >/dev/null 2>&1; then
			BLOQUEOS+=("Docker is installed but does not answer. Start it (sudo systemctl start docker) and run this again.")
		elif ! docker compose version >/dev/null 2>&1; then
			BLOQUEOS+=("Docker is installed without the Compose plugin. Install the docker-compose-plugin package and run this again.")
		else
			BIEN+=("Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null) with Compose")
		fi
	elif command -v apt-get >/dev/null; then
		BIEN+=("Docker is not installed: it will be installed from its official repository")
	else
		BLOQUEOS+=("Docker is not installed, and it can only be installed automatically on Ubuntu and Debian. Install Docker Engine with the Compose plugin and run this again.")
	fi

	# instalar.sh genera con él los secretos del nodo. Una imagen mínima no lo trae.
	if ! command -v openssl >/dev/null; then
		if command -v apt-get >/dev/null; then
			FALTA_OPENSSL=1
			BIEN+=("openssl is not installed: it will be installed")
		else
			BLOQUEOS+=("The openssl command is missing. Install the openssl package and run this again.")
		fi
	fi

	memoria="$(awk '/^MemTotal:/ { printf "%d", $2 / 1024 }' /proc/meminfo 2>/dev/null || true)"
	if [[ -n "$memoria" ]]; then
		if ((memoria < 1800)); then
			AVISOS+=("This machine has ${memoria} MB of memory. With less than 2 GB the console and the honeypots may run short.")
		else
			BIEN+=("${memoria} MB of memory")
		fi
	fi

	libre="$(libre_gb /var/lib/docker)"
	if [[ -n "$libre" ]]; then
		if ((libre < 10)); then
			AVISOS+=("Only ${libre} GB are free where Docker keeps its images. Less than 10 GB may not be enough for the node and its honeypots.")
		else
			BIEN+=("${libre} GB free for Docker")
		fi
	fi

	# Las imágenes se descargan de un registro: sin salida, la instalación se queda a medias.
	local registro="${REGISTRO:-ghcr.io}"
	if timeout 8 bash -c "exec 3<>/dev/tcp/${registro%%/*}/443" 2>/dev/null; then
		BIEN+=("Internet access (${registro%%/*} answers)")
	else
		AVISOS+=("${registro%%/*} does not answer on port 443. Without internet access the images cannot be downloaded.")
	fi
}

informe() {
	local texto="" x
	for x in ${BIEN[@]+"${BIEN[@]}"}; do texto+="  [ok]  $x"$'\n'; done
	for x in ${AVISOS[@]+"${AVISOS[@]}"}; do texto+=$'\n'"  [!]   $x"$'\n'; done
	for x in ${BLOQUEOS[@]+"${BLOQUEOS[@]}"}; do texto+=$'\n'"  [x]   $x"$'\n'; done
	if ((${#BLOQUEOS[@]})); then
		mensaje "This machine is not ready yet:"$'\n\n'"$texto"$'\n'"Nothing was changed. Fix what is marked [x] and run this again."
		exit 1
	fi
	if ((${#AVISOS[@]})); then
		confirmar "Checks on this machine:"$'\n\n'"$texto"$'\n'"You can continue, but review what is marked [!]." "Continue" "Cancel" || cancelar
	else
		mensaje "This machine is ready:"$'\n\n'"$texto"
	fi
}

# --- Las preguntas -----------------------------------------------------------

de_env() { # fichero clave → valor (sin comillas)
	grep "^$2=" "$1" 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true
}

DIR="" NOMBRE="" NODO_ID="" DOMINIO="" PUERTO="${CONSOLA_PUERTO:-443}" ACCESO="${CONSOLA_ACCESO:-}" YA=""

preguntas() {
	local propuesta

	while true; do
		preguntar "Folder where the node will live. It holds its configuration, its secrets and its data." "${DIR:-/opt/sugardaddy}"
		[[ "$RESPUESTA" == /* && "$RESPUESTA" != / ]] && break
		mensaje "Enter a full path, such as /opt/sugardaddy."
	done
	DIR="$RESPUESTA"

	# Reinstalar encima: se propone lo que ya tiene y se conservan sus secretos.
	if [[ -f "$DIR/.env" ]]; then
		YA=1
		NOMBRE="$(de_env "$DIR/.env" NODO_NOMBRE)"
		NODO_ID="$(de_env "$DIR/.env" NODO_ID)"
		DOMINIO="$(de_env "$DIR/.env" CONSOLA_DOMINIO)"
		PUERTO="$(de_env "$DIR/.env" CONSOLA_PUERTO)"
		PUERTO="${PUERTO:-443}"
		mensaje "$DIR already holds a node ($NODO_ID). It will be updated in place: its data, its secrets and its settings are kept. You can change the address used to reach the console."
	else
		while true; do
			preguntar "Name of your company, as it will appear in the console." "$NOMBRE"
			[[ -n "$RESPUESTA" && "$RESPUESTA" != *\"* && "$RESPUESTA" != *\$* && "$RESPUESTA" != *\`* && "$RESPUESTA" != *\\* ]] && break
			mensaje "Enter a name, without quotes, backslashes or dollar signs."
		done
		NOMBRE="$RESPUESTA"

		propuesta="$(printf '%s' "$NOMBRE" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^-//' -e 's/-$//' | cut -c1-40)"
		while true; do
			preguntar "Identifier of this node: lowercase letters, digits and hyphens. It tells this installation apart from others of yours." "${NODO_ID:-node-${propuesta:-01}}"
			[[ "$RESPUESTA" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] && break
			mensaje "Use only lowercase letters, digits and hyphens, starting with a letter or a digit."
		done
		NODO_ID="$RESPUESTA"
	fi

	while true; do
		preguntar "Address you will type in the browser to open the console: this machine's IP, or a DNS name that points to it. The console certificate is issued for this address." "${DOMINIO:-$(ip_principal)}"
		[[ "$RESPUESTA" =~ ^[a-z0-9.-]+$ ]] && break
		mensaje "Enter an IP address or a name in lowercase, without https:// and without a port."
	done
	DOMINIO="$RESPUESTA"

	if [[ -z "$YA" ]]; then
		while puerto_ocupado "$PUERTO"; do
			propuesta="$(quien_escucha "$PUERTO")"
			preguntar "Port $PUERTO is already in use on this machine${propuesta:+ (by $propuesta)}. Enter another port for the console." "$([[ "$PUERTO" == 443 ]] && echo 8443 || echo $((PUERTO + 1)))"
			[[ "$RESPUESTA" =~ ^[0-9]{2,5}$ ]] && ((RESPUESTA <= 65535)) && PUERTO="$RESPUESTA"
		done

		propuesta="${ACCESO:-$(ip_ssh)}"
		while true; do
			preguntar "Which addresses can open the console? Enter IP addresses or networks (such as 10.0.0.0/24) separated by commas: the ones your browser will come from. Leave it empty to decide the first time you sign in." "$propuesta"
			RESPUESTA="${RESPUESTA// /}"
			[[ -z "$RESPUESTA" || "$RESPUESTA" =~ ^[0-9a-fA-F:.]+(/[0-9]{1,3})?(,[0-9a-fA-F:.]+(/[0-9]{1,3})?)*$ ]] && break
			mensaje "Enter addresses such as 192.168.1.20 or 10.0.0.0/24, separated by commas."
		done
		ACCESO="$RESPUESTA"
	fi
}

resumen() {
	local url="https://$DOMINIO$([[ "$PUERTO" == 443 ]] || echo ":$PUERTO")" texto
	texto="  Folder:          $DIR"$'\n'
	texto+="  Company:         $NOMBRE"$'\n'
	texto+="  Node:            $NODO_ID"$'\n'
	texto+="  Console:         $url"$'\n'
	if [[ -z "$YA" ]]; then
		texto+="  Console access:  ${ACCESO:-decided at first sign-in}"$'\n'
	fi
	if [[ -n "$CONSTRUIR" ]]; then
		texto+=$'\n'"The node images are built from source on this machine first. It takes a while the first time (10 to 20 minutes)."$'\n'
	fi
	confirmar "$([[ -n "$YA" ]] && echo "This node will be updated:" || echo "This is what will be installed:")"$'\n\n'"$texto"$'\n'"Nothing has been changed so far." "$([[ -n "$YA" ]] && echo Update || echo Install)" "Cancel" || cancelar
}

# --- En marcha ---------------------------------------------------------------

comprobar
informe

# Desde un clon (Community) las imágenes se construyen aquí; con una versión
# publicada, imagenes.env ya viene al lado del instalador.
CONSTRUIR=""
if [[ ! -f "$AQUI/imagenes.env" ]]; then
	if [[ -f "$AQUI/construir-imagenes-local.sh" ]]; then
		CONSTRUIR=1
	else
		mensaje "$AQUI/imagenes.env is missing: it holds the images of the version to install. Download the installer again."
		exit 1
	fi
fi

preguntas
resumen

if [[ -n "$FALTA_OPENSSL" ]]; then
	echo "==> Installing openssl"
	apt-get update -qq && apt-get install -y -qq openssl >/dev/null
fi
if [[ -n "$CONSTRUIR" ]]; then
	command -v docker >/dev/null || bash "$INSTALADOR" --instalar-docker
	echo "==> Building the node images"
	bash "$AQUI/construir-imagenes-local.sh"
fi

export CONSOLA_PUERTO="$PUERTO"
[[ -z "$ACCESO" ]] || export CONSOLA_ACCESO="$ACCESO"
# Sin Entra configurado, la entrada es con usuario y contraseña: si no, no habría cómo entrar.
[[ -n "${ENTRA_TENANT_ID:-}" || -n "${LOGIN_LOCAL:-}" ]] || export LOGIN_LOCAL=1

# Con bash y no ejecutando el fichero: en una carpeta montada noexec no arrancaría.
bash "$INSTALADOR" "$DIR" "$NODO_ID" "$NOMBRE" "$DOMINIO"

echo
echo "Next: open the console in your browser and sign in. The console then guides you"
echo "through the rest of the setup: who can open it, your company, the certificate and"
echo "your first honeypot."
