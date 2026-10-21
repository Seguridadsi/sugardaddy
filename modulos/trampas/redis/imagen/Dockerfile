# Imagen de la trampa Redis de Sugardaddy. Código PROPIO de SeguridadSI: no hay
# ningún origen externo con licencia válida que reutilizar (RedisHoneyPot es
# GPL-3 y está muerto, QeeqBox es AGPL, Redis 8 es AGPL). Sin dependencias de
# terceros: solo la biblioteca estándar de Go (BSD-3-Clause, Google). El binario
# es estático y la base final es scratch, así que la imagen solo contiene
# nuestro ejecutable y el aviso de licencia de Go, sin shell ni gestor de
# paquetes.
#
# La base de construcción es la MISMA imagen de Go que usa sensor/Dockerfile
# (mismo digest): no hay ninguna base nueva que auditar.
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
 && go build -trimpath -buildvcs=false -ldflags "-s -w" -o /out/redistrampa . \
 && mkdir -p /out/licencias \
 && cp "$(go env GOROOT)/LICENSE" /out/licencias/Go-LICENSE \
 && printf '%s\n' \
      'redistrampa (trampa Redis de Sugardaddy): código propio de SeguridadSI.' \
      'Escrito desde la especificación del protocolo RESP; no reutiliza ningún' \
      'honeypot de Redis de terceros.' \
      '' \
      "El binario es estático y lleva dentro la biblioteca estándar de Go ($(go env GOVERSION))," \
      'licencia BSD-3-Clause: Go-LICENSE en esta carpeta.' > /out/licencias/LEEME.txt \
 && chmod -R a+rX,go-w /out/licencias

FROM scratch
# scratch no tiene /etc/passwd, pero admite UID:GID numéricos: corre como nobody,
# nunca como root. El puerto interno (6379) es alto y no necesita privilegio.
USER 65534:65534
# GOMEMLIMIT hace que el recolector apriete antes del límite de memoria del
# contenedor (64 MiB del manifiesto): así un atacante no lo tumba por OOM
# aunque el host tenga swap. Es memoria en marcha, no un flag de compilación:
# no afecta a la reproducibilidad del binario.
ENV GOMEMLIMIT=48MiB GOGC=50
COPY --from=construccion /out/redistrampa /redistrampa
COPY --from=construccion /out/licencias /licencias
EXPOSE 6379
LABEL org.opencontainers.image.title="Sugardaddy: trampa Redis (redistrampa)" \
      org.opencontainers.image.version="7.2.4-sd4" \
      org.opencontainers.image.licenses="LicenseRef-SeguridadSI AND BSD-3-Clause"
ENTRYPOINT ["/redistrampa"]
