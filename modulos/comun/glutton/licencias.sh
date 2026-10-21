#!/bin/sh
#
# Junta en <carpeta> los avisos de licencia de todo lo que acaba DENTRO del
# binario de la trampa (estático): glutton (MIT), los módulos de Go que enlaza
# (los que dice go version -m del binario) y la biblioteca estándar y el runtime
# de Go (BSD-3-Clause). Si un módulo enlazado no trae una licencia permisiva
# reconocible (BSD, MIT o Apache 2.0), la imagen NO se construye: así nunca se
# cuela nada GPL/AGPL ni sin licencia. Corre en la etapa de compilación del
# Dockerfile, sin red (los módulos ya están en la caché de go mod download).
#
#   sh licencias.sh <binario> <carpeta> <commit>
set -eu
BIN="$1"
OUT="$2"
COMMIT="$3"
mkdir -p "$OUT/modulos" "$OUT/go"

grep -q 'Permission is hereby granted' LICENSE || { echo "El LICENSE de glutton ya no es MIT"; exit 1; }
cp LICENSE "$OUT/LICENSE"
GOROOT="$(go env GOROOT)"
cp "$GOROOT/LICENSE" "$GOROOT/PATENTS" "$OUT/go/"

cat > "$OUT/LEEME.txt" <<FIN
Trampa de Sugardaddy sobre la base común glutton
(github.com/mushorg/glutton, commit $COMMIT). Copyright (c) 2016 MushMush.
Licencia MIT: ver LICENSE en esta carpeta.

Modificada por SeguridadSI (sugardaddy.patch): se quita la capa de red
TPROXY/iptables, el productor hpfeeds (sin licencia) y spicy (cgo); el binario
escucha UN solo protocolo con un listener TCP normal y escribe eventos JSON por
línea en /registros, con topes y recortes; nunca ejecuta nada ni guarda el
contenido subido por el atacante (solo su huella SHA-256 y su tamaño).

El binario es estático. Lleva dentro:
- los módulos de Go de TERCEROS.txt, con sus avisos en modulos/;
- la biblioteca estándar y el runtime de $(go env GOVERSION), con su licencia
  y su concesión de patentes en go/.
FIN

: > "$OUT/TERCEROS.txt"
MODS="$(mktemp)"
trap 'rm -f "$MODS"' EXIT
go version -m "$BIN" | awk '$1 == "dep" || $1 == "=>" { print $1, $2, $3 }' > "$MODS"
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
done < "$MODS"
[ -s "$OUT/TERCEROS.txt" ] || { echo "go version -m no da ningún módulo: ¿binario sin información de construcción?"; exit 1; }
echo "Avisos de licencia de $(wc -l < "$OUT/TERCEROS.txt") módulos de Go en $OUT"
