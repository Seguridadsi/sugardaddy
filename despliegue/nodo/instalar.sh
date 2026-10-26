#!/usr/bin/env bash
#
# Instala un nodo de Sugardaddy en esta máquina.
#
#   despliegue/nodo/instalar.sh /opt/sugardaddy nodo-mad01 "Grupo Aldanza" gestion.aldanza.local
#
# HTTPS: por defecto con una CA propia del nodo (su raíz se deja en
# <carpeta>/ca-raiz.crt para instalarla en los equipos). Con TLS_MODO=ficheros
# se usa el certificado del cliente, que hay que dejar antes en
# <carpeta>/certs/certificado.pem y <carpeta>/certs/clave.pem.
#
# Las imágenes se toman de imagenes.env (al lado de este script): las de una
# versión firmada, siempre por digest. Genera los secretos del nodo una sola
# vez; si ya hay un .env, lo respeta y solo vuelve a arrancar.
#
# Normalmente no se llama a mano: lo llama el instalador que genera el panel
# (curl …/instalar/<código> | sudo bash), que le pasa por entorno el registro
# y su credencial, la configuración de Entra y el código de alta en el panel.
set -Eeuo pipefail
# Si algo falla, se dice en qué paso: quien instala no tiene a nadie al lado.
PASO="preparar"
trap 'echo "Sugardaddy: falló el paso «$PASO». Revisa el mensaje de arriba y vuelve a lanzar la línea; si no se arregla, avisa a SeguridadSI." >&2' ERR

DIR="${1:?Uso: instalar.sh <carpeta> <id-del-nodo> \"Nombre del cliente\" <url-de-la-consola>}"
NODO_ID="${2:?Falta el id del nodo (p. ej. nodo-mad01)}"
NOMBRE="${3:?Falta el nombre del cliente}"
DOMINIO="${4:?Falta el nombre con el que se entra a la consola (p. ej. gestion.aldanza.local)}"
TLS_MODO="${TLS_MODO:-interno}"
PUERTO="${CONSOLA_PUERTO:-443}"
URL="https://$DOMINIO$([[ $PUERTO == 443 ]] || echo ":$PUERTO")"
AQUI="$(cd "$(dirname "$0")" && pwd)"

[[ "$NODO_ID" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "Id de nodo no válido: $NODO_ID"; exit 1; }
[[ "$DOMINIO" =~ ^[a-z0-9.-]+$ ]] || { echo "Nombre no válido: $DOMINIO"; exit 1; }
[[ "$TLS_MODO" == interno || "$TLS_MODO" == ficheros ]] || { echo "TLS_MODO es interno o ficheros"; exit 1; }
[[ "$(id -u)" == 0 ]] || { echo "Hay que ejecutarlo como root (sudo)"; exit 1; }
PASO="comprobar la arquitectura"
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
	echo "Sugardaddy: este nodo necesita un motor Docker de Linux amd64 (x86_64) y el de esta máquina es $plataforma, donde sus contenedores no arrancarían. Instálalo en una máquina o VM x86_64. No se ha cambiado nada en esta, pero si lo has lanzado con la línea de instalación, esa línea ya se ha gastado: para la otra máquina, pide una nueva a SeguridadSI. (código instalar.arquitectura)" >&2
	exit 1
fi
PASO="instalar Docker"
if ! command -v docker >/dev/null; then
	# Docker desde su repositorio oficial, en Ubuntu o Debian.
	command -v apt-get >/dev/null || { echo "Hace falta Docker (instalación automática solo en Ubuntu y Debian)"; exit 1; }
	echo "==> Instalando Docker"
	. /etc/os-release
	apt-get update -qq && apt-get install -y -qq ca-certificates curl >/dev/null
	install -m 0755 -d /etc/apt/keyrings
	curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
	apt-get update -qq && apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
fi
[[ -f "$AQUI/imagenes.env" ]] || { echo "Falta $AQUI/imagenes.env con las imágenes de la versión"; exit 1; }

mkdir -p "$DIR/datos/sensor" "$DIR/certs"
DIR="$(cd "$DIR" && pwd)"
cp "$AQUI/compose.yml" "$AQUI/Caddyfile" "$AQUI/copia.sh" "$AQUI/restaurar.sh" "$DIR/"
if [[ "$TLS_MODO" == ficheros && ! -f "$DIR/certs/certificado.pem" ]]; then
	echo "Con TLS_MODO=ficheros, deja antes el certificado en $DIR/certs/certificado.pem y clave.pem"
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
PASO="preparar la carpeta"
nueva="$(grep '^SUGARDADDY_VERSION=' "$AQUI/imagenes.env" | cut -d= -f2- || true)"
# El guard anti-retroceso protege contra un rollback automático a una versión
# firmada vieja; NO aplica a un build LOCAL (etiqueta *-local), que es una acción
# manual y deliberada del operador: ese se instala siempre, aunque el nodo tenga
# una versión «más nueva» (construir-imagenes-local.sh, docs).
if [[ -f "$DIR/versiones.env" && "$nueva" != *-local ]]; then
	actual="$(grep '^SUGARDADDY_VERSION=' "$DIR/versiones.env" | cut -d= -f2- || true)"
	if [[ -n "$actual" && -n "$nueva" && "$actual" != "$nueva" && "$(printf '%s\n' "$actual" "$nueva" | sort -V | tail -1)" == "$actual" ]]; then
		echo "Este nodo ya tiene la versión $actual, más nueva que la de este instalador ($nueva). Pide una línea nueva a SeguridadSI."
		exit 1
	fi
fi
grep -E '^(SUGARDADDY_VERSION|CONSOLA_IMAGEN|SENSOR_IMAGEN|ACTUALIZADOR_IMAGEN)=' "$AQUI/imagenes.env" > "$DIR/versiones.env.tmp"
[[ -n "${SUGARDADDY_CONFIGURACION:-}" ]] && echo "SUGARDADDY_CONFIGURACION=$SUGARDADDY_CONFIGURACION" >> "$DIR/versiones.env.tmp"
mv "$DIR/versiones.env.tmp" "$DIR/versiones.env"

secreto() { openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48; }
if [[ ! -f "$DIR/.env" ]]; then
	umask 077
	cat > "$DIR/.env" <<FIN
# Generado por instalar.sh el $(date +%F). Contiene secretos: no sale de esta máquina.
NODO_DIR=$DIR
DATOS=$DIR/datos
NODO_ID=$NODO_ID
NODO_NOMBRE="$NOMBRE"
CONSOLA_URL=$URL
CONSOLA_DOMINIO=$DOMINIO
CONSOLA_PUERTO=$PUERTO
TLS_MODO=$TLS_MODO
POSTGRES_PASSWORD=$(secreto)
SENSOR_LOCAL_TOKEN=$(secreto)
ACTUALIZADOR_TOKEN=$(secreto)
# Cifra los secretos que se ponen en la consola (avisos y SIEM). Sin ella no se pueden leer.
CLAVE_SECRETOS=$(openssl rand -hex 32)
ACTUALIZADOR_IMAGEN=$(grep '^ACTUALIZADOR_IMAGEN=' "$AQUI/imagenes.env" | cut -d= -f2-)
PUBLICACION_CLAVE_PUBLICA=$(grep '^PUBLICACION_CLAVE_PUBLICA=' "$AQUI/imagenes.env" | cut -d= -f2-)
# Registro privado de imágenes y su credencial de solo descarga.
REGISTRO=${REGISTRO:-ghcr.io}
REGISTRO_USUARIO=${REGISTRO_USUARIO:-}
REGISTRO_TOKEN=${REGISTRO_TOKEN:-}
# Trampas: puertos desplazados para no chocar con servicios reales (p. ej. 2200: SSH falso en el 2222).
TRAMPAS_DESPLAZAR=${TRAMPAS_DESPLAZAR:-0}
# Entra ID (lo trae el instalador del panel; a mano, despliegue/entra/registrar.sh).
ENTRA_TENANT_ID=${ENTRA_TENANT_ID:-}
ENTRA_CLIENT_ID=${ENTRA_CLIENT_ID:-}
ENTRA_CLIENT_SECRET=${ENTRA_CLIENT_SECRET:-}
ENTRA_GRUPO_CLIENTE=${ENTRA_GRUPO_CLIENTE:-}
ENTRA_GRUPO_SOPORTE=${ENTRA_GRUPO_SOPORTE:-}
# Login local (usuario y contraseña del nodo): LOGIN_LOCAL=1 para activarlo en
# vez de, o además de, Entra. Vacío = solo Entra. Al activarlo, la consola crea
# un primer administrador y escribe su contraseña de un solo uso en su registro
# de arranque (docker compose logs consola). Ver docs/diseno/auth-login.md.
LOGIN_LOCAL=${LOGIN_LOCAL:-}
# Panel central: el nodo se da de alta solo con este código la primera vez.
PANEL_URL=${PANEL_URL:-}
PANEL_ALTA_CODIGO=${PANEL_ALTA_CODIGO:-}
# Solo para pruebas contra un panel de desarrollo sin TLS.
PANEL_HTTP_PERMITIDO=${PANEL_HTTP_PERMITIDO:-}
FIN
	echo "Secretos generados en $DIR/.env"
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
# Un nodo instalado antes de la 0.15 no tiene la clave de los secretos: se
# crea ahora, una sola vez (el actualizador hace lo mismo con entorno.json).
grep -q '^CLAVE_SECRETOS=.' "$DIR/.env" || echo "CLAVE_SECRETOS=$(openssl rand -hex 32)" >> "$DIR/.env"
if [[ ! -f "$DIR/clave-copias" ]]; then
	(umask 077 && openssl rand -base64 48 > "$DIR/clave-copias")
	echo "Clave de las copias en $DIR/clave-copias: guárdala también fuera de esta máquina."
fi

cd "$DIR"
PASO="descargar las imágenes"
# Con imágenes privadas, docker necesita el token para la primera descarga.
if grep -q '^REGISTRO_TOKEN=.' .env; then
	grep '^REGISTRO_TOKEN=' .env | cut -d= -f2- | docker login "$(grep '^REGISTRO=' .env | cut -d= -f2-)" \
		-u "$(grep '^REGISTRO_USUARIO=' .env | cut -d= -f2-)" --password-stdin >/dev/null
fi
PASO="arrancar el nodo"
# La consola monta la raíz de la CA: tiene que existir, como fichero normal
# (vacío hasta que Caddy la cree). Nunca un enlace.
[[ -L ca-raiz.crt ]] && rm -f ca-raiz.crt
[[ -e ca-raiz.crt ]] || : > ca-raiz.crt
docker compose --env-file .env --env-file versiones.env up -d --wait
if [[ "$TLS_MODO" == interno ]]; then
	# La raíz de la CA del nodo, para instalarla en los equipos que entren a la
	# consola. Lo que sale de Caddy no se copia tal cual: se saca a una carpeta
	# temporal y solo pasa un certificado de CA, escrito encima de ca-raiz.crt
	# (el mismo fichero que la consola ya tiene montado).
	PASO="exportar la raíz de la CA"
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
	[[ -s ca-raiz.crt ]] && echo "Raíz de la CA del nodo en $DIR/ca-raiz.crt (huella $(openssl x509 -in ca-raiz.crt -noout -fingerprint -sha256 | cut -d= -f2))"
fi
echo "Nodo en marcha. Consola en $URL"
