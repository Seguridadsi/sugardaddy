# Imagen de la trampa RDP (Escritorio remoto, H06) de Sugardaddy. Se construye
# sobre la base COMÚN de glutton (modulos/comun/glutton), que reutiliza el
# manejador RDP de glutton (github.com/mushorg/glutton, MIT) recortado y
# parcheado: sin hpfeeds (GPL/sin licencia), sin la capa TPROXY/iptables/pcap y
# sin viper. El binario es estático y la base final es scratch: la imagen solo
# contiene nuestro ejecutable y los avisos de licencia (glutton MIT,
# golang.org/x/crypto BSD-3 y la biblioteca estándar de Go BSD-3), sin shell ni
# gestor de paquetes.
#
# La base de construcción es la MISMA imagen de Go que usa sensor/Dockerfile
# (mismo digest): no hay ninguna base nueva que auditar.
FROM golang:1.27-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS construccion
# A diferencia de las trampas de código propio (redis, mysql), glutton sí tiene
# dependencias (golang.org/x/crypto y, para las pruebas, testify): se bajan con
# go mod download, comprobadas por el go.sum que dejó preparar-base.sh (huellas
# fijas), y no se busca otra toolchain. Las pruebas corren aquí: si fallan, no
# hay imagen.
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-mod=mod
WORKDIR /src
COPY . .
RUN go mod download \
 && go vet ./... \
 && go test -count=1 ./... \
 && go build -trimpath -buildvcs=false -ldflags "-s -w" -o /out/rdptrampa ./cmd/sdtrampa \
 && mkdir -p /out/licencias \
 && sh licencias.sh /out/rdptrampa /out/licencias 4dfac5b9a9bb7101a7564991a25ecca2dbbce400 \
 && chmod -R a+rX,go-w /out/licencias

FROM scratch
# scratch no tiene /etc/passwd, pero admite UID:GID numéricos: corre como nobody,
# nunca como root. El puerto interno (3389) es alto y no necesita privilegio.
USER 65534:65534
# GOMEMLIMIT hace que el recolector apriete antes del límite de memoria del
# contenedor (128 MiB del manifiesto): así un atacante no lo tumba por OOM
# aunque el host tenga swap. Es memoria en marcha, no un flag de compilación:
# no afecta a la reproducibilidad del binario.
ENV GOMEMLIMIT=96MiB GOGC=50
COPY --from=construccion /out/rdptrampa /rdptrampa
COPY --from=construccion /out/licencias /licencias
EXPOSE 3389
LABEL org.opencontainers.image.title="Sugardaddy: trampa RDP (rdptrampa, sobre glutton)" \
      org.opencontainers.image.version="1.0.1-sd1" \
      org.opencontainers.image.licenses="MIT AND BSD-3-Clause"
ENTRYPOINT ["/rdptrampa"]
