#!/usr/bin/env bash
#
# Prepara el contexto con el que se construye nuestra imagen de la trampa de
# impresora de red. El código es PROPIO (no se clona nada de fuera, a
# diferencia de Cowrie o DDoSPot): se copian imagen/fuente (go.mod, el código y
# sus pruebas, que corren al construir y no entran en la imagen final) y el
# Dockerfile a una carpeta nueva, para que la construya docker build o
# az acr build (herramientas/publicar-trampa.sh).
#
#   modulos/trampas/impresora/imagen/preparar.sh <carpeta nueva>
set -euo pipefail
DEST="${1:?Uso: preparar.sh <carpeta nueva>}"
AQUI="$(cd "$(dirname "$0")" && pwd)"
[[ ! -e "$DEST" ]] || { echo "$DEST ya existe"; exit 1; }

mkdir -p "$DEST"
cp "$AQUI/fuente/go.mod" "$AQUI"/fuente/*.go "$DEST/"
# Sin dependencias: si alguien añade un require, que se note aquí.
! grep -q '^require' "$DEST/go.mod" || { echo "impresoratrampa no lleva dependencias y go.mod tiene require: no se construye"; exit 1; }
cp "$AQUI/Dockerfile" "$DEST/Dockerfile"
echo "Trampa de impresora (código propio de SeguridadSI) en $DEST"
