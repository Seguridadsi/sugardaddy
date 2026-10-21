# Imagen de la trampa retencion-ssh (H68 en modo ssh, H18 en modo banner):
# reten, código PROPIO de SeguridadSI. Sin dependencias de terceros: solo la
# biblioteca estándar de Go (BSD-3-Clause, Google). El binario es estático y
# la base final es scratch: la imagen solo lleva nuestro ejecutable y el aviso
# de licencia de Go, sin shell ni gestor de paquetes.
#
# La base de construcción es la MISMA imagen de Go que usa sensor/Dockerfile
# (mismo digest). Sin red al construir: go.mod no tiene ningún require,
# GOTOOLCHAIN=local impide que se descargue otra toolchain y GOPROXY=off, que
# se busque nada. Las pruebas corren aquí: si fallan, no hay imagen.
FROM golang:1.27-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS compilar
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOPROXY=off GOWORK=off GOFLAGS=-mod=mod
WORKDIR /src
COPY go.mod *.go ./
RUN go vet ./... \
 && go test -count=1 ./... \
 && go build -trimpath -buildvcs=false -ldflags "-s -w" -o /out/reten . \
 && mkdir -p /out/licencias \
 && cp "$(go env GOROOT)/LICENSE" /out/licencias/Go-LICENSE \
 && if [ -f "$(go env GOROOT)/PATENTS" ]; then cp "$(go env GOROOT)/PATENTS" /out/licencias/Go-PATENTS; fi \
 && printf '%s\n' \
      'reten (trampa retencion-ssh de Sugardaddy): código propio de SeguridadSI.' \
      'Modo ssh: la técnica de Endlessh (https://github.com/skeeto/endlessh, dominio' \
      'público), reimplementada; no lleva código suyo. Los avisos que manda son' \
      'fórmulas legales de uso común, como las de cualquier servidor.' \
      '' \
      "El binario es estático y lleva dentro la biblioteca estándar de Go ($(go env GOVERSION))," \
      'licencia BSD-3-Clause: Go-LICENSE en esta carpeta (y la concesión de patentes de' \
      'Go, Go-PATENTS, si la trae su versión).' > /out/licencias/LEEME.txt \
 && chmod -R a+rX,go-w /out/licencias

FROM scratch
# scratch no tiene /etc/passwd, pero admite UID:GID numéricos: nunca root. El
# puerto interno (2222) es alto y no necesita privilegio. Escribe únicamente
# en /registros (la carpeta que monta el sensor).
USER 65532:65532
COPY --from=compilar /out/reten /reten
COPY --from=compilar /out/licencias /licencias
EXPOSE 2222
LABEL org.opencontainers.image.title="Sugardaddy: retención SSH o de banner (reten)" \
      org.opencontainers.image.version="0.2.0" \
      org.opencontainers.image.licenses="LicenseRef-SeguridadSI AND BSD-3-Clause"
ENTRYPOINT ["/reten"]
