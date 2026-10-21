#!/usr/bin/env bash
#
# Prepara el contexto con el que se construye nuestra imagen de la trampa RDP
# (Escritorio remoto, H06). NO es código del todo propio: reutiliza el manejador
# RDP de glutton (github.com/mushorg/glutton, MIT), que hace X.224 con cookie
# mstshash, termina TLS con un certificado con la forma del de un Windows real y
# completa CredSSP/NLA capturando usuario, dominio, equipo y el NetNTLMv2 (y la
# contraseña en claro si se acepta el login o si llega por el Client Info sin
# cifrar). Se monta sobre la base COMÚN de glutton (modulos/comun/glutton), la
# misma que usan SMB y MSSQL: preparar-base.sh descarga glutton fijado por
# commit y comprobado por sha256, lo recorta al manejador RDP, le quita hpfeeds
# y la capa TPROXY/pcap, sustituye viper por configuración por entorno
# (sd_config.go), le añade el certificado por instancia y nuestro registro JSON
# con topes, y deja un módulo Go que compila a UN binario que escucha el 3389
# con un listener TCP normal.
#
#   modulos/trampas/rdp/imagen/preparar.sh <carpeta nueva>
set -euo pipefail
DEST="${1:?Uso: preparar.sh <carpeta nueva>}"
AQUI="$(cd "$(dirname "$0")" && pwd)"
BASE="$(cd "$AQUI/../../../comun/glutton" && pwd)"
[[ ! -e "$DEST" ]] || { echo "$DEST ya existe"; exit 1; }

# La base común deja en $DEST el módulo Go recortado a RDP, con el parche y
# nuestro código (sd/, cmd/sdtrampa, proto_rdp.go, sd_config.go, licencias.sh).
"$BASE/preparar-base.sh" "$DEST" rdp

# preparar-base.sh copia TODOS los mapeadores de sd/ (SMB, MSSQL y RDP) porque
# es común a las tres trampas. La imagen RDP solo necesita el suyo, y su
# Dockerfile corre "go test ./...": sin esto, una edición en curso de otro
# agente en mapa_smb.go o mapa_mssql.go (o una prueba suya rota) tiraba el build
# de RDP en un árbol compartido, aunque la trampa RDP no hubiera cambiado. Se
# quitan los mapeadores y pruebas de los otros protocolos para que la imagen RDP
# compile y pruebe SOLO lo suyo. El registro JSON sigue siendo compatible; el
# binario RDP solo registra el mapeador "rdp".
rm -f "$DEST/sd/mapa_smb.go" "$DEST/sd/mapa_smb_test.go" \
	"$DEST/sd/mapa_mssql.go" "$DEST/sd/mapa_mssql_test.go"

# El Dockerfile lo pone la trampa (la base no construye imágenes).
cp "$AQUI/Dockerfile" "$DEST/Dockerfile"
echo "Trampa RDP (glutton MIT + base común de Sugardaddy) en $DEST"
