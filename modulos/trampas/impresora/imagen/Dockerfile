# Imagen de la trampa de impresora de red de Sugardaddy (H69). Código PROPIO de
# SeguridadSI: no hay ningún origen externo con licencia válida que reutilizar
# (ipphoney y miniprint son GPL-3 y están parados; cupspot es una prueba de
# concepto de un solo CVE). Sin dependencias de terceros: solo la biblioteca
# estándar de Go (BSD-3-Clause, Google). El binario es estático y la base final
# es scratch, así que la imagen solo contiene nuestro ejecutable y el aviso de
# licencia de Go, sin shell ni gestor de paquetes.
#
# La base de construcción es la MISMA imagen de Go que usan sensor/Dockerfile y
# las trampas redis y dns-ntp (mismo digest): no hay ninguna base nueva que
# auditar.
FROM golang:1.27-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS construccion
# Sin red al construir: no hay dependencias que bajar (go.mod no tiene ningún
# require) y la toolchain es la de la imagen; GOTOOLCHAIN=local impide que se
# descargue otra, y GOPROXY=off, que se busque nada por la red. Las pruebas
# corren aquí: si fallan, no hay imagen.
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOPROXY=off GOWORK=off GOFLAGS=-mod=mod
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN go vet ./... \
 && go test -count=1 ./... \
 && go build -trimpath -buildvcs=false -ldflags "-s -w" -o /out/impresoratrampa . \
 && mkdir -p /out/licencias \
 && cp "$(go env GOROOT)/LICENSE" /out/licencias/Go-LICENSE \
 && printf '%s\n' \
      'impresoratrampa (trampa de impresora de red de Sugardaddy): código propio' \
      'de SeguridadSI. Escrito desde las especificaciones de PJL, IPP (RFC 8010)' \
      'y HTTP; no reutiliza ningún honeypot de impresora de terceros.' \
      '' \
      "El binario es estático y lleva dentro la biblioteca estándar de Go ($(go env GOVERSION))," \
      'licencia BSD-3-Clause: Go-LICENSE en esta carpeta.' > /out/licencias/LEEME.txt \
 && chmod -R a+rX,go-w /out/licencias

FROM scratch
# scratch no tiene /etc/passwd, pero admite UID:GID numéricos: corre como
# nobody, nunca como root. Dentro escucha en 9100, 1631 y 1080, que no necesitan
# privilegio en ningún kernel; el 631 y el 80 que ve el atacante los publica el
# motor (el contrato pide puertos internos de 1024 o más).
USER 65534:65534
# GOMEMLIMIT hace que el recolector apriete antes del límite de memoria del
# contenedor (64 MiB del manifiesto): así un atacante no lo tumba por OOM.
ENV GOMEMLIMIT=48MiB GOGC=50
COPY --from=construccion /out/impresoratrampa /impresoratrampa
COPY --from=construccion /out/licencias /licencias
EXPOSE 9100 1631 1080
LABEL org.opencontainers.image.title="Sugardaddy: trampa de impresora de red (impresoratrampa)" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.licenses="LicenseRef-SeguridadSI AND BSD-3-Clause"
STOPSIGNAL SIGTERM
ENTRYPOINT ["/impresoratrampa"]
