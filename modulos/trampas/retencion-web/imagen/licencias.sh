#!/bin/sh
#
# Junta en <carpeta> los avisos de licencia de todo lo que acaba dentro del
# binario de go-pot, que es estático: go-pot (MIT, con la Apache-2.0 de los
# esquemas de SchemaStore), internal/regen (Apache-2.0), cada módulo de Go que
# enlaza y la biblioteca estándar de Go. MIT, BSD y Apache piden que el aviso
# vaya con el binario; la MPL-2.0 (los módulos de HashiCorp), además, decir
# dónde está su código fuente. Si un módulo no trae su licencia, o trae una
# GPL o AGPL, la imagen no se construye. Corre en la etapa de compilación del
# Dockerfile, sin red: los módulos ya están en la caché, comprobados.
#
#   sh licencias.sh <carpeta> <versión> <commit>
set -eu
OUT="$1"
VERSION="$2"
COMMIT="$3"
mkdir -p "$OUT/go-pot" "$OUT/modulos" "$OUT/go"

cp LICENCE "$OUT/go-pot/LICENCE"
cp internal/regen/LICENSE.txt "$OUT/go-pot/internal-regen-LICENSE.txt"
GOROOT="$(go env GOROOT)"
cp "$GOROOT/LICENSE" "$OUT/go/LICENSE"
[ -f "$GOROOT/PATENTS" ] && cp "$GOROOT/PATENTS" "$OUT/go/PATENTS"

# tipo <ficheros...>: la licencia por su texto (para el listado; el texto
# entero va copiado al lado). La MPL va antes que la GPL: su texto nombra la
# GPL como «licencia secundaria».
tipo() {
	if grep -q 'Mozilla Public License' "$@"; then echo MPL-2.0
	elif grep -qiE 'GNU (AFFERO |LESSER )?GENERAL PUBLIC LICENSE' "$@"; then echo GPL
	elif grep -q 'Apache License' "$@"; then echo Apache-2.0
	elif grep -q 'Permission is hereby granted, free of charge' "$@"; then echo MIT
	elif grep -q 'Neither the name' "$@"; then echo BSD-3-Clause
	elif grep -q 'Redistribution and use in source and binary forms' "$@"; then echo BSD-2-Clause
	elif grep -q 'Permission to use, copy, modify, and/or distribute' "$@"; then echo ISC
	else echo desconocida
	fi
}

# Los módulos que entran en el binario (no los de pruebas ni herramientas),
# con su versión exacta y su carpeta en la caché.
go list -deps -f '{{with .Module}}{{if not .Main}}{{.Path}} {{.Version}} {{.Dir}}{{end}}{{end}}' . | sort -u > /tmp/modulos.txt
[ -s /tmp/modulos.txt ] || { echo "go list no ha dado módulos"; exit 1; }

: > "$OUT/MODULOS.txt"
mal=0
while read -r modulo version dir; do
	destino="$OUT/modulos/$modulo@$version"
	mkdir -p "$destino"
	for l in "$dir"/[Ll][Ii][Cc][Ee][Nn][CcSs][Ee]* "$dir"/COPYING* "$dir"/NOTICE* "$dir"/PATENTS* "$dir"/AUTHORS*; do
		[ -f "$l" ] && cp "$l" "$destino/"
	done
	licencias="$(find "$destino" -type f \( -iname 'licen[cs]e*' -o -iname 'copying*' \))"
	if [ -z "$licencias" ]; then
		echo "El módulo $modulo $version no trae su licencia"
		mal=1
		continue
	fi
	# shellcheck disable=SC2086
	t="$(tipo $licencias)"
	case "$t" in
	GPL | desconocida)
		echo "El módulo $modulo $version tiene una licencia no admitida ($t)"
		mal=1
		;;
	esac
	# En las URL del proxy, cada mayúscula va como ! y su minúscula.
	ruta="$(echo "$modulo" | sed 's/[A-Z]/!&/g' | tr 'A-Z' 'a-z')"
	printf '%s %s: %s; fuente: https://proxy.golang.org/%s/@v/%s.zip\n' "$modulo" "$version" "$t" "$ruta" "$version" >> "$OUT/MODULOS.txt"
done < /tmp/modulos.txt
[ "$mal" = 0 ] || exit 1

GOVERSION="$(go env GOVERSION)"
cat > "$OUT/LEEME.txt" <<FIN
Trampa retencion-web de Sugardaddy (SeguridadSI)
================================================

go-pot $VERSION (https://github.com/ryanolee/go-pot, commit $COMMIT)
Copyright (c) 2024 Ryan Lee. Licencia MIT: go-pot/LICENCE. El mismo fichero
lleva la licencia Apache-2.0 de los esquemas de SchemaStore que usa para
inventar ficheros de configuración. internal/regen es Apache-2.0:
go-pot/internal-regen-LICENSE.txt.

Modificado por SeguridadSI: protocol/http/server.go sustituido por una
versión propia (Immutable, ReadTimeout, Concurrency y BodyLimit en Fiber,
límite de conexiones por IP y en total, respuestas de error con su código y
apuntadas, robots.txt propio de cada trampa); proxy_header vacío y
telemetría apagada por defecto; campo src_port, numérico; hora en RFC 3339;
duración en segundos; sin campos vacíos, sin caller, sin el analizador de
User-Agent ni el muestreo del registro; formato INI para .env, .git/config y
credenciales; cachés del TimeoutWatcher con máximo de entradas; 24 de los 332
esquemas; y un destino de registro propio (rotar.go: rotación diaria, tope de
bytes por día repartido por IP y resúmenes de lo que se calla). El código
nuevo (rotar.go, cupos.go, formato.go, robots.go, cache_acotada.go) es de
SeguridadSI.

El binario es estático y lleva dentro:
- Los módulos de Go de MODULOS.txt, en esa versión exacta, con el texto de su
  licencia en modulos/<módulo>@<versión>/.
- La biblioteca estándar de Go ($GOVERSION), BSD-3-Clause: go/LICENSE.

Los módulos con licencia MPL-2.0 (de HashiCorp: memberlist, hcl y sus
dependencias) van sin modificar. Su código fuente es el de esa versión exacta,
en la URL que da MODULOS.txt para cada uno (el proxy de módulos de Go) y en el
repositorio de su proyecto. Según la MPL-2.0, también se puede pedir a
SeguridadSI.
FIN
echo "Avisos de licencia de $(wc -l < "$OUT/MODULOS.txt") módulos en $OUT"
