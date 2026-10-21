#!/usr/bin/env bash
#
# Prepara el contexto con el que se construye nuestra imagen de go-pot, la de
# la trampa retencion-web (H68): el código de la versión fijada (comprobado
# por su commit y su licencia) con arreglos pequeños, cada uno comprobado
# (si uno no entra, no se construye), nuestro registro rotado (fuente/rotar.go),
# las dependencias bloqueadas (dependencias/go.mod y go.sum) y nuestro
# Dockerfile, que sustituye al de go-pot en la raíz.
#
# go.mod y go.sum son los de go-pot con fiber v2.52.13, x/net v0.60.0 y
# x/text v0.42.0 por govulncheck (go get + go mod tidy, una vez, sobre este
# mismo código ya preparado; govulncheck 1.9.0 del 17-10-2026: nada de lo que
# llama go-pot es vulnerable). Al construir no se resuelve nada: -mod=readonly
# y cada módulo se comprueba contra su suma de go.sum. Para renovarlos, a
# mano: go get en el código preparado, go mod tidy, govulncheck, probar y
# guardar aquí los nuevos.
#
#   modulos/trampas/retencion-web/imagen/preparar.sh <carpeta nueva>
set -euo pipefail
VERSION=v1.1.2
COMMIT=b905ae88b766ac46a7b471df786d991acc9d2d15
DEST="${1:?Uso: preparar.sh <carpeta nueva>}"
AQUI="$(cd "$(dirname "$0")" && pwd)"
[[ ! -e "$DEST" ]] || { echo "$DEST ya existe"; exit 1; }
falla() { echo "$1: no se construye"; exit 1; }
suma() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

git -c advice.detachedHead=false clone -q --depth 1 --branch "$VERSION" https://github.com/ryanolee/go-pot.git "$DEST"
[[ "$(git -C "$DEST" rev-parse HEAD)" == "$COMMIT" ]] || falla "La etiqueta $VERSION de go-pot ya no es el commit fijado"

# Licencias: MIT de go-pot (con la Apache-2.0 de los esquemas de SchemaStore
# en el mismo fichero) y Apache-2.0 de internal/regen. Van dentro de la imagen.
grep -q 'Copyright (c) 2024  Ryan Lee' "$DEST/LICENCE" && grep -q 'Permission is hereby granted, free of charge' "$DEST/LICENCE" \
	|| falla "La licencia de go-pot ya no es la MIT comprobada"
grep -q '## SCHEMA STORE LICENCE' "$DEST/LICENCE" || falla "Falta en LICENCE la licencia de los esquemas de SchemaStore"
grep -q 'Apache License' "$DEST/internal/regen/LICENSE.txt" || falla "La licencia de internal/regen ya no es Apache-2.0"

# 1) server.go entero es el nuestro (fuente/server.go: el de go-pot con los
#    cambios explicados en su cabecera: Fiber inmutable, topes de memoria y
#    plazos por conexión, conexiones por IP y en total según la memoria,
#    respuestas de error de un servidor normal que además se apuntan, y
#    robots.txt propio de cada trampa). Solo si el original es el comprobado:
#    si go-pot lo cambia, hay que rehacerlo a mano.
f="$DEST/protocol/http/server.go"
[[ "$(suma "$f")" == a288f9865a17bffd7f2810ccaf6776e5bf417fd64d155db7b17bc6bd430971fb ]] \
	|| falla "protocol/http/server.go de go-pot ya no es el comprobado"
cp "$AQUI/fuente/server.go" "$AQUI/fuente/robots.go" "$AQUI/fuente/servidor_test.go" "$DEST/protocol/http/"

# 2) Valores por defecto seguros aunque falte una variable: la IP sale del
#    socket (no de X-Forwarded-For, que el atacante falsea) y sin telemetría.
f="$DEST/config/default.go"
perl -0pi -e 's/ProxyHeader:    "X-Forwarded-For"/ProxyHeader:    ""/; s/(Telemetry: telemetryConfig\{\n\t\tEnabled:  )true/$1false/' "$f"
grep -q 'ProxyHeader:    ""' "$f" || falla "No se pudo vaciar proxy_header"
perl -0ne 'exit(/Telemetry: telemetryConfig\{\n\t\tEnabled:  false,/ ? 0 : 1)' "$f" || falla "No se pudo apagar la telemetría por defecto"
perl -0ne 'exit(/Cluster: clusterConfig\{\n\t\tEnabled:            false,/ && /Recast: recastConfig\{\n\t\tEnabled:                  false,/ ? 0 : 1)' "$f" \
	|| falla "El clúster o recast ya no vienen apagados por defecto"

# 3) El puerto de origen, que go-pot no registra: campo src_port.
f="$DEST/protocol/http/logging/http_access_logger.go"
perl -0pi -e 's/(\t"src_ip": func\(entry \*HttpAccessLogEntry\) string \{\n\t\treturn entry.Context.IP\(\)\n\t\},\n)/$1\t"src_port": func(entry *HttpAccessLogEntry) string {\n\t\tif a, ok := entry.Context.Context().RemoteAddr().(*net.TCPAddr); ok {\n\t\t\treturn strconv.Itoa(a.Port)\n\t\t}\n\t\treturn ""\n\t},\n/' "$f"
grep -q '"src_port": func' "$f" || falla "No se pudo añadir src_port"
perl -pi -e 's/oneof=timestamp status src_ip /oneof=timestamp status src_ip src_port /' "$DEST/config/config.go"
grep -q 'src_ip src_port ' "$DEST/config/config.go" || falla "No se pudo admitir src_port en la configuración"

# 4) La duración en segundos con decimales («20.252») en vez del texto de Go
#    («20.251976615s», «30m55.8s»): así se puede sumar el tiempo que pierde.
perl -pi -e 's/return entry\.Duration\.String\(\)/return strconv.FormatFloat(entry.Duration.Seconds(), \x27f\x27, 3, 64)/' "$f"
grep -q "return strconv.FormatFloat(entry.Duration.Seconds(), 'f', 3, 64)" "$f" || falla "No se pudo poner la duración en segundos"

#    Y sin campos vacíos que no tocan: la línea de inicio llevaba
#    "duration":"" (la duración solo existe al soltar).
perl -0pi -e 's/\t\t\} else \{\n\t\t\tzapFields = append\(zapFields, zap\.String\(field, ""\)\)\n\t\t\}\n/\t\t}\n/' "$f"
! grep -q 'zap.String(field, "")' "$f" || falla "No se pudo quitar los campos vacíos"

# 5) Sin el analizador de User-Agent: compila cientos de expresiones al
#    arrancar (16 MiB) y analiza cada petición (CPU) para campos que no
#    usamos. El User-Agent entero sigue en el registro.
perl -pi -e 's/uaParser:    uaparser\.NewFromSaved\(\),/uaParser:    nil,/; s/if entry\.uaDetails == nil \{/if entry.uaDetails == nil \&\& l.uaParser != nil {/' "$f"
grep -q 'uaParser:    nil,' "$f" && grep -q 'l.uaParser != nil' "$f" || falla "No se pudo quitar el analizador de User-Agent"

# 6) zap de producción muestrea: de las líneas iguales en mensaje y nivel (las
#    de acceso lo son todas) escribe 100 por segundo y luego 1 de cada 100. De
#    200 peticiones en un segundo registraba 102. Sin muestreo.
perl -0pi -e 's/(\tloggerCfg := zap\.NewProductionConfig\(\)\n)/$1\tloggerCfg.Sampling = nil\n/' "$f"
grep -q 'loggerCfg.Sampling = nil' "$f" || falla "No se pudo quitar el muestreo del registro"

#    Y el formato que entienden todos los sensores, también los 0.12: la hora
#    en RFC 3339 (UTC), no en segundos desde 1970, y el puerto de origen como
#    número, no como texto (formato.go). Sin caller ni traza: ruido.
perl -0pi -e 's/(\tloggerCfg\.Sampling = nil\n)/$1\tloggerCfg.EncoderConfig.EncodeTime = horaRFC3339\n\tloggerCfg.DisableCaller = true\n\tloggerCfg.DisableStacktrace = true\n/' "$f"
grep -q 'loggerCfg.EncoderConfig.EncodeTime = horaRFC3339' "$f" && grep -q 'loggerCfg.DisableCaller = true' "$f" \
	|| falla "No se pudo poner la hora en RFC 3339"
perl -pi -e 's/zapFields = append\(zapFields, zap\.String\(field, resolvedField\)\)/zapFields = append(zapFields, campoDeRegistro(field, resolvedField))/' "$f"
grep -q 'campoDeRegistro(field, resolvedField)' "$f" || falla "No se pudo poner el puerto como número"

# 7) Código nuestro en el paquete del registro, con sus pruebas, que corren
#    al construir: el registro rota a diario, con tope por día repartido por
#    IP y resúmenes de lo que se calla (rotar.go); el limitador de conexiones
#    por IP y en total, con reparto justo cuando se llena (cupos.go); y el
#    formato de las líneas, las peticiones rechazadas y la semilla de cada
#    trampa (formato.go).
cp "$AQUI"/fuente/{rotar,cupos,formato}{,_test}.go "$DEST/protocol/http/logging/"

# 8) Las cachés por IP del TimeoutWatcher, con máximo de entradas
#    (cache_acotada.go): go-cache solo caduca por tiempo, y con cada IP
#    distinta la memoria crecía sin tope.
f="$DEST/core/metrics/timeout.go"
perl -pi -e 's/(hotCachePool|coldCachePool) \*cache\.Cache$/$1 *cacheAcotada/; s/cache\.New\((time\.Duration\(twConfig\.Cache(Hot|Cold)PoolTTL\)\*time\.Second), time\.(Minute|Hour)\)/nuevaCacheAcotada($1, maxIPsPorCache)/' "$f"
[[ "$(grep -c '\*cacheAcotada$' "$f")" == 2 && "$(grep -c 'nuevaCacheAcotada(' "$f")" == 2 ]] && ! grep -q 'cache\.New(' "$f" \
	|| falla "No se pudieron acotar las cachés del TimeoutWatcher"
cp "$AQUI"/fuente/cache_acotada{,_test}.go "$DEST/core/metrics/"

# 9) De los 332 esquemas de SchemaStore con los que inventa ficheros de
#    configuración, 24: los 332 son 46 MiB más de memoria para un atacante
#    que recibe 8 bytes por segundo.
QUEDAN="traefik-v2-file-provider prometheus cloud-sdk-pipeline-config-schema traefik-v2
  github-workflow-template-properties lazydocker package.manifest dockerd grafana-dashboard-5.x
  bundleconfig launchsettings azure-iot-edge-deployment-template-4.0 babelrc compilerconfig
  all-contributors prometheus.rules bower testenvironments swa-cli.config behat drupal-config
  artifacthub-repo vsconfig block"
d="$DEST/generator/data/schema"
for e in $QUEDAN; do [[ -f "$d/$e.json" ]] || falla "Falta el esquema $e"; done
for x in "$d"/*; do
	n="$(basename "$x" .json)"
	[[ " $(echo $QUEDAN) " == *" $n "* ]] || rm "$x"
done
[[ "$(ls "$d" | wc -l | tr -d ' ')" == 24 ]] || falla "No quedan 24 esquemas"

# 10) A /.env, /.git/config o /.aws/credentials go-pot contestaba con JSON
#     («[{"categories":...», application/json): un fichero así nunca es JSON.
#     Van con el codificador INI («clave = valor», text/plain), como los .ini.
f="$DEST/generator/encoder/encoders.go"
perl -pi -e 's/regexp\.MustCompile\(`\\\.ini`\)/regexp.MustCompile(`\\.(ini|env|cfg|conf|properties|npmrc)|\/\\.git\/config|\/credentials`)/' "$f"
grep -qF 'regexp.MustCompile(`\.(ini|env|cfg|conf|properties|npmrc)|/\.git/config|/credentials`)' "$f" \
	|| falla "No se pudo dar el formato INI a .env y compañía"
#     Y el codificador INI escribe los valores sueltos como «clave = valor»
#     (ini_claves.go): go-pot dejaba de cada uno una sección vacía.
f="$DEST/generator/encoder/ini.go"
perl -0pi -e 's/\t\tsection, err := file\.NewSection\(sectionName\)\n\t\tif err != nil \{\n\t\t\tcontinue\n\t\t\}\n\n\t\tif data, ok := sectionValue\.\(map\[string\]interface\{\}\); ok \{\n\t\t\tmapUnknownValuesToIniSection\(section, data\)\n\t\t\}\n/\t\tdata, ok := sectionValue.(map[string]interface{})\n\t\tif !ok {\n\t\t\tvalorIniSuelto(file, sectionName, sectionValue)\n\t\t\tcontinue\n\t\t}\n\t\tsection, err := file.NewSection(sectionName)\n\t\tif err != nil {\n\t\t\tcontinue\n\t\t}\n\t\tmapUnknownValuesToIniSection(section, data)\n/' "$f"
grep -q 'valorIniSuelto(file, sectionName, sectionValue)' "$f" || falla "No se pudo arreglar el codificador INI"
cp "$AQUI"/fuente/ini_claves{,_test}.go "$DEST/generator/encoder/"

# Dependencias bloqueadas, nuestro Dockerfile y el script de licencias. Lo que
# no entra en la imagen: el Dockerfile, el espacio de trabajo (go.work, que
# nombra cdk/) y el CI de go-pot, su despliegue en AWS (cdk/), sus ejemplos y
# su documentación. LICENCE e internal/regen/LICENSE.txt se quedan.
cp "$AQUI/dependencias/go.mod" "$AQUI/dependencias/go.sum" "$DEST/"
cp "$AQUI/Dockerfile" "$AQUI/licencias.sh" "$DEST/"
rm -rf "$DEST/.git" "$DEST/.github" "$DEST/cdk" "$DEST/docs" "$DEST/examples" \
	"$DEST/go.work" "$DEST/go.work.sum" "$DEST/goreleaser.yml" "$DEST/makefile" "$DEST/.dockerignore"
echo "go-pot $VERSION ($COMMIT) con los arreglos de Sugardaddy en $DEST"
