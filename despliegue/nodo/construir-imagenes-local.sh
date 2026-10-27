#!/usr/bin/env bash
#
# Construye EN LOCAL las tres imágenes del nodo (consola, sensor, actualizador)
# desde la fuente del repositorio y deja un imagenes.env al lado de instalar.sh.
# Sirve para PROBAR Sugardaddy desde un clon, sin depender de ningún registro ni
# de una versión publicada. Una instalación de verdad usa las imágenes firmadas
# de una versión (ver README / docs).
#
#   despliegue/nodo/construir-imagenes-local.sh            # versión 9.9.9
#   despliegue/nodo/construir-imagenes-local.sh 0.16.0     # otra etiqueta (semver X.Y.Z)
#
# Después:
#   sudo LOGIN_LOCAL=1 despliegue/nodo/instalar.sh /opt/sugardaddy nodo-01 "Mi empresa" consola.miempresa.local
#
# (LOGIN_LOCAL=1 enciende la entrada con usuario y contraseña; en la edición
# community ya viene encendida y no hace falta.)
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
# Versión por defecto ALTA y en SEMVER LIMPIO (X.Y.Z, sin sufijo): un build local
# es siempre el código más reciente, así que con 9.9.9 satisface cualquier requisito
# de versión (p. ej. trampas que piden sensor >= 0.13) y el instalador lo trata como
# una actualización (9.9.9 es más que cualquier versión real). OJO: tiene que ser
# semver limpio; la comparación de versiones (compararVersiones) rechaza sufijos como
# -local y las trampas se quedarían bloqueadas.
V="${1:-9.9.9}"
PLAT=linux/amd64

command -v docker >/dev/null || { echo "Hace falta Docker."; exit 1; }
cd "$RAIZ"

# Comprueba el sha256 de un fichero contra un valor (Linux: sha256sum; si no, shasum).
verificar_sha() { # <sha> <fichero>
	if command -v sha256sum >/dev/null 2>&1; then
		echo "$1  $2" | sha256sum -c - >/dev/null 2>&1
	else
		echo "$1  $2" | shasum -a 256 -c - >/dev/null 2>&1
	fi
}

echo "==> docker-compose que embebe el actualizador"
# Versión y huella de docker-compose. Espejo de herramientas/compose.sha256, que
# NO viaja a la edición community; si se sube la versión, cámbialas también aquí.
COMPOSE_VER="v5.5.0"
COMPOSE_SHA="c57ab918abd5b05ca7e7d0f275875dd1330a695074f309dc9eab1b49efafcd4b"
COMPOSE_BIN="$RAIZ/sensor/dist/docker-compose-linux-amd64"
mkdir -p "$RAIZ/sensor/dist"
if ! verificar_sha "$COMPOSE_SHA" "$COMPOSE_BIN"; then
	curl -fsSL -o "$COMPOSE_BIN" \
		"https://github.com/docker/compose/releases/download/$COMPOSE_VER/docker-compose-linux-x86_64"
	verificar_sha "$COMPOSE_SHA" "$COMPOSE_BIN" || { echo "La huella de docker-compose no cuadra."; exit 1; }
	chmod +x "$COMPOSE_BIN"
fi

echo "==> Imagen de la consola (base + el catálogo de trampas dentro)"
docker build --platform "$PLAT" --build-arg "VERSION=$V" \
	-f "$RAIZ/apps/consola/Dockerfile" -t "sugardaddy-consola-base:$V" "$RAIZ"
# El catálogo (modulos/) va DENTRO de la imagen de la consola, igual que en el
# flujo oficial: se añade sobre la imagen base.
docker build --platform "$PLAT" --build-arg "BASE=sugardaddy-consola-base:$V" \
	-t "sugardaddy-consola:$V" -f - "$RAIZ" <<'DOCKER'
ARG BASE
FROM ${BASE}
USER root
COPY modulos /app/modulos
USER node
DOCKER

echo "==> Imagen del sensor"
docker build --platform "$PLAT" --build-arg BINARIO=sensor --build-arg "VERSION=$V" \
	-t "sugardaddy-sensor:$V" -f "$RAIZ/sensor/Dockerfile" "$RAIZ/sensor"

echo "==> Imagen del actualizador"
docker build --platform "$PLAT" --build-arg "VERSION=$V" \
	-t "sugardaddy-actualizador:$V" -f "$RAIZ/sensor/Dockerfile.actualizador" "$RAIZ/sensor"

echo "==> imagenes.env (etiquetas locales; sin registro, sin firma)"
cat > "$AQUI/imagenes.env" <<ENV
SUGARDADDY_VERSION=$V
CONSOLA_IMAGEN=sugardaddy-consola:$V
SENSOR_IMAGEN=sugardaddy-sensor:$V
ACTUALIZADOR_IMAGEN=sugardaddy-actualizador:$V
PUBLICACION_CLAVE_PUBLICA=
ENV

echo
echo "Listo. Imágenes construidas e imagenes.env escrito en $AQUI/imagenes.env"
echo "Ahora instala (con login local activo):"
echo "  sudo LOGIN_LOCAL=1 $AQUI/instalar.sh /opt/sugardaddy nodo-01 \"Mi empresa\" consola.miempresa.local"
