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
# SEN-8: identidad del sistema simulado por semilla (ver parche.py, punto 4).
install -m 0644 "$AQUI/sugardaddy_fs.py" "$DEST/src/cowrie/core/sugardaddy_fs.py"
mkdir "$DEST/sd-pruebas"
install -m 0644 "$AQUI"/pruebas/*.py "$DEST/sd-pruebas/"
# Árboles propios por plantilla de sistema (los embebidos con marcadores
# __SD_*__): el Dockerfile monta encima el rootfs real y createfs los convierte
# en fs-<plantilla>.pickle. Y los txtcmds df/lscpu propios (sin el UUID fijo ni
# el E5-2680 de serie), con marcadores que se sustituyen al arrancar.
cp -R "$AQUI/fs" "$DEST/sd-fs"
install -m 0644 "$AQUI/txtcmds/bin/df" "$DEST/src/cowrie/data/txtcmds/bin/df"
install -m 0644 "$AQUI/txtcmds/usr/bin/lscpu" "$DEST/src/cowrie/data/txtcmds/usr/bin/lscpu"
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
# SEN-8: la identidad por semilla (fs por plantilla, txtcmds sin el UUID fijo ni
# el E5-2680, y los enganches en honeyfs/protocol/ifconfig), y el KEXINIT a
# juego con el OpenSSH del banner (factory lee [ssh] kex).
if grep -rIl -e '65626fdc-e4c5-4539-8745-edc212b9b0af' -e 'E5-2680' -e 'Intel(R) Xeon(R) CPU E5-2680' "$DEST/src/cowrie/data/txtcmds"; then
	echo "SEN-8: quedan delatores en los txtcmds de serie: no se construye"
	exit 1
fi
grep -q '__SD_FS_UUID__' "$DEST/src/cowrie/data/txtcmds/bin/df" \
	&& grep -q '__SD_CPU_MODEL__' "$DEST/src/cowrie/data/txtcmds/usr/bin/lscpu" \
	&& [[ -f "$DEST/src/cowrie/core/sugardaddy_fs.py" ]] \
	&& [[ -f "$DEST/sd-fs/debian-12/overlay/proc/cpuinfo" ]] \
	&& [[ -f "$DEST/sd-fs/ubuntu-22/overlay/proc/cpuinfo" ]] \
	&& grep -q 'sustituir_bytes' "$DEST/src/cowrie/shell/protocol.py" \
	&& grep -q 'personalizar_arbol' "$DEST/src/cowrie/shell/honeyfs.py" \
	&& grep -q '"ssh", "kex"' "$DEST/src/cowrie/ssh/factory.py" \
	&& grep -q 'createfs.py' "$DEST/docker/Dockerfile" \
	|| { echo "SEN-8: falta alguna pieza de la identidad por semilla: no se construye"; exit 1; }
# La nota para agentes de IA: el AGENTS.md del home del usuario (con el marcador
# del valor de la instancia) y la marca de los eventos de comando tras el recorte.
grep -q '^            marcar_agente(ev, token_nota())$' "$DEST/src/cowrie/core/events.py" \
	&& grep -q 'def marcar_agente(' "$DEST/src/cowrie/core/sugardaddy.py" \
	&& grep -q 'def token_nota(' "$DEST/src/cowrie/core/sugardaddy_fs.py" \
	&& grep -q '/sdroot/home/__SD_USER__/AGENTS.md' "$DEST/docker/Dockerfile" \
	&& grep -q -- '--agent __SD_AGENT_TOKEN__' "$DEST/docker/Dockerfile" \
	|| { echo "Falta alguna pieza de la nota para agentes de IA: no se construye"; exit 1; }
# Quién hay al otro lado: la versión del cliente junto a su huella y el ritmo de
# la sesión (parche.py, punto 8).
grep -q '^            seguir_sesion(ev)$' "$DEST/src/cowrie/core/events.py" \
	&& grep -q 'def seguir_sesion(' "$DEST/src/cowrie/core/sugardaddy.py" \
	&& grep -q 'def anotar_tecla(' "$DEST/src/cowrie/core/sugardaddy.py" \
	&& grep -q 'self._sd_tecla(borrado=True)' "$DEST/src/cowrie/shell/protocol.py" \
	|| { echo "Falta alguna pieza del ritmo de la sesión: no se construye"; exit 1; }
echo "Cowrie $VERSION ($COMMIT), sin FoxIO, con tope en lo que apunta, sin huellas de serie (SEN-8) y con la nota para agentes de IA, en $DEST"
