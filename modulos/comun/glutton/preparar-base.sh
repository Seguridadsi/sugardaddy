#!/usr/bin/env bash
#
# Base COMÚN de glutton para las trampas de Sugardaddy (SMB, MSSQL, y más
# adelante RDP). Descarga glutton (github.com/mushorg/glutton, MIT) FIJADO por commit
# y comprobado por sha256 del tarball, lo recorta a lo que usa el protocolo
# pedido, le aplica sugardaddy.patch y le añade nuestro código (sd/ y
# cmd/sdtrampa), de modo que el resultado es un módulo Go que se compila a UN
# solo binario que escucha UN solo protocolo en su puerto interno con un
# listener TCP normal: sin TPROXY, sin iptables, sin --network host y sin
# NET_ADMIN. El binario registra JSON por línea en /registros/<modulo>.json con
# nuestros campos, recortes y topes; nunca ejecuta nada ni guarda sin límite lo
# que suba el atacante (como mucho huella y tamaño).
#
# Lo que se QUITA del árbol de glutton (y por tanto del binario): la capa de red
# TPROXY/iptables (iptables.go, tproxy_listen.go, rules → pcap/cgo), el productor
# hpfeeds (sin licencia), spicy (cgo), scanner, el resto de manejadores y toda
# su app/config. Así no queda ninguna dependencia GPL/AGPL ni sin licencia; el
# binario solo enlaza glutton (MIT), golang.org/x/crypto (BSD-3) y la biblioteca
# estándar de Go (BSD-3). Se comprueba en cada construcción con licencias.sh.
#
#   modulos/comun/glutton/preparar-base.sh <carpeta nueva> <protocolo>
#
# <protocolo>: smb, mssql, rdp, vnc. Cada protocolo recorta el árbol a SUS
# ficheros, aplica SU parche (sugardaddy-<proto>.patch), copia SU shim y SOLO
# su mapeador (sd/mapa_<proto>.go); así un protocolo no arrastra las
# dependencias ni el código de otro (p. ej. MSSQL no trae rdp/viper, SMB no trae
# el manejador MSSQL y ningún binario compila el mapeador de otra trampa).
set -euo pipefail

COMMIT=4dfac5b9a9bb7101a7564991a25ecca2dbbce400
SHA256=e1a6cd9225d5695c99ac6c03612ea4072d7bb93d460796cd8ff4b56694524803
URL="https://codeload.github.com/mushorg/glutton/tar.gz/${COMMIT}"

DEST="${1:?Uso: preparar-base.sh <carpeta nueva> <protocolo>}"
PROTO="${2:?Uso: preparar-base.sh <carpeta nueva> <protocolo>}"
AQUI="$(cd "$(dirname "$0")" && pwd)"
[[ ! -e "$DEST" ]] || { echo "$DEST ya existe"; exit 1; }

case "$PROTO" in
smb|mssql|rdp|vnc) ;;
*) echo "Protocolo desconocido: $PROTO"; exit 1 ;;
esac

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
TAR="$TMP/glutton.tar.gz"

# Descarga fijada por commit y comprobada por sha256 del tarball. Si GitHub
# cambiara el empaquetado, la huella no cuadra y no se construye (hay que
# re-fijar a conciencia).
curl -fsSL -o "$TAR" "$URL"
echo "${SHA256}  ${TAR}" | shasum -a 256 -c - >/dev/null \
	|| { echo "La huella sha256 del tarball de glutton no cuadra con la fijada"; exit 1; }

mkdir -p "$DEST"
tar -xzf "$TAR" -C "$DEST" --strip-components=1

# Licencia: si deja de ser MIT, no se construye.
head -n 1 "$DEST/LICENSE" | grep -qx 'The MIT License (MIT)' && grep -q 'Permission is hereby granted' "$DEST/LICENSE" \
	|| { echo "El LICENSE de glutton ya no es MIT"; exit 1; }

cd "$DEST"

# --- Recorte: fuera todo lo que no usa la base ---
# Capa de red (TPROXY/iptables/pcap), productor hpfeeds, scanner, spicy (cgo),
# app/config, documentación y ficheros sueltos del repo.
rm -rf producer scanner rules protocols/spicy protocols/udp app config docs scripts
rm -f iptables.go iptables_test.go tproxy_listen.go glutton.go glutton_test.go \
	server.go server_start_test.go server_test.go system.go system_test.go \
	Makefile Dockerfile Dockerfile.local mkdocs.yml event.json AGENTS.md CONTRIBUTING.md README.md
# El despachador del paquete padre protocols/ y el test de conexión (gopacket).
rm -f protocols/protocols.go protocols/tls.go protocols/peek.go protocols/peek_test.go protocols/protocols_test.go protocols/*_dispatch_test.go
rm -f connection/connection_test.go

# En el paquete tcp, dejar solo los manejadores del protocolo pedido. Cada
# protocolo conserva su manejador (fichero suelto) y su subpaquete; el resto se
# va, para no arrastrar dependencias de otros manejadores (rdp→viper, sip→gosip…).
( cd protocols/tcp
  case "$PROTO" in
  smb)
    for d in */; do case "$d" in smb/) ;; *) rm -rf "$d";; esac; done
    for f in *.go; do case "$f" in smb.go|smb_test.go|smb_doublepulsar_test.go) ;; *) rm -f "$f";; esac; done
    ;;
  mssql)
    # Solo el manejador MSSQL y su subpaquete mssql/. Se quita el test de
    # upstream (mssql_test.go), atado a rdp.Identity() y a mustDecodeHex de
    # rdp_test.go: sus pruebas van adaptadas al parche en sd_mssql_test.go,
    # junto con las propias de Sugardaddy (topes por sesión, NTLM, versión).
    for d in */; do case "$d" in mssql/) ;; *) rm -rf "$d";; esac; done
    for f in *.go; do case "$f" in mssql.go) ;; *) rm -f "$f";; esac; done
    ;;
  rdp)
    # Solo el manejador RDP y su subpaquete rdp/ (X.224, TLS, CredSSP/NLA,
    # NTLM). Se conserva su test de upstream (rdp_test.go): el parche lo adapta
    # a la configuración por entorno de Sugardaddy (sd_config.go) en vez de viper.
    for d in */; do case "$d" in rdp/) ;; *) rm -rf "$d";; esac; done
    for f in *.go; do case "$f" in rdp.go|rdp_test.go) ;; *) rm -f "$f";; esac; done
    ;;
  vnc)
    # Solo el manejador RFB/VNC y su subpaquete rfb/ (RFB 3.3/3.7/3.8, reto VNC,
    # escritorio estático). Se conserva su test de upstream (rfb_test.go): el
    # parche solo le quita el productor hpfeeds, así que sus pruebas siguen
    # valiendo contra el arnés común (sd_harness_test.go).
    for d in */; do case "$d" in rfb/) ;; *) rm -rf "$d";; esac; done
    for f in *.go; do case "$f" in rfb.go|rfb_test.go) ;; *) rm -f "$f";; esac; done
    ;;
  esac
)

# --- Parche a los ficheros que quedan de glutton ---
# Sin productor hpfeeds (se usa slog), sin volcado a disco de lo subido (solo
# huella y tamaño), captura de NTLMv2, e identidad (nombre/dominio) ajustable.
# Cada protocolo tiene su parche, que toca solo SUS ficheros (ya recortados).
case "$PROTO" in
smb)   PARCHE="$AQUI/sugardaddy.patch" ;;
mssql) PARCHE="$AQUI/sugardaddy-mssql.patch" ;;
rdp)   PARCHE="$AQUI/sugardaddy-rdp.patch" ;;
vnc)   PARCHE="$AQUI/sugardaddy-vnc.patch" ;;
esac
git apply --whitespace=nowarn "$PARCHE" 2>/dev/null \
	|| patch -p1 < "$PARCHE"

# Comprobaciones de que el parche hizo su efecto (si no, no se construye).
case "$PROTO" in
smb)
	grep -q 'var smbStore = func' protocols/tcp/smb.go || { echo "El parche no neutralizó el volcado a disco de SMB"; exit 1; }
	! grep -q 'mushorg/glutton/producer' protocols/tcp/smb.go || { echo "El parche no quitó la dependencia hpfeeds (producer)"; exit 1; }
	grep -q 'func SetIdentity' protocols/tcp/smb/smb.go || { echo "El parche no dejó la identidad ajustable"; exit 1; }
	;;
mssql)
	! grep -q 'mushorg/glutton/producer' protocols/tcp/mssql.go || { echo "El parche no quitó la dependencia hpfeeds (producer) de MSSQL"; exit 1; }
	! grep -q 'tcp/rdp' protocols/tcp/mssql.go || { echo "El parche no quitó la dependencia rdp (viper) de MSSQL"; exit 1; }
	grep -q 'func mssqlIdentity' protocols/tcp/mssql.go || { echo "El parche no dejó la identidad MSSQL ajustable"; exit 1; }
	grep -q 'maxMSSQLMessageLen = 8 \* 1024' protocols/tcp/mssql.go || { echo "El parche no bajó el tope de mensaje MSSQL"; exit 1; }
	grep -q 'if len(msg.Raw)+n > maxLen' protocols/tcp/mssql/tds.go || { echo "El parche no adelantó el tope de ReadMessage"; exit 1; }
	;;
rdp)
	! grep -q 'mushorg/glutton/producer' protocols/tcp/rdp.go || { echo "El parche no quitó la dependencia hpfeeds (producer) de RDP"; exit 1; }
	! grep -q 'spf13/viper' protocols/tcp/rdp/*.go || { echo "El parche no quitó la dependencia viper de RDP"; exit 1; }
	grep -q 'rdp.CertificadoSD' protocols/tcp/rdp.go || { echo "El parche no dejó el certificado por instancia (CertificadoSD) en RDP"; exit 1; }
	;;
vnc)
	! grep -q 'mushorg/glutton/producer' protocols/tcp/rfb.go || { echo "El parche no quitó la dependencia hpfeeds (producer) de VNC"; exit 1; }
	grep -q 'slog.Any("error", err)' protocols/tcp/rfb.go || { echo "El parche no sustituyó producer.ErrAttr por slog.Any en VNC"; exit 1; }
	grep -q 'if !rfbAuthCheck(challenge, data)' protocols/tcp/rfb.go || { echo "El parche no dejó que VNC rechace las contraseñas que no son la sembrada"; exit 1; }
	grep -q 'if !rfbIsOffered(chosen)' protocols/tcp/rfb.go || { echo "El parche no dejó que VNC rechace un tipo de seguridad no ofrecido"; exit 1; }
	;;
esac

# --- Nuestro código (sobrescribe/añade) ---
cp "$AQUI/base/connection/connection.go" connection/connection.go
# El shim del paquete tcp es por protocolo (identidad y topes de SMB, de MSSQL…).
# RDP no necesita shim: su identidad y su certificado van en el subpaquete rdp
# (sd_config.go), así que no hay sd_shim_rdp.go.
if [[ -f "$AQUI/base/protocols/tcp/sd_shim_${PROTO}.go" ]]; then
	cp "$AQUI/base/protocols/tcp/sd_shim_${PROTO}.go" "protocols/tcp/sd_shim_${PROTO}.go"
fi
cp "$AQUI/base/protocols/tcp/sd_harness_test.go" protocols/tcp/sd_harness_test.go
case "$PROTO" in
smb)
	# Pruebas propias del manejador SMB: tope de memoria por conexión y global,
	# presupuesto de bytes y robustez ante longitudes enormes/marcos malformados.
	cp "$AQUI/base/protocols/tcp/sd_smb_test.go" protocols/tcp/sd_smb_test.go
	;;
mssql)
	# Pruebas del manejador (las de upstream adaptadas y las propias) y del
	# subpaquete TDS parcheado (topes, longitudes, sysname).
	cp "$AQUI/base/protocols/tcp/sd_mssql_test.go" protocols/tcp/sd_mssql_test.go
	cp "$AQUI/base/protocols/tcp/mssql/sd_tds_test.go" protocols/tcp/mssql/sd_tds_test.go
	;;
rdp)
	# Configuración por entorno (sustituta de viper) y certificado por instancia.
	cp "$AQUI/base/protocols/tcp/rdp/sd_config.go" protocols/tcp/rdp/sd_config.go
	cp "$AQUI/base/protocols/tcp/rdp/sd_config_test.go" protocols/tcp/rdp/sd_config_test.go
	# Prueba propia del tope de memoria por marco del manejador RDP.
	cp "$AQUI/base/protocols/tcp/sd_rdp_test.go" protocols/tcp/sd_rdp_test.go
	;;
vnc)
	# Pruebas propias del manejador RFB parcheado: solo la contraseña sembrada
	# abre el escritorio, None se puede dejar de ofrecer, datos cortos o raros.
	cp "$AQUI/base/protocols/tcp/sd_rfb_test.go" protocols/tcp/sd_rfb_test.go
	;;
esac
mkdir -p sd cmd/sdtrampa
# De sd/ va lo común (registro, topes, rechazos, configuración, honeypot) y SOLO
# el mapeador del protocolo pedido (mapa_<proto>.go y su prueba): el binario de
# una trampa no compila ni prueba los mapeadores de las demás, así que una
# edición en curso en el de otra no le tira el build.
for f in "$AQUI/base/sd/"*.go; do
	case "$(basename "$f")" in
	mapa_*) ;;
	*) cp "$f" sd/ ;;
	esac
done
cp "$AQUI/base/sd/mapa_${PROTO}.go" sd/
if [[ -f "$AQUI/base/sd/mapa_${PROTO}_test.go" ]]; then
	cp "$AQUI/base/sd/mapa_${PROTO}_test.go" sd/
fi
cp "$AQUI/base/cmd/sdtrampa/main.go" cmd/sdtrampa/main.go
# Prueba del candado: que el módulo a exigir salga del protocolo compilado y no
# de SD_GLUTTON_MODULE. Corre en el go test ./... de la construcción.
cp "$AQUI/base/cmd/sdtrampa/main_test.go" cmd/sdtrampa/main_test.go
cp "$AQUI/base/proto/proto_${PROTO}.go" "cmd/sdtrampa/proto_${PROTO}.go"
# La edición community no trae el candado de pago (el verificador de licencia es
# del núcleo privado): el main de community ya no lo importa, así que no se copia
# ningún verificador.
cp "$AQUI/licencias.sh" licencias.sh

# --- go.mod a lo mínimo que de verdad se compila ---
# Tras el recorte, solo quedan golang.org/x/crypto (BSD-3) y, para las pruebas,
# testify y sus dependencias; nada GPL/AGPL. go mod tidy deja go.mod/go.sum
# ajustados a eso (versiones del commit fijado).
GOFLAGS=-mod=mod GOTOOLCHAIN=local go mod tidy

echo "glutton $COMMIT (sha256 OK) recortado a '$PROTO' con sugardaddy.patch y sd/ en $DEST"
