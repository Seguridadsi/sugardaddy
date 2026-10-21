# Imagen de la trampa de portal de login web de Sugardaddy. Código PROPIO de
# SeguridadSI: escrito desde el comportamiento observable de un portal web de
# login (formulario GET + POST con credenciales, páginas de error, 404
# plausibles); los honeypots web existentes (OpenCanary BSD-3, h0neytr4p
# Apache-2.0, wordpot ISC) solo sirvieron de idea, sin copiar nada de código.
# Sin dependencias de terceros: solo la biblioteca estándar de Go
# (BSD-3-Clause, Google). El binario es estático y la base final es scratch,
# así que la imagen solo contiene nuestro ejecutable y el aviso de licencia de
# Go, sin shell ni gestor de paquetes.
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
 && go build -trimpath -buildvcs=false -ldflags "-s -w" -o /out/loginwebtrampa . \
 && mkdir -p /out/licencias \
 && cp "$(go env GOROOT)/LICENSE" /out/licencias/Go-LICENSE \
 && printf '%s\n' \
      'loginwebtrampa (trampa de portal de login web de Sugardaddy): código' \
      'propio de SeguridadSI. Escrito desde el comportamiento observable de un' \
      'portal web de login; no reutiliza código de ningún honeypot de terceros' \
      '(OpenCanary BSD-3, h0neytr4p Apache-2.0 y wordpot ISC solo sirvieron de' \
      'idea). Sin dependencias: biblioteca estándar de Go.' \
      '' \
      "El binario es estático y lleva dentro la biblioteca estándar de Go ($(go env GOVERSION))," \
      'licencia BSD-3-Clause: Go-LICENSE en esta carpeta.' > /out/licencias/LEEME.txt \
 && chmod -R a+rX,go-w /out/licencias

FROM scratch
# scratch no tiene /etc/passwd, pero admite UID:GID numéricos: corre como nobody,
# nunca como root. El puerto interno (8080) es alto y no necesita privilegio.
USER 65534:65534
# GOMEMLIMIT hace que el recolector apriete antes del límite de memoria del
# contenedor (64 MiB del manifiesto): así un atacante no lo tumba por OOM
# aunque el host tenga swap. Es memoria en marcha, no un flag de compilación:
# no afecta a la reproducibilidad del binario.
ENV GOMEMLIMIT=48MiB GOGC=50
COPY --from=construccion /out/loginwebtrampa /loginwebtrampa
COPY --from=construccion /out/licencias /licencias
EXPOSE 8080
LABEL org.opencontainers.image.title="Sugardaddy: trampa de portal de login web (loginwebtrampa)" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.licenses="LicenseRef-SeguridadSI AND BSD-3-Clause"
ENTRYPOINT ["/loginwebtrampa"]