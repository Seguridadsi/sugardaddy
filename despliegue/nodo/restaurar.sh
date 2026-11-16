#!/usr/bin/env bash
#
# Restaura una copia de copia.sh. Desde la carpeta del nodo:
#
#   ./restaurar.sh copias/sugardaddy-20261115-031500.tar.age
#   ./restaurar.sh -i /media/usb/clave-copias.age copias/sugardaddy-….tar.age
#   ./restaurar.sh --comprobar copias/sugardaddy-….tar.age    solo comprueba; no toca nada
#
# --comprobar sin la clave privada (lo normal en el nodo: la guarda el cliente
# fuera) solo puede mirar la forma de la cabecera de age: el MAC de la cabecera
# y los de cada trozo se calculan con la clave del fichero, que solo se saca con
# la privada. Lo dice y sale con 3, nunca con 0. Lo mismo hace cada mes el
# actualizador con la última copia del destino (docs/diseno/copias-fuera.md).
#
# Sustituye la base de datos entera por la de la copia. Si es una máquina
# nueva (sin .env), recupera también los secretos y la CA del HTTPS.
#
# Una copia de age (.tar.age) se abre con la clave privada (AGE-SECRET-KEY-…):
# clave-copias.age de esta carpeta o la que se dé con -i. age comprueba cada
# trozo: si alguien cambió o cortó la copia, se para antes de tocar nada. Para
# descifrar usa age de la imagen del actualizador (versiones.env) o, en una
# máquina nueva sin ella, el age de la máquina (apt install age).
# Las copias de antes (.tar.enc: AES-CBC con clave-copias, sin autenticar) se
# siguen leyendo, avisando de que su integridad no se puede comprobar.
set -euo pipefail
cd "$(dirname "$0")"
USO="Usage: restaurar.sh [--comprobar] [-i private-key] <backup>"
COMPROBAR="" IDENTIDAD=""
while [[ $# -gt 0 ]]; do
	case "$1" in
	--comprobar) COMPROBAR=1 ;;
	-i) IDENTIDAD="${2:?$USO}" && shift ;;
	-*) echo "$USO"; exit 1 ;;
	*) break ;;
	esac
	shift
done
COPIA="${1:?$USO}"
[[ -f "$COPIA" ]] || { echo "$COPIA does not exist"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CABECERA="$(head -c 21 "$COPIA" | tr -d '\0')"
if [[ "$CABECERA" == "age-encryption.org/v1" ]]; then
	[[ -n "$IDENTIDAD" ]] || IDENTIDAD=clave-copias.age
	if [[ -n "$COMPROBAR" && ! -f "$IDENTIDAD" ]]; then
		cabecera="$(head -c 4096 "$COPIA" | LC_ALL=C tr -d '\0' | sed -n '1,/^--- /p')"
		destinatarios="$(printf '%s\n' "$cabecera" | grep -c '^-> X25519 ' || true)"
		if [[ "$destinatarios" -lt 1 ]] || ! printf '%s\n' "$cabecera" | grep -q '^--- '; then
			echo "The backup is damaged: its age header is not complete. Nothing was touched."
			exit 1
		fi
		echo "Without the private key only the format can be checked: the age header is complete, encrypted to $destinatarios public key(s)."
		echo "Whether it decrypts and holds the database cannot be verified without the private key: run this again with -i <private key> where you keep it."
		exit 3
	fi
	[[ -f "$IDENTIDAD" ]] || { echo "$IDENTIDAD is missing: give the private backup key (AGE-SECRET-KEY-…) with -i"; exit 1; }
	IDENTIDAD="$(cd "$(dirname "$IDENTIDAD")" && pwd)/$(basename "$IDENTIDAD")"
	IMAGEN_AGE="$(grep '^ACTUALIZADOR_IMAGEN=' versiones.env 2>/dev/null | cut -d= -f2- || true)"
	# Entera a un fichero antes de abrirla: age solo da por buena la copia al final.
	if [[ -n "$IMAGEN_AGE" ]]; then
		docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
			--user "$(id -u):$(id -g)" -v "$IDENTIDAD:/clave:ro" --entrypoint age "$IMAGEN_AGE" \
			-d -i /clave < "$COPIA" > "$TMP/copia.tar" \
			|| { echo "The backup cannot be opened: wrong key, or the backup was changed or is incomplete. Nothing was touched."; exit 1; }
	elif command -v age >/dev/null; then
		age -d -i "$IDENTIDAD" -o "$TMP/copia.tar" "$COPIA" \
			|| { echo "The backup cannot be opened: wrong key, or the backup was changed or is incomplete. Nothing was touched."; exit 1; }
	else
		echo "age is needed to open the backup: install it (apt install age, dnf install age) or put the node's versiones.env in this folder."
		exit 1
	fi
	echo "Backup authenticated: it is complete and nobody changed it."
elif [[ "$CABECERA" == Salted__* ]]; then
	[[ -f clave-copias ]] || { echo "clave-copias is missing: without it this backup (old format) cannot be decrypted"; exit 1; }
	echo "WARNING: backup in the old format (AES-CBC without authentication): its integrity cannot be checked. New backups use age."
	openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:clave-copias -in "$COPIA" -out "$TMP/copia.tar" \
		|| { echo "The backup cannot be decrypted with clave-copias. Nothing was touched."; exit 1; }
else
	echo "$COPIA is not a Sugardaddy backup"
	exit 1
fi
mkdir "$TMP/c"
tar -C "$TMP/c" -xf "$TMP/copia.tar" || { echo "The backup is damaged (tar). Nothing was touched."; exit 1; }
rm -f "$TMP/copia.tar"
for f in consola.dump .env versiones.env; do
	[[ -s "$TMP/c/$f" ]] || { echo "The backup is incomplete: $f is missing. Nothing was touched."; exit 1; }
done
if [[ -n "$COMPROBAR" ]]; then
	echo "The backup can be restored: database, .env and versiones.env are there$([[ -d "$TMP/c/ca-nodo" ]] && echo ", and the node CA")."
	exit 0
fi

if [[ ! -f .env ]]; then
	echo "New machine: restoring .env, versiones.env and the CA root"
	cp "$TMP/c/.env" "$TMP/c/versiones.env" .
	[[ -f "$TMP/c/ca-raiz.crt" ]] && cp "$TMP/c/ca-raiz.crt" .
	[[ -d "$TMP/c/ca-nodo" && ! -e ca-nodo ]] && cp -a "$TMP/c/ca-nodo" .
fi
# Sigue cifrando para la misma clave pública.
[[ -f "$TMP/c/clave-copias.pub" && ! -e clave-copias.pub ]] && cp "$TMP/c/clave-copias.pub" .
# Un nodo que ya pasó a su CA propia no vuelve a recibir la de Caddy, que se
# destruyó al cambiar (docs/diseno/ca-nodo.md): una copia anterior, sacada de
# la máquina antes del cambio, aún la llevaría.
if grep -q '^CA_NODO=nodo$' .env && [[ -d "$TMP/c/caddy" ]]; then
	find "$TMP/c/caddy" -depth \( -path '*/pki/authorities/local' -o -path '*/certificates/local' \) -exec rm -rf {} +
fi
dc() { docker compose --env-file .env --env-file versiones.env "$@"; }

read -r -p "The node database will be replaced with the one in the backup. Continue? [y/N] " ok
[[ "$ok" == "y" || "$ok" == "Y" ]] || { echo "Cancelled"; exit 1; }

dc up -d --wait postgres
# Pase lo que pase a partir de aquí, el nodo vuelve a quedar en marcha.
trap 'rm -rf "$TMP"; dc up -d >/dev/null 2>&1 || true' EXIT
dc stop consola sensor actualizador >/dev/null 2>&1 || true
dc exec -T postgres pg_restore -U sugardaddy -d consola --clean --if-exists --no-owner < "$TMP/c/consola.dump"
if [[ -d "$TMP/c/caddy" ]]; then
	dc stop https >/dev/null 2>&1 || true
	dc cp "$TMP/c/caddy/." https:/data
	# docker cp conserva el usuario de quien restaura; Caddy corre sin
	# capacidades y no podría leer su propia CA. Se devuelven a root con un
	# contenedor puntual con las capacidades justas para hacerlo, y nada más.
	dc run --rm --no-deps --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add DAC_READ_SEARCH --cap-add FOWNER \
		--entrypoint chown https -R 0:0 /data
fi
dc up -d --wait
echo "Restored. Check the console and the audit log."
