#!/usr/bin/env bash
#
# Restaura una copia de copia.sh. Desde la carpeta del nodo:
#
#   ./restaurar.sh copias/sugardaddy-20261013-031500.tar.enc
#
# Sustituye la base de datos entera por la de la copia. Si es una máquina
# nueva (sin .env), recupera también los secretos y la CA del HTTPS.
set -euo pipefail
cd "$(dirname "$0")"
COPIA="${1:?Uso: restaurar.sh <copia.tar.enc>}"
[[ -f clave-copias ]] || { echo "Falta clave-copias: sin ella no se puede descifrar"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:clave-copias -in "$COPIA" | tar -C "$TMP" -xf -

if [[ ! -f .env ]]; then
	echo "Máquina nueva: recupero .env, versiones.env y la raíz de la CA"
	cp "$TMP/.env" "$TMP/versiones.env" .
	[[ -f "$TMP/ca-raiz.crt" ]] && cp "$TMP/ca-raiz.crt" .
fi
dc() { docker compose --env-file .env --env-file versiones.env "$@"; }

read -r -p "Se va a sustituir la base de datos del nodo por la de la copia. ¿Seguir? [s/N] " ok
[[ "$ok" == "s" ]] || { echo "Cancelado"; exit 1; }

dc up -d --wait postgres
# Pase lo que pase a partir de aquí, el nodo vuelve a quedar en marcha.
trap 'rm -rf "$TMP"; dc up -d >/dev/null 2>&1 || true' EXIT
dc stop consola sensor actualizador >/dev/null 2>&1 || true
dc exec -T postgres pg_restore -U sugardaddy -d consola --clean --if-exists --no-owner < "$TMP/consola.dump"
if [[ -d "$TMP/caddy" ]]; then
	dc stop https >/dev/null 2>&1 || true
	dc cp "$TMP/caddy/." https:/data
	# docker cp conserva el usuario de quien restaura; Caddy corre sin
	# capacidades y no podría leer su propia CA. Se devuelven a root con un
	# contenedor puntual con las capacidades justas para hacerlo, y nada más.
	dc run --rm --no-deps --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add DAC_READ_SEARCH --cap-add FOWNER \
		--entrypoint chown https -R 0:0 /data
fi
dc up -d --wait
echo "Restaurado. Revisa la consola y la auditoría."
