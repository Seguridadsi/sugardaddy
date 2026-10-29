# Consola del nodo. Se construye desde la raíz del repositorio:
#   docker build -f apps/consola/Dockerfile --build-arg VERSION=0.4.0 .
# Bases fijadas por digest, como las trampas.

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS construccion
WORKDIR /src
COPY package.json package-lock.json ./
COPY paquetes ./paquetes
COPY apps/consola/package.json apps/consola/
# Solo la consola y sus paquetes: el panel central no viaja en esta imagen.
RUN npm ci --workspace apps/consola --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY apps/consola ./apps/consola
RUN cd apps/consola && npx svelte-kit sync && npx vite build \
	&& cd /src && npm prune --omit=dev --workspace apps/consola --include-workspace-root

# Geolocalización de IP: DB-IP Lite (CC BY 4.0, gratuita y redistribuible con
# atribución), la del mes en que se construye la versión. Viaja en la imagen
# para que el nodo no pregunte a nadie de dónde es una IP. La atribución sale
# en el pie de la consola (routes/+layout.svelte) cuando estas bases están.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS geo
WORKDIR /geo
RUN set -e; for f in country asn; do \
		for mes in "$(date +%Y-%m)" "$(date -d "@$(( $(date +%s) - 2592000 ))" +%Y-%m)"; do \
			wget -qO- "https://download.db-ip.com/free/dbip-$f-lite-$mes.mmdb.gz" | gunzip > "dbip-$f-lite.mmdb" && [ -s "dbip-$f-lite.mmdb" ] && break; \
		done; \
		[ -s "dbip-$f-lite.mmdb" ]; \
	done

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ARG VERSION=0.0.0
ENV NODE_ENV=production \
	SUGARDADDY_VERSION=$VERSION \
	SUGARDADDY_MODULOS=/app/modulos \
	GEO_DIR=/app/geo \
	BODY_SIZE_LIMIT=16M \
	PORT=3000
WORKDIR /app/apps/consola
COPY --from=construccion /src/node_modules /app/node_modules
COPY --from=construccion /src/apps/consola/build ./build
COPY --from=construccion /src/apps/consola/package.json ./
COPY apps/consola/drizzle ./drizzle
COPY apps/consola/scripts/arrancar.mjs apps/consola/scripts/preparar-base.mjs apps/consola/scripts/destinos.mjs apps/consola/scripts/emergencia.mjs apps/consola/scripts/clave.mjs apps/consola/scripts/red.mjs ./scripts/
COPY modulos /app/modulos
COPY --from=geo /geo /app/geo
# Sin root y sin nada que escribir: el contenedor puede ir en solo lectura.
USER node
EXPOSE 3000
LABEL org.opencontainers.image.title="Sugardaddy consola" org.opencontainers.image.version=$VERSION
CMD ["node", "scripts/arrancar.mjs"]
