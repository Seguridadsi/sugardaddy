#!/usr/bin/env bash
#
# Prepara el código con el que se construye nuestra imagen de Cowrie: el de la
# versión fijada con el parche de Sugardaddy (parche.py): sin las partes de
# JA4+ con licencia FoxIO 1.1, que no permite el uso comercial (ver
# docs/diseno/tpot.md), y con tope en lo que apunta del atacante (cada valor
# recortado y cowrie.json con tope diario por origen y total, en
# sugardaddy.py). Se construye después con el Dockerfile del propio Cowrie
# (docker/Dockerfile), que con el parche corre antes las de pruebas/.
#
#   modulos/trampas/cowrie/imagen/preparar.sh <carpeta nueva>
set -euo pipefail
VERSION=v3.1.2
COMMIT=56b2abb3b02fcb53980334f77daa0fe570f5e4be
DEST="${1:?Uso: preparar.sh <carpeta nueva>}"
AQUI="$(cd "$(dirname "$0")" && pwd)"
[[ ! -e "$DEST" ]] || { echo "$DEST ya existe"; exit 1; }

git -c advice.detachedHead=false clone -q --depth 1 --branch "$VERSION" https://github.com/cowrie/cowrie.git "$DEST"
[[ "$(git -C "$DEST" rev-parse HEAD)" == "$COMMIT" ]] || { echo "La etiqueta $VERSION de Cowrie ya no es el commit fijado"; exit 1; }
install -m 0644 "$AQUI/sugardaddy.py" "$DEST/src/cowrie/core/sugardaddy.py"
mkdir "$DEST/sd-pruebas"
install -m 0644 "$AQUI/pruebas/test_sugardaddy.py" "$DEST/sd-pruebas/test_sugardaddy.py"
(cd "$DEST" && python3 -I "$AQUI/parche.py")
# Lo que el CI de Cowrie genera con setuptools-scm antes de construir: sin él
# Cowrie dice «no está instalado» y no arranca.
cat > "$DEST/src/cowrie/_version.py" <<FIN
# Generado por preparar.sh (Sugardaddy), como lo haría setuptools-scm.
__version__ = version = '${VERSION#v}'
__version_tuple__ = version_tuple = ($(echo "${VERSION#v}" | tr . ,))
__commit_id__ = commit_id = 'g${COMMIT:0:9}'
FIN
rm -rf "$DEST/.git" "$DEST/src/cowrie/vendor/ja4" "$DEST/LICENSES/LicenseRef-FoxIO-1.1.txt"
if grep -rIl -e 'LicenseRef-FoxIO' -e 'generate_ja4h' -e 'cowrie.vendor.ja4' "$DEST"; then
	echo "Queda código de JA4+ con licencia FoxIO: no se construye"
	exit 1
fi
grep -q '^        recortar_evento(ev)$' "$DEST/src/cowrie/core/events.py" \
	&& grep -q 'self.outfile = RegistroDiario(' "$DEST/src/cowrie/output/jsonlog.py" \
	&& grep -q '^max_bytes_day = ' "$DEST/src/cowrie/data/etc/cowrie.cfg.dist" \
	&& grep -q 'sd-pruebas' "$DEST/docker/Dockerfile" \
	|| { echo "El parche no ha dejado el recorte, el tope de cowrie.json o sus pruebas: no se construye"; exit 1; }
echo "Cowrie $VERSION ($COMMIT), sin FoxIO y con tope en lo que apunta, en $DEST"
