#!/usr/bin/env bash
#
# Prueba el asistente de instalación (despliegue/nodo/asistente.sh) sin instalar
# nada: en un contenedor Ubuntu, en modo texto, contestando por la entrada
# estándar y con un instalar.sh falso que solo apunta con qué lo llamaron.
#
#   despliegue/nodo/pruebas/probar-asistente.sh
#
# Mira que los datos llegan al instalador tal cual, que lo que no vale se vuelve
# a preguntar, que cancelar no llama a nada, que una máquina que no sirve se
# dice antes de preguntar y que reinstalar encima propone lo que ya había.
set -uo pipefail

if [[ -z "${DENTRO:-}" ]]; then
	AQUI="$(cd "$(dirname "$0")" && pwd)"
	exec docker run --rm --platform linux/amd64 -e DENTRO=1 -v "$AQUI/..:/fuente:ro" ubuntu:24.04 \
		bash /fuente/pruebas/probar-asistente.sh
fi

T="$(mktemp -d)"
cp /fuente/asistente.sh "$T/"
: > "$T/imagenes.env"
cat > "$T/instalar-falso.sh" <<'FIN'
#!/usr/bin/env bash
{
	printf 'args=%s|%s|%s|%s\n' "$@"
	echo "puerto=${CONSOLA_PUERTO:-}"
	echo "acceso=${CONSOLA_ACCESO:-}"
	echo "local=${LOGIN_LOCAL:-}"
} > "$LLAMADA"
echo "Node running. Console at https://falso"
FIN
# Un Docker que contesta, con Compose, en amd64: el contenedor no trae ninguno.
mkdir "$T/bin"
cat > "$T/bin/docker" <<'FIN'
#!/usr/bin/env bash
case "$*" in
"version --format {{.Server.Os}}/{{.Server.Arch}}") echo "${DOCKER_PLATAFORMA:-linux/amd64}" ;;
"version --format {{.Server.Version}}") echo 27.0.0 ;;
*) exit 0 ;;
esac
FIN
printf '#!/bin/sh\nexit 0\n' > "$T/bin/openssl"
chmod +x "$T/bin/docker" "$T/bin/openssl"
export PATH="$T/bin:$PATH" ASISTENTE_SIMPLE=1 ASISTENTE_INSTALADOR="$T/instalar-falso.sh" LLAMADA="$T/llamada"

fallos=0
caso() { echo "--- $1"; rm -f "$LLAMADA"; }
espera() { # descripción, condición ya evaluada
	if [[ "$2" == 0 ]]; then
		echo "    bien: $1"
	else
		echo "    FALLO: $1"
		fallos=$((fallos + 1))
		sed 's/^/      | /' "$T/salida" 2>/dev/null | tail -25
	fi
}
tiene() { grep -qF -- "$2" "$1"; echo $?; }

caso "instalación nueva con todos los datos"
printf '%s\n' /opt/sd-prueba 'Grupo Aldanza' nodo-mad01 consola.aldanza.local 10.0.0.0/24,192.168.1.20 y \
	| bash "$T/asistente.sh" > "$T/salida" 2>&1
espera "acaba bien" "$?"
espera "llama al instalador con los cuatro datos" "$(tiene "$LLAMADA" 'args=/opt/sd-prueba|nodo-mad01|Grupo Aldanza|consola.aldanza.local')"
espera "pasa la lista de acceso" "$(tiene "$LLAMADA" 'acceso=10.0.0.0/24,192.168.1.20')"
espera "puerto 443 si está libre" "$(tiene "$LLAMADA" 'puerto=443')"
espera "enciende la entrada con contraseña si no hay Entra" "$(tiene "$LLAMADA" 'local=1')"
espera "enseña el resumen antes de instalar" "$(tiene "$T/salida" 'This is what will be installed:')"
espera "dice qué viene después" "$(tiene "$T/salida" 'The console then guides you')"

caso "valores propuestos: basta con el nombre de la empresa"
printf '%s\n' '' 'Talleres Pérez & Hijos' '' 10.1.2.3 '' y | bash "$T/asistente.sh" > "$T/salida" 2>&1
espera "acaba bien" "$?"
espera "carpeta por defecto e identificador sacado del nombre" "$(tiene "$LLAMADA" 'args=/opt/sugardaddy|node-talleres-p-rez-hijos|Talleres Pérez & Hijos|10.1.2.3')"
espera "sin lista: el acceso se decide al entrar" "$(tiene "$LLAMADA" 'acceso=')"

caso "lo que no vale se vuelve a preguntar"
printf '%s\n' relativa /opt/sd 'Mi "empresa"' 'Mi empresa' 'Nodo Malo' nodo-ok 'https://consola' consola.local 'no es una ip' 10.0.0.5 y \
	| bash "$T/asistente.sh" > "$T/salida" 2>&1
espera "acaba bien" "$?"
espera "se queda con los valores buenos" "$(tiene "$LLAMADA" 'args=/opt/sd|nodo-ok|Mi empresa|consola.local')"
espera "y con la IP buena" "$(tiene "$LLAMADA" 'acceso=10.0.0.5')"

caso "cancelar en el resumen no instala nada"
set +e
printf '%s\n' /opt/sd 'Mi empresa' nodo-ok consola.local '' n | bash "$T/asistente.sh" > "$T/salida" 2>&1
r=$?
set -e
espera "sale con error" "$([[ $r != 0 ]]; echo $?)"
espera "no llama al instalador" "$([[ ! -e "$LLAMADA" ]]; echo $?)"
espera "dice que no ha cambiado nada" "$(tiene "$T/salida" 'Nothing was changed on this machine')"

caso "una máquina que no es amd64 se dice antes de preguntar"
set +e
DOCKER_PLATAFORMA=linux/arm64 bash "$T/asistente.sh" < /dev/null > "$T/salida" 2>&1
r=$?
set -e
espera "sale con error" "$([[ $r != 0 ]]; echo $?)"
espera "explica el motivo" "$(tiene "$T/salida" 'needs a Linux x86_64 (amd64) machine')"
espera "no pregunta nada" "$([[ "$(tiene "$T/salida" 'Folder where the node will live')" != 0 ]]; echo $?)"
espera "no llama al instalador" "$([[ ! -e "$LLAMADA" ]]; echo $?)"

caso "con Entra en el entorno no se enciende la entrada con contraseña"
printf '%s\n' /opt/sd 'Mi empresa' nodo-ok consola.local '' y \
	| ENTRA_TENANT_ID=11111111-1111-1111-1111-111111111111 bash "$T/asistente.sh" > "$T/salida" 2>&1
espera "acaba bien" "$?"
espera "entrada local sin tocar" "$(grep -qx 'local=' "$LLAMADA"; echo $?)"

caso "el puerto 443 ocupado: se pide otro"
apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq iproute2 python3 >/dev/null 2>&1 || true
if command -v python3 >/dev/null && command -v ss >/dev/null; then
	python3 -c 'import socket,time; s=socket.socket(); s.bind(("0.0.0.0",443)); s.listen(); time.sleep(60)' &
	oyente=$!
	sleep 1
	printf '%s\n' /opt/sd 'Mi empresa' nodo-ok consola.local '' '' y | bash "$T/asistente.sh" > "$T/salida" 2>&1
	espera "acaba bien" "$?"
	espera "avisa de que está en uso" "$(tiene "$T/salida" 'Port 443 is already in use')"
	espera "instala en el 8443 propuesto" "$(tiene "$LLAMADA" 'puerto=8443')"
	kill "$oyente" 2>/dev/null || true
else
	echo "    (sin red para instalar iproute2 y python3: caso saltado)"
fi

caso "reinstalar encima: propone lo que ya había y no pregunta lo demás"
mkdir -p /opt/sd-ya
cat > /opt/sd-ya/.env <<'FIN'
NODO_ID=nodo-viejo
NODO_NOMBRE="Empresa de antes"
CONSOLA_DOMINIO=consola.antes.local
CONSOLA_PUERTO=8443
FIN
printf '%s\n' /opt/sd-ya '' y | bash "$T/asistente.sh" > "$T/salida" 2>&1
espera "acaba bien" "$?"
espera "avisa de que se actualiza" "$(tiene "$T/salida" 'already holds a node (nodo-viejo)')"
espera "conserva nodo, empresa, dirección y puerto" "$(tiene "$LLAMADA" 'args=/opt/sd-ya|nodo-viejo|Empresa de antes|consola.antes.local')"
espera "con su puerto" "$(tiene "$LLAMADA" 'puerto=8443')"

caso "sin imagenes.env ni forma de construirlas"
rm "$T/imagenes.env"
set +e
bash "$T/asistente.sh" < /dev/null > "$T/salida" 2>&1
r=$?
set -e
espera "sale con error" "$([[ $r != 0 ]]; echo $?)"
espera "dice qué falta" "$(tiene "$T/salida" 'imagenes.env is missing')"

echo
if [[ $fallos == 0 ]]; then echo "BIEN: el asistente de instalación"; else echo "FALLOS: $fallos"; exit 1; fi
