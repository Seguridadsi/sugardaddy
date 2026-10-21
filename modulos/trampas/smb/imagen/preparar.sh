#!/usr/bin/env bash
#
# Prepara el contexto con el que se construye nuestra imagen de la trampa SMB
# (Carpeta compartida, H08). NO es código del todo propio: reutiliza el manejador
# SMB de glutton (github.com/mushorg/glutton, MIT), que negocia SMB1 y SMB2,
# acepta el inicio de sesión capturando usuario, dominio, equipo y el NetNTLMv2,
# deja "conectar" a sus recursos y reconoce las sondas de EternalBlue/DoublePulsar
# (MS17-010), pero no sirve ni ejecuta nada. Se monta sobre la base COMÚN de
# glutton (modulos/comun/glutton), la misma que usan RDP y MSSQL: preparar-base.sh
# descarga glutton fijado por commit y comprobado por sha256, lo recorta al
# manejador SMB, le quita hpfeeds y la capa TPROXY/pcap, le aplica
# sugardaddy.patch y le añade nuestro registro JSON con topes, y deja un módulo
# Go que compila a UN binario que escucha el 1445 interno con un listener TCP normal.
#
#   modulos/trampas/smb/imagen/preparar.sh <carpeta nueva>
set -euo pipefail
DEST="${1:?Uso: preparar.sh <carpeta nueva>}"
AQUI="$(cd "$(dirname "$0")" && pwd)"
BASE="$(cd "$AQUI/../../../comun/glutton" && pwd)"
[[ ! -e "$DEST" ]] || { echo "$DEST ya existe"; exit 1; }

# La base común deja en $DEST el módulo Go recortado a SMB, con el parche y
# nuestro código (sd/, cmd/sdtrampa, proto_smb.go, sd_shim_smb.go, licencias.sh).
"$BASE/preparar-base.sh" "$DEST" smb

# El Dockerfile lo pone la trampa (la base no construye imágenes).
cp "$AQUI/Dockerfile" "$DEST/Dockerfile"
echo "Trampa SMB (glutton MIT + base común de Sugardaddy) en $DEST"
