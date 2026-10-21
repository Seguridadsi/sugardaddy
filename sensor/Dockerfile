# Sensor y actualizador del nodo: el mismo código, dos binarios. Se elige con
# BINARIO (así también lo puede construir az acr build, que no elige etapas):
#   docker build -f sensor/Dockerfile --build-arg BINARIO=sensor --build-arg VERSION=0.7.0 sensor
#   docker build -f sensor/Dockerfile --build-arg BINARIO=actualizador --build-arg VERSION=0.7.0 sensor

FROM golang:1.27-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS construccion
ARG VERSION=dev
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o /out/sensor ./cmd/sensor \
	&& CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o /out/actualizador ./cmd/actualizador

# Distroless: sin shell ni gestor de paquetes. Corren como root porque hablan
# con el socket de Docker, que ya equivale a root en la máquina: lo que se
# protege es quién llega a ellos, no su usuario.
FROM gcr.io/distroless/static:nonroot@sha256:e2e927ec666bae08560abb3c55d0659eceabb657f56b6782ab500a9fc7f555e3
ARG BINARIO=sensor
COPY --from=construccion /out/${BINARIO} /app
USER 0
ENTRYPOINT ["/app"]
