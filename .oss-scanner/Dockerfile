# Build for Anthropic's OSS Scanner (https://github.com/anthropics/oss-scanner).
#
# Builds the WHOLE monorepo into one image and leaves every test suite runnable
# offline with .oss-scanner/run-tests.sh:
#
#   apps/consola + paquetes/*   Node 22, SvelteKit   -> /src/apps/consola/build
#   sensor/ (Go)                sensor, actualizador, probartrampa -> /src/sensor/bin/
#   modulos/trampas/*           each free trap, prepared by its own imagen/preparar.sh
#                               (own code, or a pinned upstream plus the Sugardaddy
#                               patch) -> /opt/sd-trampas/<trap>, binaries in
#                               /opt/sd-trampas/bin/, Cowrie's venv in
#                               /opt/sd-trampas/cowrie-env
#
# The production images come from apps/consola/Dockerfile, sensor/Dockerfile and
# each trap's imagen/Dockerfile; this file repeats their build steps in one place.
# Building and testing need no secrets: no Entra ID tenant, signing key or token.
#
# Only Dockerfile syntax that the Docker 20.10 of Debian 12 understands (no
# heredocs, no COPY --chmod). The scanner builds on linux/amd64; on an arm64
# machine, check it with DOCKER_DEFAULT_PLATFORM=linux/amd64 tools/check sugardaddy.

FROM node:22-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf AS node

FROM golang:1.27-trixie@sha256:fbb7ae40b62ff8afe31662df570d39b4f5052ac32b90dae8e60d7657a20a74f4
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq python3 python3-dev python3-venv libffi-dev libssl-dev postgresql \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version && npm --version && go version

# Go never fetches another toolchain; modules come from each go.sum.
ENV GOTOOLCHAIN=local CGO_ENABLED=0

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# 1. Console and its workspace packages: the same steps as apps/consola/Dockerfile,
#    plus the dev dependencies the tests and svelte-check need.
RUN npm ci --no-audit --no-fund --ignore-scripts \
 && cd apps/consola \
 && npx svelte-kit sync \
 && npx vite build

#    The console specs that need a database (they skip without one) run against a
#    local Postgres 17, the node's version, with the schema migrated. The password
#    is a fake test value that only exists inside this image; the specs read
#    DATABASE_URL from apps/consola/.env, like a developer's checkout. createdb:
#    the migration specs create and drop their own throwaway databases.
RUN pg_ctlcluster 17 main start \
 && su postgres -c "psql -q -c \"create role sugardaddy login createdb password 'oss-scanner-test'\" -c 'create database consola owner sugardaddy'" \
 && printf 'DATABASE_URL="postgres://sugardaddy:oss-scanner-test@127.0.0.1:5432/consola"\n' > apps/consola/.env \
 && cd apps/consola && node --env-file=.env ../../node_modules/drizzle-kit/bin.cjs migrate \
 && pg_ctlcluster 17 main stop

# 2. Sensor and updater (stdlib only, no modules to fetch), as sensor/Dockerfile.
RUN cd sensor \
 && go vet ./... \
 && mkdir -p bin \
 && go build -trimpath -ldflags "-X main.version=oss-scanner" -o bin/ ./cmd/...

# 3. Traps. Each preparar.sh fetches what it needs (pinned by commit or sha256)
#    and refuses to continue if a check fails.
RUN mkdir -p /opt/sd-trampas/bin \
 && for t in cowrie dns-ntp impresora login-web rdp redis retencion-ssh retencion-web smb; do \
      modulos/trampas/$t/imagen/preparar.sh /opt/sd-trampas/$t || exit 1; \
    done

#    Go traps: modules into the cache now, so build and tests work offline.
RUN set -e; \
    build() { cd /opt/sd-trampas/$1; go mod download; go vet ./...; \
              go build -trimpath -o /opt/sd-trampas/bin/$1 $2; }; \
    build dns-ntp ./cmd/ddospot; \
    build impresora .; \
    build login-web .; \
    build rdp ./cmd/sdtrampa; \
    build redis .; \
    build retencion-ssh .; \
    build retencion-web .; \
    build smb ./cmd/sdtrampa

#    Cowrie (Python): its pinned requirements in a venv, as its docker/Dockerfile does.
RUN python3 -m venv /opt/sd-trampas/cowrie-env \
 && /opt/sd-trampas/cowrie-env/bin/pip install -q --no-cache-dir -r /opt/sd-trampas/cowrie/requirements.txt \
 && cd /opt/sd-trampas/cowrie \
 && PYTHONPATH=src /opt/sd-trampas/cowrie-env/bin/python3 -m compileall -q src

# From here on there is no network: make Go and npm fail fast instead of waiting.
ENV GOPROXY=off npm_config_offline=true

# 4. Every test suite, once, so the caches are warm. A failure does not fail the build.
RUN .oss-scanner/run-tests.sh || echo "WARNING: some test suites failed (see above)"
