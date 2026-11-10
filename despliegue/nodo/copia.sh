#!/usr/bin/env bash
#
# Copia de seguridad del nodo, cifrada. Desde la carpeta del nodo:
#
#   ./copia.sh            (o desde cron: 15 3 * * * cd /opt/sugardaddy && ./copia.sh)
#
# Guarda la base de datos, .env (secretos), versiones.env y la CA del HTTPS
# (la propia del nodo en ca-nodo/, o la de Caddy en un nodo de antes; ver
# docs/diseno/ca-nodo.md) en copias/sugardaddy-<fecha>.tar.enc, cifrado con
# clave-copias. Esa clave hay que guardarla también FUERA de esta máquina: sin
# ella, la copia no sirve. Al pasar a la CA propia, el actualizador quita de
# las copias que hay aquí la CA de Caddy.
# Conserva las últimas COPIAS_CONSERVAR (14 por defecto).
set -euo pipefail
cd "$(dirname "$0")"
[[ -f clave-copias ]] || { echo "clave-copias is missing (instalar.sh creates it)"; exit 1; }

dc() { docker compose --env-file .env --env-file versiones.env "$@"; }
mkdir -p copias
# Al pasar a la CA propia, el actualizador quita de las copias la CA de Caddy
# con este mismo cerrojo: que no salga a la vez una copia que aún la lleve.
exec 9>copias/.cerrojo
if command -v flock >/dev/null; then flock 9; fi
FECHA="$(date +%Y%m%d-%H%M%S)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

dc exec -T postgres pg_dump -U sugardaddy -d consola -Fc > "$TMP/consola.dump"
dc cp https:/data "$TMP/caddy" >/dev/null 2>&1 || echo "warning: no Caddy data (TLS with customer files?)"
cp .env versiones.env "$TMP/"
[[ -f ca-raiz.crt ]] && cp ca-raiz.crt "$TMP/"
# La raíz y la intermedia (con su clave): sin ellas, una máquina nueva tendría
# otra raíz y habría que volver a repartirla en los equipos.
[[ -d ca-nodo ]] && cp -a ca-nodo "$TMP/"

tar -C "$TMP" -cf - . | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass file:clave-copias \
	-out "copias/sugardaddy-$FECHA.tar.enc"
chmod 600 "copias/sugardaddy-$FECHA.tar.enc"

ls -1t copias/sugardaddy-*.tar.enc | tail -n +"$(( ${COPIAS_CONSERVAR:-14} + 1 ))" | xargs -r rm --
echo "Backup in $(pwd)/copias/sugardaddy-$FECHA.tar.enc ($(du -h "copias/sugardaddy-$FECHA.tar.enc" | cut -f1))"
