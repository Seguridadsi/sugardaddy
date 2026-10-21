# Imagen de la trampa dns-ntp (H61 DNS, H15 NTP y descubrimiento SSDP):
# DDoSPot v2.0.1 (Telekom Security, MIT) con el parche de Sugardaddy, en un
# binario estático FROM scratch. El contexto es lo que deja imagen/preparar.sh.
#
# No baja nada que no esté fijado: la base va por digest y es la MISMA imagen
# de Go que usan sensor/Dockerfile y la trampa redis (no hay base nueva que
# auditar); GOTOOLCHAIN=local impide que se descargue otra toolchain; y los
# módulos de Go son los del go.sum del commit fijado, que go mod download
# comprueba al bajarlos y go mod verify otra vez en la caché. Nada de apk add.
# Sin almacén de CA: esta construcción no resuelve por nadie ni abre TLS.
FROM golang:1.27-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS construccion
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-mod=readonly
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY . .
# Las pruebas (las de DDoSPot y las del parche: recursión, freno a la
# amplificación, redes internas, rotación, reparto y tope del registro, y
# que todo valor que acepten los patrones del manifiesto arranque la
# trampa) tienen que pasar para que haya imagen.
RUN go vet ./... && go test ./... \
 && go build -trimpath -ldflags="-s -w" -o /out/ddospot ./cmd/ddospot \
 && install -d -m 0755 /out/registros \
 && sh licencias.sh /out/ddospot /out/licencias 2.0.1 84dae58c6045453c9a4b6d315e2ca12885776d82 \
 && chmod -R a+rX,go-w /out/licencias

# Solo el binario, sus avisos de licencia y la carpeta de registros. Escribe
# únicamente en /var/log/ddospot (la que monta el sensor); no necesita /tmp
# ni capacidades. Dentro escucha en puertos de 1024 o más (DNS en el 1053,
# NTP en el 1123, SSDP en el 11900 y chargen, que no se publica, en el
# 10019): un puerto bajo sin root solo se abre donde el kernel lo deja
# (net.ipv4.ip_unprivileged_port_start, Linux 4.11 o posterior con Docker),
# no en CentOS/RHEL 7 ni, según cómo, en Podman. El atacante llega por los
# que publica el sensor (53, 123 y 1900 por defecto).
FROM scratch
COPY --from=construccion /out/ddospot /ddospot
COPY --from=construccion /out/licencias /licencias
COPY --from=construccion --chown=2000:2000 /out/registros /var/log/ddospot
# Recursión imposible (con "on" no arranca). Fuera de las redes internas
# (DDOSPOT_INTERNAL_NETS, vacía: ninguna; ser privada no basta), ninguna
# respuesta UDP más grande que su petición y version.bind con REFUSED. Un
# solo registro con una línea por petición, rotado por días y con 50 MB al
# día como mucho, repartidos entre UDP, TCP y ráfagas y por origen (una
# semana cabe en los 512 MB que el sensor guarda por trampa). 50 respuestas
# por servicio a cada origen privado (500 a su /24) en vez de 5 (20). Tablas
# de 50000 orígenes (85 MB de pico medidos, llenas). La semilla de la persona
# de cada instancia, junto a su registro.
ENV DDOSPOT_DNS_RECURSION=off \
    DDOSPOT_PUBLIC_AMPLIFICATION=off \
    DDOSPOT_INTERNAL_NETS="" \
    DDOSPOT_LOG_FILE=ddospot.json \
    DDOSPOT_SEED_FILE=persona.semilla \
    DDOSPOT_MAX_LOG_BYTES=52428800 \
    DDOSPOT_LOG_REQUESTS=on \
    DDOSPOT_LOG_BLOCKED=on \
    DDOSPOT_PRIVATE_BUDGET=50 \
    DDOSPOT_MAX_SOURCES=50000 \
    DDOSPOT_CHARGEN_PORT=10019 \
    DDOSPOT_DNS_PORT=1053 \
    DDOSPOT_NTP_PORT=1123 \
    DDOSPOT_SSDP_PORT=11900 \
    GOMEMLIMIT=100MiB
USER 2000:2000
EXPOSE 1053/udp 1053/tcp 1123/udp 11900/udp
LABEL org.opencontainers.image.title="Sugardaddy: DNS, NTP y SSDP falsos (DDoSPot)" \
      org.opencontainers.image.version="2.0.1-sd4" \
      org.opencontainers.image.source="https://github.com/telekom-security/ddospot" \
      org.opencontainers.image.revision="84dae58c6045453c9a4b6d315e2ca12885776d82" \
      org.opencontainers.image.licenses="MIT"
STOPSIGNAL SIGTERM
ENTRYPOINT ["/ddospot"]
