#!/usr/bin/env bash
#
# Copia de seguridad del nodo, cifrada y autenticada con age. Desde la carpeta del nodo:
#
#   ./copia.sh              hace una copia
#   ./copia.sh --preparar   solo deja lista la clave de las copias (lo llama instalar.sh)
#
# instalar.sh la programa cada noche (sugardaddy-copias.timer de systemd o, sin
# systemd, /etc/cron.d/sugardaddy-copias). Guarda la base de datos, .env
# (secretos), versiones.env y la CA del HTTPS (la propia del nodo en ca-nodo/,
# o la de Caddy en un nodo de antes; ver docs/diseno/ca-nodo.md) en
# copias/sugardaddy-<fecha>.tar.age.
#
# Cifrado (plan de fortificación §5.6): age, X25519 + ChaCha20-Poly1305, para
# las claves públicas de clave-copias.pub (una por línea: la del cliente y, si
# quiere, otra de respaldo). Con solo la pública, esta máquina cifra las copias
# pero no puede leerlas, y nadie puede cambiar una copia sin que restaurar.sh lo
# note. Si no hay clave-copias.pub, se crea un par la primera vez y la privada
# se queda en clave-copias.age: hay que guardarla FUERA de esta máquina (y, si
# se quiere que el nodo no pueda leer sus copias, borrarla de aquí). age va en
# la imagen del actualizador de la versión: igual en todas las máquinas, sin
# instalar nada en ellas. Las copias de antes (sugardaddy-*.tar.enc, con
# clave-copias) se siguen pudiendo restaurar.
#
# Conserva las últimas COPIAS_CONSERVAR (14 por defecto), de los dos formatos.
#
# Fuera de la máquina (plan de fortificación §8.2, docs/diseno/copias-fuera.md):
# este script no tiene red ni secretos y solo crea la copia. Si en la consola hay
# un destino (Ajustes → Backups: SMB, S3 o Azure Blob), el actualizador la sube en
# cuanto aparece aquí, deja allí las últimas que se elijan y una vez al mes la baja
# y la comprueba. Si el destino falla, la copia sigue aquí y la consola avisa.
set -euo pipefail
cd "$(dirname "$0")"

dc() { docker compose --env-file .env --env-file versiones.env "$@"; }
IMAGEN_AGE="$(grep '^ACTUALIZADOR_IMAGEN=' versiones.env 2>/dev/null | cut -d= -f2- || true)"
[[ -n "$IMAGEN_AGE" ]] || { echo "versiones.env has no ACTUALIZADOR_IMAGEN: run this from the node folder"; exit 1; }
# age y age-keygen en un contenedor de un instante: sin red, sin capacidades, de
# solo lectura y con el usuario de quien llama.
en_imagen() { # programa args…
	local programa="$1"
	shift
	docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
		--user "$(id -u):$(id -g)" --entrypoint "$programa" "$IMAGEN_AGE" "$@"
}
# Una clave pública de age: age1 y 58 caracteres de bech32.
DESTINATARIO='^age1[02-9ac-hj-np-z]{58}$'

preparar() {
	[[ -s clave-copias.pub ]] && return 0
	if [[ -e clave-copias.age ]]; then
		echo "clave-copias.age exists but clave-copias.pub does not: put its public key (age1…) in clave-copias.pub" >&2
		return 1
	fi
	local par pub
	par="$(en_imagen age-keygen 2>/dev/null)"
	pub="$(printf '%s\n' "$par" | en_imagen age-keygen -y)"
	[[ "$pub" =~ $DESTINATARIO ]] || { echo "could not create the backup key" >&2; return 1; }
	(umask 077 && printf '%s\n' "$par" > clave-copias.age)
	printf '%s\n' "$pub" > clave-copias.pub
	chmod 644 clave-copias.pub
	echo "Backup key created. Private key in $(pwd)/clave-copias.age: store it OUTSIDE this machine; without it the backups cannot be restored."
}

if [[ "${1:-}" == --preparar ]]; then
	preparar
	exit 0
fi
preparar

DESTINOS=()
while IFS= read -r linea || [[ -n "$linea" ]]; do
	linea="${linea%%#*}"
	linea="$(printf '%s' "$linea" | tr -d '[:space:]')"
	[[ -z "$linea" ]] && continue
	[[ "$linea" =~ $DESTINATARIO ]] || { echo "clave-copias.pub: \"$linea\" is not an age public key (age1…)"; exit 1; }
	DESTINOS+=(-r "$linea")
done < clave-copias.pub
[[ ${#DESTINOS[@]} -gt 0 ]] || { echo "clave-copias.pub has no public key"; exit 1; }

mkdir -p copias
# Al pasar a la CA propia, el actualizador quita de las copias la CA de Caddy
# con este mismo cerrojo: que no salga a la vez una copia que aún la lleve.
exec 9>copias/.cerrojo
if command -v flock >/dev/null; then flock 9; fi
FECHA="$(date +%Y%m%d-%H%M%S)"
TMP="$(mktemp -d)"
SALIDA="copias/sugardaddy-$FECHA.tar.age"
trap 'rm -rf "$TMP" "$SALIDA.tmp"' EXIT

dc exec -T postgres pg_dump -U sugardaddy -d consola -Fc > "$TMP/consola.dump"
dc cp https:/data "$TMP/caddy" >/dev/null 2>&1 || echo "warning: no Caddy data (TLS with customer files?)"
# clave-copias.pub va dentro: una máquina restaurada sigue cifrando para la misma clave.
cp .env versiones.env clave-copias.pub "$TMP/"
[[ -f ca-raiz.crt ]] && cp ca-raiz.crt "$TMP/"
# La raíz y la intermedia (con su clave): sin ellas, una máquina nueva tendría
# otra raíz y habría que volver a repartirla en los equipos.
[[ -d ca-nodo ]] && cp -a ca-nodo "$TMP/"

# A un .tmp y luego a su nombre: una copia a medias nunca cuenta como copia.
(umask 077 && tar -C "$TMP" -cf - . | en_imagen age "${DESTINOS[@]}" > "$SALIDA.tmp")
[[ "$(head -c 21 "$SALIDA.tmp")" == "age-encryption.org/v1" ]] || { echo "the backup was not written"; exit 1; }
mv "$SALIDA.tmp" "$SALIDA"

shopt -s nullglob
todas=(copias/sugardaddy-*.tar.age copias/sugardaddy-*.tar.enc)
if [[ ${#todas[@]} -gt ${COPIAS_CONSERVAR:-14} ]]; then
	ls -1t "${todas[@]}" | tail -n +"$((${COPIAS_CONSERVAR:-14} + 1))" | xargs -r rm --
fi
echo "Backup in $(pwd)/$SALIDA ($(du -h "$SALIDA" | cut -f1))"
