#!/bin/sh
#
# Junta en <carpeta> los avisos de licencia de todo lo que acaba dentro del
# binario de DDoSPot, que es estático: el propio DDoSPot (MIT), los módulos de
# Go que enlaza (los que dice go version -m del binario) y la biblioteca
# estándar y el runtime de Go. MIT y BSD piden que el aviso vaya con el
# binario. Si un módulo no trae una licencia permisiva reconocible (BSD, MIT o
# Apache 2.0), la imagen no se construye. Corre en la etapa de compilación del
# Dockerfile, sin red: los módulos ya están en la caché (go mod download).
#
#   sh licencias.sh <binario> <carpeta> <versión> <commit>
set -eu
BIN="$1"
OUT="$2"
VERSION="$3"
COMMIT="$4"
mkdir -p "$OUT/modulos" "$OUT/go"

grep -q 'Permission is hereby granted' LICENSE || { echo "El LICENSE de DDoSPot ya no es MIT"; exit 1; }
cp LICENSE "$OUT/LICENSE"
GOROOT="$(go env GOROOT)"
cp "$GOROOT/LICENSE" "$GOROOT/PATENTS" "$OUT/go/"

cat > "$OUT/LEEME.txt" <<FIN
DDoSPot $VERSION (https://github.com/telekom-security/ddospot, commit $COMMIT)
Copyright (c) 2020 aelth y (c) 2026 Telekom Security. Licencia MIT: ver LICENSE
en esta carpeta.

Modificado por SeguridadSI para la trampa dns-ntp de Sugardaddy: recursión
imposible; fuera de las redes internas declaradas (DDOSPOT_INTERNAL_NETS),
ninguna respuesta UDP más grande que su petición y version.bind con REFUSED
(salvo DDOSPOT_PUBLIC_AMPLIFICATION=on); un solo registro JSON por líneas,
rotado por días, con tope de bytes diario repartido entre clases de línea y
orígenes y un resumen por minuto de lo que se calla; una línea por petición;
persona fija y distinta por instancia; presupuestos para direcciones privadas
y tablas más pequeñas.

El binario es estático. Lleva dentro:
- los módulos de Go de TERCEROS.txt, con sus avisos en modulos/;
- la biblioteca estándar y el runtime de $(go env GOVERSION), con su licencia
  y su concesión de patentes en go/.
FIN

: > "$OUT/TERCEROS.txt"
go version -m "$BIN" | awk '$1 == "dep" || $1 == "=>" { print $1, $2, $3 }' > /tmp/modulos.txt
while read -r tipo modulo version; do
	[ "$tipo" = dep ] || { echo "Módulo reemplazado en el binario ($modulo $version): revísalo a mano"; exit 1; }
	dir="$(go list -m -f '{{.Dir}}' "$modulo")"
	[ "$(go list -m -f '{{.Version}}' "$modulo")" = "$version" ] || { echo "$modulo: la versión enlazada no es la de go.mod"; exit 1; }
	[ -n "$dir" ] && [ -d "$dir" ] || { echo "No están las fuentes de $modulo $version"; exit 1; }
	destino="$OUT/modulos/$(echo "$modulo@$version" | tr '/' '_')"
	mkdir -p "$destino"
	for f in "$dir"/LICENSE* "$dir"/LICENCE* "$dir"/COPYING* "$dir"/COPYRIGHT* "$dir"/NOTICE* "$dir"/PATENTS* "$dir"/AUTHORS*; do
		[ -f "$f" ] && cp "$f" "$destino/"
	done
	texto="$(cat "$destino"/LICEN* 2>/dev/null || true)"
	case "$texto" in
	*"Redistribution and use in source and binary forms"*"Neither the name"*) licencia=BSD-3-Clause ;;
	*"Redistribution and use in source and binary forms"*) licencia=BSD-2-Clause ;;
	*"Permission is hereby granted, free of charge"*) licencia=MIT ;;
	*"Apache License"*"Version 2.0"*) licencia=Apache-2.0 ;;
	*) echo "$modulo $version no trae una licencia permisiva reconocible: no se construye"; exit 1 ;;
	esac
	printf '%s %s: %s\n' "$modulo" "$version" "$licencia" >> "$OUT/TERCEROS.txt"
done < /tmp/modulos.txt
[ -s "$OUT/TERCEROS.txt" ] || { echo "go version -m no da ningún módulo: ¿binario sin información de construcción?"; exit 1; }
echo "Avisos de licencia de $(wc -l < "$OUT/TERCEROS.txt") módulos de Go en $OUT"
