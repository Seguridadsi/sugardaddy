#!/usr/bin/env bash
#
# Prepara el contexto con el que se construye nuestra imagen de la trampa
# dns-ntp: DDoSPot v2.0.1 (Telekom Security, MIT), comprobado por su commit,
# con sugardaddy.patch y nuestros Dockerfile y licencias.sh. El parche:
# recursión imposible; freno a la amplificación (fuera de las redes internas
# declaradas, ninguna respuesta UDP más grande que su petición, y las
# preguntas CHAOS como version.bind con REFUSED por UDP y por TCP); un solo
# registro JSON por líneas legible por el sensor, rotado por días, con tope de
# bytes diario repartido entre UDP, TCP y ráfagas y por origen, y una línea
# por minuto con lo que se calla; una línea por petición; persona fija y
# distinta en cada instancia; orígenes de redes bloqueadas también apuntados;
# presupuestos mayores para orígenes privados y tablas más pequeñas; y los
# puertos de dentro leídos del entorno (DDOSPOT_*_PORT), para escuchar en
# 1024 o más sin root ni capacidades.
#
#   modulos/trampas/dns-ntp/imagen/preparar.sh <carpeta nueva>
#   docker build <carpeta nueva>
set -euo pipefail
VERSION=v2.0.1
COMMIT=84dae58c6045453c9a4b6d315e2ca12885776d82
DEST="${1:?Uso: preparar.sh <carpeta nueva>}"
AQUI="$(cd "$(dirname "$0")" && pwd)"
[[ ! -e "$DEST" ]] || { echo "$DEST ya existe"; exit 1; }

# La etiqueta es ligera (no anotada): se comprueba que sigue en el commit fijado.
git -c advice.detachedHead=false clone -q --depth 1 --branch "$VERSION" https://github.com/telekom-security/ddospot.git "$DEST"
[[ "$(git -C "$DEST" rev-parse HEAD)" == "$COMMIT" ]] || { echo "La etiqueta $VERSION de DDoSPot ya no es el commit fijado"; exit 1; }
# La licencia se comprueba en cada construcción: si deja de ser MIT, no hay imagen.
[[ "$(head -n 1 "$DEST/LICENSE")" == "MIT License" ]] && grep -q 'Permission is hereby granted' "$DEST/LICENSE" \
	|| { echo "El LICENSE de DDoSPot ya no es MIT"; exit 1; }
git -C "$DEST" apply --check "$AQUI/sugardaddy.patch"
git -C "$DEST" apply "$AQUI/sugardaddy.patch"
cp "$AQUI/Dockerfile" "$AQUI/licencias.sh" "$DEST/"
# El manifiesto, para las pruebas: todo valor que sus patrones acepten
# tiene que arrancar la trampa (internal/app/manifiesto_test.go). Solo va a
# la etapa de construcción, no a la imagen.
install -d "$DEST/internal/app/testdata"
cp "$AQUI/../trampa.yaml" "$DEST/internal/app/testdata/trampa.yaml"
# Lo que no entra: su CI, su compose y su historia. LICENSE se queda: va en la imagen.
rm -rf "$DEST/.git" "$DEST/.github" "$DEST/docker-compose.yml" "$DEST/.dockerignore"
# Nada que hable con Quad9 puede quedar encendido, y el freno a la
# amplificación tiene que estar puesto en las cuatro trampas UDP.
grep -q 'Recursion: false,' "$DEST/internal/app/config.go" || { echo "La recursión no queda apagada"; exit 1; }
grep -q 'cg.Guard, nt.Guard, sd.Guard = guard, guard, guard' "$DEST/internal/app/app.go" \
	&& grep -q 'dh.Guard = guard' "$DEST/internal/app/app.go" \
	|| { echo "El freno a la amplificación no queda puesto"; exit 1; }
# Ser una dirección privada no basta para recibir respuestas completas:
# detrás de un cortafuegos con NAT de origen, todo Internet lo es.
! grep -q 'IsPrivate' "$DEST/internal/amp/amp.go" || { echo "El freno vuelve a fiarse de las direcciones privadas"; exit 1; }
echo "DDoSPot $VERSION ($COMMIT) con sugardaddy.patch en $DEST"
