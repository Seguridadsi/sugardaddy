#!/bin/sh
# Lo único de modulos/ que entra en las imágenes de la consola y del panel: los
# manifiestos, que son el catálogo, las plantillas de los ficheros cebo, que la
# consola acuña, y las plantillas de trampas (grupos por entorno), que son solo datos. El código de las trampas se queda fuera: quien descarga esas
# imágenes no debe poder sacarlo de ahí. Cada trampa se reparte en su propia imagen.
#
# Es una lista de lo que entra, no de lo que sale: un fichero nuevo en un módulo
# no viaja hasta que alguien lo añada aquí. Si la aplicación empieza a leer otro
# fichero de modulos/, catalogo-imagen.spec.ts lo avisa.
#
#   sh modulos/catalogo-de-imagen.sh <modulos> <destino>
set -eu

destino="$(mkdir -p "$2" && cd "$2" && pwd)"
cd "$1"

copiados=0
for f in trampas/*/trampa.yaml ficheros/*/trampa.yaml nube/*/trampa.yaml \
	respuestas/*/respuesta.yaml \
	plantillas/*/plantilla.yaml \
	ficheros/*/plantilla/*.docx ficheros/*/plantilla/*.xlsx \
	ficheros/*/plantilla/*.pptx \
	ficheros/*/plantilla/*.pdf ficheros/*/plantilla/*.svg; do
	# Un patrón que no casa se queda tal cual: no es un fichero.
	[ -f "$f" ] || continue
	mkdir -p "$destino/$(dirname "$f")"
	cp "$f" "$destino/$f"
	# Tiene que poder leerlo el usuario sin privilegios del contenedor.
	chmod 644 "$destino/$f"
	copiados=$((copiados + 1))
done

# Una imagen con el catálogo vacío arrancaría sin trampas y sin decir nada.
if [ ! -d "$destino/trampas" ]; then
	echo "catalogo-de-imagen: ninguna trampa en $1" >&2
	exit 1
fi
echo "catalogo-de-imagen: $copiados ficheros"
