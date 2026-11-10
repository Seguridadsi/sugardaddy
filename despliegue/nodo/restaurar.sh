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
COPIA="${1:?Usage: restaurar.sh <backup.tar.enc>}"
[[ -f clave-copias ]] || { echo "clave-copias is missing: without it the backup cannot be decrypted"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:clave-copias -in "$COPIA" | tar -C "$TMP" -xf -

if [[ ! -f .env ]]; then
	echo "New machine: restoring .env, versiones.env and the CA root"
	cp "$TMP/.env" "$TMP/versiones.env" .
	[[ -f "$TMP/ca-raiz.crt" ]] && cp "$TMP/ca-raiz.crt" .
	[[ -d "$TMP/ca-nodo" && ! -e ca-nodo ]] && cp -a "$TMP/ca-nodo" .
fi
# Un nodo que ya pasó a su CA propia no vuelve a recibir la de Caddy, que se
# destruyó al cambiar (docs/diseno/ca-nodo.md): una copia anterior, sacada de
# la máquina antes del cambio, aún la llevaría.
if grep -q '^CA_NODO=nodo$' .env && [[ -d "$TMP/caddy" ]]; then
	find "$TMP/caddy" -depth \( -path '*/pki/authorities/local' -o -path '*/certificates/local' \) -exec rm -rf {} +
fi
dc() { docker compose --env-file .env --env-file versiones.env "$@"; }

read -r -p "The node database will be replaced with the one in the backup. Continue? [y/N] " ok
[[ "$ok" == "y" || "$ok" == "Y" ]] || { echo "Cancelled"; exit 1; }

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
echo "Restored. Check the console and the audit log."
