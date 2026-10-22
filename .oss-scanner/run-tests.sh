#!/usr/bin/env bash
#
# Runs every test suite of the monorepo inside the image that .oss-scanner/Dockerfile
# builds, with no network. Each trap's tests are the ones its imagen/Dockerfile runs
# when it builds the production image.
#
#   /src/.oss-scanner/run-tests.sh
#
# Exits 0 only if every suite passes; the summary at the end names the ones that failed.
set -uo pipefail
SRC="${SRC:-/src}"
TRAMPAS="${TRAMPAS:-/opt/sd-trampas}"
fallos=()

suite() {
	local nombre="$1"; shift
	echo
	echo "=== $nombre"
	if (set -e; "$@"); then
		echo "--- ok: $nombre"
	else
		echo "--- FAIL: $nombre"
		fallos+=("$nombre")
	fi
}

# The image's local Postgres, for the console specs that need a database.
pg_ctlcluster 17 main start 2>/dev/null || pg_ctlcluster 17 main status >/dev/null \
	|| echo "WARNING: no local Postgres: the console specs that need a database will skip"

suite "console and packages (vitest)" bash -c "cd '$SRC' && npm test"
suite "sensor and updater (go test)" bash -c "cd '$SRC/sensor' && go test -count=1 ./..."

for t in dns-ntp impresora login-web rdp redis retencion-ssh smb; do
	suite "trap $t (go test)" bash -c "cd '$TRAMPAS/$t' && go test -count=1 ./..."
done
# The same subset as its imagen/Dockerfile: the code Sugardaddy adds or replaces in go-pot.
suite "trap retencion-web (go test)" bash -c "cd '$TRAMPAS/retencion-web' && go test -count=1 \
	-run 'Rotador|TopeDe|Cupos|Formato|Semilla|CacheAcotada|TimeoutWatcherAcotado|Servidor|Robots|Ini' \
	./protocol/http/ ./protocol/http/logging/ ./core/metrics/ ./generator/encoder/"
# The same commands as the patched docker/Dockerfile of Cowrie (see cowrie/imagen/parche.py).
suite "trap cowrie (unittest)" bash -c "cd '$TRAMPAS/cowrie' && export PYTHONPATH=src PYTHONDONTWRITEBYTECODE=1 \
	&& '$TRAMPAS/cowrie-env/bin/python3' -m unittest discover -q -s sd-pruebas -t sd-pruebas \
	&& '$TRAMPAS/cowrie-env/bin/python3' -m unittest -q \
	cowrie.test.test_events cowrie.test.test_checkers cowrie.test.test_utils \
	cowrie.test.test_attacker_bytes cowrie.test.test_eventids cowrie.test.test_output_lifecycle \
	cowrie.test.test_command_input_events cowrie.test.test_shell_events cowrie.test.test_forwarding_events"

echo
if ((${#fallos[@]})); then
	echo "FAILED: ${fallos[*]}"
	exit 1
fi
echo "All test suites passed."
