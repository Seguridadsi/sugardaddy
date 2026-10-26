#!/usr/bin/env bash
#
# Construye EN LOCAL las tres imágenes del nodo (consola, sensor, actualizador)
# desde la fuente del repositorio y deja un imagenes.env al lado de instalar.sh.
# Sirve para PROBAR Sugardaddy desde un clon, sin depender de ningún registro ni
# de una versión publicada. Una instalación de verdad usa las imágenes firmadas
# de una versión (ver README / docs).
#
#   despliegue/nodo/construir-imagenes-local.sh            # versión 0.0.0-local
#   despliegue/nodo/construir-imagenes-local.sh 0.0.0-mio  # otra etiqueta
#
# Después:
#   sudo LOGIN_LOCAL=1 despliegue/nodo/instalar.sh /opt/sugardaddy nodo-01 "Mi empresa" consola.miempresa.local
#
# (LOGIN_LOCAL=1 enciende la entrada con usuario y contraseña; en la edición
# community ya viene encendida y no hace falta.)
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
V="${1:-0.0.0-local}"
PLAT=linux/amd64

command -v docker >/dev/null || { echo "Hace falta Docker."; exit 1; }
cd "$RAIZ"

echo "==> docker-compose que embebe el actualizador"
CV="$(awk '{print $3}' "$RAIZ/herramientas/compose.sha256")"
mkdir -p "$RAIZ/sensor/dist"
if ! ( cd "$RAIZ/sensor/dist" && shasum -a 256 -c <(awk '{print $1"  "$2}' "$RAIZ/herramientas/compose.sha256") >/dev/null 2>&1 ); then
	curl -fsSL -o "$RAIZ/sensor/dist/docker-compose-linux-amd64" \
		"https://github.com/docker/compose/releases/download/$CV/docker-compose-linux-x86_64"
	( cd "$RAIZ/sensor/dist" && shasum -a 256 -c <(awk '{print $1"  "$2}' "$RAIZ/herramientas/compose.sha256") >/dev/null ) \
		|| { echo "La huella de docker-compose no cuadra."; exit 1; }
	chmod +x "$RAIZ/sensor/dist/docker-compose-linux-amd64"
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
