# Imagen de la trampa retencion-web (H68): go-pot v1.1.2 con los arreglos de
# Sugardaddy. El contexto es lo que deja imagen/preparar.sh. No baja nada que
# no esté fijado: la base va por digest (la misma imagen de Go que usa
# sensor/Dockerfile), la toolchain es la suya (GOTOOLCHAIN=local) y cada
# módulo se comprueba contra su suma de go.sum; -mod=readonly no deja
# resolver otras versiones ni tocar go.mod.
FROM golang:1.27-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS compilar
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOWORK=off GOFLAGS=-mod=readonly
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY . .
# Nuestras pruebas (las de los ficheros que pone preparar.sh: registro,
# reparto por IP, límite, reparto justo y plazos de conexiones, formato,
# cachés acotadas, cuerpo, cabeceras costosas, respuestas de error,
# robots.txt, formato INI, y la memoria del peor caso con todas las
# conexiones que admite y el reparto justo con el servidor de verdad, que
# solo corren en Linux): si fallan, no hay imagen.
RUN go test -count=1 -run 'Rotador|TopeDe|Cupos|Formato|Semilla|CacheAcotada|TimeoutWatcherAcotado|Servidor|Robots|Ini' \
      ./protocol/http/ ./protocol/http/logging/ ./core/metrics/ ./generator/encoder/
ARG VERSION=v1.1.2
ARG COMMIT=b905ae88b766ac46a7b471df786d991acc9d2d15
RUN go build -trimpath -buildvcs=false -o /out/go-pot \
      -ldflags="-s -w -X github.com/ryanolee/go-pot/cmd.version=${VERSION}-sd4 -X github.com/ryanolee/go-pot/cmd.commitHash=${COMMIT} -X github.com/ryanolee/go-pot/cmd.buildDate=reproducible" . \
 && sh licencias.sh /out/licencias "$VERSION" "$COMMIT" \
 && chmod -R a+rX,go-w /out/licencias

# Solo el binario estático y sus avisos de licencia, sin shell ni gestor de
# paquetes, con un usuario sin privilegios. Escribe únicamente en /registros
# (la carpeta que monta el sensor); el resto va de solo lectura.
FROM scratch
COPY --from=compilar /out/go-pot /go-pot
COPY --from=compilar /out/licencias /licencias
USER 65532:65532
EXPOSE 8080
LABEL org.opencontainers.image.title="Sugardaddy: retención web (go-pot)" \
      org.opencontainers.image.version="1.1.2-sd4" \
      org.opencontainers.image.source="https://github.com/ryanolee/go-pot" \
      org.opencontainers.image.revision="b905ae88b766ac46a7b471df786d991acc9d2d15" \
      org.opencontainers.image.licenses="MIT AND Apache-2.0 AND BSD-3-Clause AND MPL-2.0"
ENTRYPOINT ["/go-pot"]
CMD ["start"]
