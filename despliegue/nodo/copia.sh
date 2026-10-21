#!/usr/bin/env bash
#
# Copia de seguridad del nodo, cifrada. Desde la carpeta del nodo:
#
#   ./copia.sh            (o desde cron: 15 3 * * * cd /opt/sugardaddy && ./copia.sh)
#
# Guarda la base de datos, .env (secretos), versiones.env y la CA del HTTPS
# en copias/sugardaddy-<fecha>.tar.enc, cifrado con clave-copias. Esa clave
# hay que guardarla también FUERA de esta máquina: sin ella, la copia no sirve.
# Conserva las últimas COPIAS_CONSERVAR (14 por defecto).
set -euo pipefail
cd "$(dirname "$0")"
[[ -f clave-copias ]] || { echo "Falta clave-copias (la genera instalar.sh)"; exit 1; }

dc() { docker compose --env-file .env --env-file versiones.env "$@"; }
FECHA="$(date +%Y%m%d-%H%M%S)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p copias

dc exec -T postgres pg_dump -U sugardaddy -d consola -Fc > "$TMP/consola.dump"
dc cp https:/data "$TMP/caddy" >/dev/null 2>&1 || echo "aviso: sin datos de Caddy (¿TLS con ficheros del cliente?)"
cp .env versiones.env "$TMP/"
[[ -f ca-raiz.crt ]] && cp ca-raiz.crt "$TMP/"

tar -C "$TMP" -cf - . | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass file:clave-copias \
	-out "copias/sugardaddy-$FECHA.tar.enc"
chmod 600 "copias/sugardaddy-$FECHA.tar.enc"

ls -1t copias/sugardaddy-*.tar.enc | tail -n +"$(( ${COPIAS_CONSERVAR:-14} + 1 ))" | xargs -r rm --
echo "Copia en $(pwd)/copias/sugardaddy-$FECHA.tar.enc ($(du -h "copias/sugardaddy-$FECHA.tar.enc" | cut -f1))"
