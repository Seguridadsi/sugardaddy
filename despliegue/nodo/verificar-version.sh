#!/usr/bin/env bash
# Check by hand that a Sugardaddy Community version is signed by SeguridadSI.
#
#   despliegue/nodo/verificar-version.sh [ultima-community.json] [PUBLICACION_CLAVES] [PUBLICACION_CLAVE_PUBLICA]
#
# With no arguments it uses the ultima-community.json at the root of this repository and
# the keys in despliegue/nodo/PUBLICACION_CLAVES and PUBLICACION_CLAVE_PUBLICA (the
# original key, still accepted), which are the ones a node trusts. It
# checks every signature with openssl, says which key made each one and prints the
# image digests the signed version pins. With the GitHub CLI (gh) installed, it also
# checks that each image was built by the public repository's GitHub Action.
#
# This is the same check the updater makes before it installs a version. It needs
# openssl 3 and python3; it changes nothing on the machine.
#
# Exit status: 0 signed by at least one SeguridadSI community key; 1 anything else.
set -euo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
VERSION_FIRMADA="${1:-$RAIZ/ultima-community.json}"
CLAVES="${2:-$AQUI/PUBLICACION_CLAVES}"
CLAVE_ORIGINAL="${3:-$AQUI/PUBLICACION_CLAVE_PUBLICA}"
REPO="Seguridadsi/sugardaddy"
FLUJO="$REPO/.github/workflows/publicar-imagenes.yml"

for orden in openssl python3; do
	command -v "$orden" >/dev/null || { echo "The $orden command is missing: install it and run this again."; exit 1; }
done
[[ -s "$VERSION_FIRMADA" ]] || { echo "Not found: $VERSION_FIRMADA"; exit 1; }
[[ -s "$CLAVES" ]] || { echo "Not found: $CLAVES"; exit 1; }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

# Splits the signed file into the exact text that was signed, one file per signature
# (raw, as openssl wants it) and the list of images. Nothing in it is run.
python3 -I - "$VERSION_FIRMADA" "$T" <<'PY'
import base64, json, sys

origen, t = sys.argv[1], sys.argv[2]
d = json.load(open(origen, encoding="utf-8"))
texto = d["release"]
open(f"{t}/texto", "wb").write(texto.encode("utf-8"))
firmas = []
if d.get("firma"):
    firmas.append(d["firma"])
firmas += [f["firma"] for f in d.get("firmas", []) if f.get("firma")]

def der(raw):
    # ECDSA P-256: the signature travels as r||s (64 bytes); openssl wants DER.
    def entero(b):
        b = b.lstrip(b"\0") or b"\0"
        if b[0] & 0x80:
            b = b"\0" + b
        return b"\x02" + bytes([len(b)]) + b
    cuerpo = entero(raw[:32]) + entero(raw[32:])
    return b"\x30" + bytes([len(cuerpo)]) + cuerpo

for i, f in enumerate(firmas):
    raw = base64.b64decode(f)
    open(f"{t}/firma{i}.raw", "wb").write(raw)
    if len(raw) == 64:
        open(f"{t}/firma{i}.der", "wb").write(der(raw))

r = json.loads(texto)
with open(f"{t}/resumen", "w") as s:
    s.write(f"version {r.get('version', '?')}\n")
    s.write(f"publicada {r.get('publicada', '?')}\n")
    for nombre, imagen in sorted(r.get("servicios", {}).items()):
        s.write(f"imagen {nombre} {imagen}\n")
    if r.get("actualizador"):
        s.write(f"imagen actualizador {r['actualizador']}\n")
PY

# The community keys of PUBLICACION_CLAVES, one PEM per key, named by fingerprint
# (sha256 of the key, 16 hex: the same fingerprint the console and the updater show).
n=0
original=""
[[ -s "$CLAVE_ORIGINAL" ]] && original="community:$(tr -d '[:space:]' < "$CLAVE_ORIGINAL")"
for entrada in $(tr -d '[:space:]' < "$CLAVES" | tr ',' ' ') $original; do
	[[ "$entrada" == community:* ]] || continue
	clave="${entrada#community:}"
	{
		echo '-----BEGIN PUBLIC KEY-----'
		printf '%s\n' "$clave" | fold -w 64
		echo '-----END PUBLIC KEY-----'
	} > "$T/clave$n.pem"
	n=$((n + 1))
done
((n > 0)) || { echo "$CLAVES has no community key."; exit 1; }

huella() {
	openssl pkey -pubin -in "$1" -outform DER 2>/dev/null | openssl dgst -sha256 -r | cut -c1-16
}

firmo() { # clave firma → 0 if that key made that signature
	local pem=$1 i=$2
	if [[ -s "$T/firma$i.der" ]] && openssl dgst -sha256 -verify "$pem" -signature "$T/firma$i.der" "$T/texto" >/dev/null 2>&1; then
		return 0
	fi
	openssl pkeyutl -verify -pubin -inkey "$pem" -rawin -in "$T/texto" -sigfile "$T/firma$i.raw" >/dev/null 2>&1
}

echo "Signed version: $VERSION_FIRMADA"
sed -n 's/^version /  version:   /p; s/^publicada /  published: /p' "$T/resumen"
echo

declare -a QUIENES=()
for f in "$T"/firma*.raw; do
	i="${f##*/firma}" i="${i%.raw}"
	quien=""
	for pem in "$T"/clave*.pem; do
		if firmo "$pem" "$i"; then quien="$(huella "$pem")"; break; fi
	done
	if [[ -n "$quien" ]]; then
		echo "  [ok] signature $((i + 1)): SeguridadSI community key $quien"
		QUIENES+=("$quien")
	else
		echo "  [x]  signature $((i + 1)): made by no trusted key"
	fi
done
distintas="$(printf '%s\n' ${QUIENES[@]+"${QUIENES[@]}"} | sort -u | grep -c . || true)"
echo
if ((distintas == 0)); then
	echo "NOT SIGNED by any SeguridadSI community key. Do not install this version."
	exit 1
fi
echo "Signed by $distintas distinct SeguridadSI key(s). The updater asks for two on versions"
echo "with sensitive changes and for one on the rest."
echo
echo "Images the signed version pins (by digest):"
sed -n 's/^imagen \([^ ]*\) /  \1: /p' "$T/resumen"

if ! command -v gh >/dev/null; then
	echo
	echo "Install the GitHub CLI (gh) to also check that the public repository's Action built them."
	exit 0
fi
echo
echo "Where the images come from (signed build provenance):"
fallos=0
while read -r _ nombre imagen; do
	digest="${imagen##*@}" base="${imagen%%@*}" base="${base%:*}"
	if gh attestation verify "oci://$base@$digest" -R "$REPO" --signer-workflow "$FLUJO" \
		--source-ref refs/heads/main >/dev/null 2>&1; then
		echo "  [ok] $nombre: built by $FLUJO"
	else
		echo "  [x]  $nombre: no valid provenance (or gh is not signed in: gh auth login)"
		fallos=1
	fi
done < <(grep '^imagen ' "$T/resumen")
exit "$fallos"
