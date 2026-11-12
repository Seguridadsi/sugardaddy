#!/usr/bin/env bash
# sugardaddy-install 1
#
# Sugardaddy Cloud installer, first stage.
#
#   sudo bash sugardaddy-install.sh https://<central>/instalar/<code>
#
# This file is the same for every customer and holds no credentials. It is
# published with each release and signed with the Sugardaddy publication key;
# the publication keys it trusts are written below and are also published in
# the documentation and in the public repository, so they can be compared
# without asking Central.
#
# What it does:
#   1. Downloads from Central the signed release, as data.
#   2. Checks its signature with the keys below, with openssl. Checks that it
#      is a Cloud release and that every file it is about to use (instalar.sh,
#      compose.yml, Caddyfile...) has the fingerprint the signed release states.
#   3. Asks for the 6-digit PIN you were given separately and, with it,
#      downloads this customer's data (registry credential, enrollment code).
#      Nothing downloaded from Central is ever run or sourced: only the files
#      whose fingerprint is in the signed release.
#   4. Runs the verified instalar.sh. The publication keys the node will trust
#      from then on are the ones below, not anything Central sent.
#
# Unattended: pass the PIN in SUGARDADDY_PIN, after sudo.
#
# Exit status: 0 installed; 75 nothing was used up and the same line is still
# valid; 1 anything else.
#
# Everything runs from the last line, so a cut download runs nothing.
set -uo pipefail

# --- publication keys (written by herramientas/etapa1.ts; do not edit by hand) ---
SD_CLAVES='cloud:MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEK4wY19UHamiOcmyuoLsEQ9GvV6MZ7G+Y6qb5C+Y3Pzdq/tNwVujF2gTAvf/Cv+TS0tqCbDPVGlvYxBsFzty7WQ==,cloud:MCowBQYDK2VwAyEAceDEute8W7AXB/02qZDMWZQFyM98tGUVh1Sfq3SAJFw=,licencias:MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEEeWKEJxZsCgrcZppbKnUvDsMzIbfaGe7I1TLHf4frgzvC3k4nl96+uT1rfvV8q0RkuJ09RwSdD/cAf86a9POiA==,licencias:MCowBQYDK2VwAyEApv+AOrzC7Ewm02EtXJvGz91E0TktgvFDBupo5goBQVE=,delegaciones:MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAECJcCrOn2crd7VUOyriPZmr92zZF4u5PGIbxpcnOyz9RYZXwd88fJhws+DAtq/0wbLlp7Bg/piXmj+WjgoUHBaA==,delegaciones:MCowBQYDK2VwAyEAXzv9xDKMWCwMtaEC8EBEQrrOfyE6oLqBhOm08TOgqwQ='
SD_LEGADO='MCowBQYDK2VwAyEA+mhA3YHVr2fHVfTPf9Xik4haX9NglBXS27t7rQx+bwA='
# --- end of publication keys ---

SD_EDICION=cloud
SD_SIGUE=75
SD_PIEZAS='instalar.sh copia.sh restaurar.sh compose.yml Caddyfile imagenes.env entorno.txt'
SD_B64='^[A-Za-z0-9+/]*={0,2}$'

sd_di() { echo "Sugardaddy: $*" >&2; }

# Text that came from Central, made safe to print: no control characters.
sd_texto() { base64 -d 2>/dev/null | LC_ALL=C tr -d '\000-\037\177' | cut -c1-600; }

# sd_decodifica <base64> <file>: writes the decoded bytes; fails if it is not base64.
sd_decodifica() {
	[[ $1 =~ $SD_B64 ]] || return 1
	printf '%s' "$1" | base64 -d > "$2" 2>/dev/null
}

# sd_una_linea <file>: true if it has no control characters at all (so, a single line).
sd_una_linea() {
	[[ "$(wc -c < "$1")" == "$(LC_ALL=C tr -d '\000-\037\177' < "$1" | wc -c)" ]]
}

# Fingerprint of a public key: the first 16 hex digits of the sha256 of its DER.
sd_huella_clave() { printf '%s' "$1" | base64 -d 2>/dev/null | sha256sum | cut -c1-16; }

# The keys this copy accepts for a release: the Cloud ones or, if it has none,
# the legacy one. One per line.
sd_candidatas() {
	local k hay=no
	local IFS=','
	for k in $SD_CLAVES; do
		if [[ $k == "$SD_EDICION":* ]]; then
			echo "${k#*:}"
			hay=si
		fi
	done
	[[ $hay == si || -z $SD_LEGADO ]] || echo "$SD_LEGADO"
}

# r||s (64 bytes, as Azure Key Vault returns ES256) to the DER openssl expects.
sd_ecdsa_der() { # <raw signature file> <der file>
	local hex r s total
	hex="$(od -An -v -tx1 < "$1" | tr -d ' \n')"
	[[ ${#hex} == 128 ]] || return 1
	r="${hex:0:64}" s="${hex:64:64}"
	while [[ ${#r} -gt 2 && ${r:0:2} == 00 ]]; do r="${r:2}"; done
	while [[ ${#s} -gt 2 && ${s:0:2} == 00 ]]; do s="${s:2}"; done
	[[ ${r:0:1} =~ [89a-f] ]] && r="00$r"
	[[ ${s:0:1} =~ [89a-f] ]] && s="00$s"
	total=$((4 + ${#r} / 2 + ${#s} / 2))
	hex="$(printf '30%02x02%02x%s02%02x%s' "$total" $((${#r} / 2)) "$r" $((${#s} / 2)) "$s")"
	# shellcheck disable=SC2059
	printf "$(printf '%s' "$hex" | sed 's/../\\x&/g')" > "$2"
}

# sd_firma_valida <key, spki DER in base64> <signed file> <signature in base64>
sd_firma_valida() {
	local clave=$1 fichero=$2 firma=$3 t=$SD_TMP/firma
	rm -rf "$t" && mkdir -p "$t" || return 1
	{
		echo '-----BEGIN PUBLIC KEY-----'
		printf '%s\n' "$clave" | fold -w 64
		echo '-----END PUBLIC KEY-----'
	} > "$t/clave.pem"
	sd_decodifica "$firma" "$t/firma" || return 1
	[[ "$(wc -c < "$t/firma")" -eq 64 ]] || return 1
	case $clave in
		MCowBQYDK2VwAyEA*)
			# Ed25519 (the legacy key and the backup keys). Needs OpenSSL 3.
			openssl pkeyutl -verify -pubin -inkey "$t/clave.pem" -rawin -in "$fichero" -sigfile "$t/firma" 2>/dev/null |
				grep -q '^Signature Verified Successfully'
			;;
		MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE*)
			# ECDSA P-256 with SHA-256 (the main keys, in the HSM).
			sd_ecdsa_der "$t/firma" "$t/firma.der" || return 1
			openssl dgst -sha256 -verify "$t/clave.pem" -signature "$t/firma.der" "$fichero" 2>/dev/null |
				grep -q '^Verified OK'
			;;
		*) return 1 ;;
	esac
}

# Reads what Central sent ($1) into $SD_TMP. Only known records are kept, every
# value is base64 and nothing is evaluated.
#   release <b64> | firma <b64> | firmas <key fingerprint> <b64>
#   fichero <name> <b64> | dato <NAME> <b64>
sd_leer() {
	local tipo a b resto
	while IFS=' ' read -r tipo a b resto || [[ -n $tipo ]]; do
		[[ -z ${resto:-} ]] || return 1
		case $tipo in
			release) sd_decodifica "$a" "$SD_TMP/release" || return 1 ;;
			firma)
				[[ $a =~ $SD_B64 ]] || return 1
				printf '%s' "$a" > "$SD_TMP/firma.b64"
				;;
			firmas)
				[[ $a =~ ^[0-9a-f]{16}$ && $b =~ $SD_B64 ]] || return 1
				printf '%s %s\n' "$a" "$b" >> "$SD_TMP/firmas"
				;;
			fichero)
				case " $SD_PIEZAS " in
					*" $a "*) sd_decodifica "$b" "$SD_TMP/piezas/$a" || return 1 ;;
				esac
				;;
			dato)
				[[ $a =~ ^[A-Z][A-Z0-9_]{0,40}$ ]] || return 1
				sd_decodifica "$b" "$SD_TMP/datos/$a" || return 1
				sd_una_linea "$SD_TMP/datos/$a" || return 1
				;;
		esac
	done < <(tail -n +2 "$1")
}

# sd_dato <NAME> <regex> [required]: prints the value if Central sent it and it has
# the expected form. Fails if it is malformed, or missing and required.
sd_dato() {
	local v=""
	if [[ -f $SD_TMP/datos/$1 ]]; then
		v="$(cat "$SD_TMP/datos/$1")"
		[[ ${#v} -le 4096 && $v =~ $2 ]] || { sd_di "Central sent a malformed value ($1)."; return 1; }
	elif [[ -n ${3:-} ]]; then
		sd_di "Central did not send a required value ($1)."
		return 1
	fi
	printf '%s' "$v"
}

# The signed release: signature, edition and the fingerprint of every piece.
# Leaves SD_VERSION and SD_FIRMADA_CON. Nothing here trusts Central.
sd_verificar_version() {
	local r=$SD_TMP/release clave huella firma n marca esperada real linea i=0
	[[ -s $r ]] || { sd_di "Central did not send a signed release."; return 1; }
	# One line of JSON, as it was signed: that is what lets it be stored again as it was.
	if ! sd_una_linea "$r" || [[ "$(head -c 12 "$r")" != '{"version":"' ]]; then
		sd_di "what Central sent is not a Sugardaddy release."
		return 1
	fi
	SD_FIRMADA_CON=""
	while IFS= read -r clave; do
		[[ -n $clave ]] || continue
		huella="$(sd_huella_clave "$clave")"
		if [[ -s $SD_TMP/firma.b64 ]] && sd_firma_valida "$clave" "$r" "$(cat "$SD_TMP/firma.b64")"; then
			SD_FIRMADA_CON=$huella
			break
		fi
		if [[ -s $SD_TMP/firmas ]]; then
			while read -r n firma; do
				if [[ $n == "$huella" ]] && sd_firma_valida "$clave" "$r" "$firma"; then
					SD_FIRMADA_CON=$huella
					break 2
				fi
			done < "$SD_TMP/firmas"
		fi
	done < <(sd_candidatas)
	if [[ -z $SD_FIRMADA_CON ]]; then
		sd_di "the release Central sent is NOT signed with a Sugardaddy publication key this installer trusts. Nothing was installed."
		if [[ "$(openssl version 2>/dev/null)" =~ ^OpenSSL\ [012]\. ]]; then
			sd_di "this machine has $(openssl version | cut -d' ' -f1-2); checking some signatures needs OpenSSL 3 (Ubuntu 22.04, Debian 12 or later)."
		fi
		return 1
	fi
	# The fingerprints of what gets installed, inside the signed text. In JSON, a quote
	# inside a text is always escaped, so this exact sequence can only be the field itself.
	marca="$(grep -o '"huellas":"v1;[A-Za-z0-9.=;_-]*"' "$r")"
	if [[ -z $marca || "$(printf '%s\n' "$marca" | wc -l)" -ne 1 ]]; then
		sd_di "the signed document Central sent is not an installable Sugardaddy release (older than this installer?)."
		return 1
	fi
	marca="${marca#\"huellas\":\"v1;}"
	marca=";${marca%\"};"
	for n in $SD_PIEZAS; do
		esperada="${marca#*";$n="}"
		esperada="${esperada%%;*}"
		[[ $marca == *";$n="* && $esperada =~ ^[0-9a-f]{64}$ ]] || { sd_di "the signed release does not state the fingerprint of $n."; return 1; }
		[[ -f $SD_TMP/piezas/$n ]] || { sd_di "Central did not send $n."; return 1; }
		real="$(sha256sum < "$SD_TMP/piezas/$n" | cut -c1-64)"
		if [[ $real != "$esperada" ]]; then
			sd_di "$n is NOT the one in the signed release (fingerprint $real, expected $esperada). Nothing was installed."
			return 1
		fi
	done
	# imagenes.env is signed through its fingerprint: the release number and its images.
	# A Cloud node only takes images, by digest, from the private Azure registry.
	local claves=(SUGARDADDY_VERSION CONSOLA_IMAGEN SENSOR_IMAGEN ACTUALIZADOR_IMAGEN)
	while IFS= read -r linea || [[ -n $linea ]]; do
		[[ $i -lt 4 && ${linea%%=*} == "${claves[$i]}" ]] || { sd_di "the signed release has an unexpected list of images."; return 1; }
		if [[ $i == 0 ]]; then
			SD_VERSION="${linea#*=}"
			[[ $SD_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { sd_di "the signed release has a malformed version number."; return 1; }
		elif [[ ! ${linea#*=} =~ ^[a-z0-9.-]+\.azurecr\.io/[a-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$ ]]; then
			sd_di "the signed release is not a Sugardaddy Cloud release (its images are not in the Cloud registry). Nothing was installed."
			return 1
		fi
		i=$((i + 1))
	done < "$SD_TMP/piezas/imagenes.env"
	[[ $i == 4 ]] || { sd_di "the signed release has an unexpected list of images."; return 1; }
	while IFS= read -r linea || [[ -n $linea ]]; do
		[[ $linea =~ ^nueva\ [A-Z][A-Z0-9_]{0,63}=.*$ || $linea =~ ^generar\ [A-Z][A-Z0-9_]{0,63}$ ]] ||
			{ sd_di "the signed release has a malformed list of settings."; return 1; }
	done < "$SD_TMP/piezas/entorno.txt"
}

# The folder instalar.sh runs from: only verified pieces, the keys of this file and
# this customer's values, already checked one by one.
sd_preparar() {
	local d=$SD_TMP/nodo n linea firmas="" huella firma
	mkdir -p "$d" || return 1
	for n in instalar.sh copia.sh restaurar.sh compose.yml Caddyfile; do
		cp "$SD_TMP/piezas/$n" "$d/$n" || return 1
	done
	# The keys the node keeps: the ones in this file, never anything Central sent.
	{
		cat "$SD_TMP/piezas/imagenes.env"
		echo "PUBLICACION_CLAVES=$SD_CLAVES"
		echo "PUBLICACION_CLAVE_PUBLICA=$SD_LEGADO"
	} > "$d/imagenes.env"
	{
		echo "EDICION=$SD_EDICION"
		for n in PARTNER REGISTRO_PARTNER REGISTRO_PARTNER_USUARIO REGISTRO_PARTNER_TOKEN; do
			[[ -f $SD_TMP/datos/$n ]] || continue
			linea="$(sd_dato "$n" '^[!-~]*$')" || return 1
			echo "$n=$linea"
		done
		while IFS= read -r linea || [[ -n $linea ]]; do
			case $linea in
				nueva\ *) echo "${linea#nueva }" ;;
				generar\ *) echo "${linea#generar }=$(openssl rand -hex 32)" ;;
			esac
		done < "$SD_TMP/piezas/entorno.txt"
	} > "$d/entorno-extra.env" || return 1
	# The signed release, as the updater and the sensor expect it: they check it again
	# with the keys above. Its text has no control characters (checked), so escaping
	# backslashes and quotes gives back exactly what was signed.
	if [[ -s $SD_TMP/firmas ]]; then
		while read -r huella firma; do
			firmas="$firmas${firmas:+,}{\"clave\":\"$huella\",\"firma\":\"$firma\"}"
		done < "$SD_TMP/firmas"
	fi
	{
		printf '{"release":"'
		sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' "$SD_TMP/release" | tr -d '\n'
		printf '","firma":"%s"' "$(cat "$SD_TMP/firma.b64" 2>/dev/null)"
		[[ -z $firmas ]] || printf ',"firmas":[%s]' "$firmas"
		printf '}'
	} > "$d/version-firmada.json"
}

sd_instalar() {
	local url="${1:-}" codigo="${2:-}" panel="" operador="whoever gave you this line"
	local pin="${SUGARDADDY_PIN:-}" preguntar=no t rc primera v
	local nodo cliente dominio huella_panel

	if [[ $url =~ ^(https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?)/instalar/([A-Za-z0-9_-]{32})/?$ ]]; then
		panel="${BASH_REMATCH[1]}" codigo="${BASH_REMATCH[3]}"
	elif [[ $url =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$ && $codigo =~ ^[A-Za-z0-9_-]{32}$ ]]; then
		panel="${url%/}"
	else
		echo "Usage: sudo bash sugardaddy-install.sh https://<central>/instalar/<code>" >&2
		return 1
	fi
	if [[ $panel != https://* && ${PANEL_HTTP_PERMITIDO:-} != 1 ]]; then
		sd_di "Central must use HTTPS: the address starts with https://."
		return 1
	fi
	if [[ "$(id -u)" != 0 ]]; then
		echo "Run it with sudo:  sudo bash sugardaddy-install.sh $panel/instalar/<code>" >&2
		return 1
	fi
	for v in curl openssl base64 sha256sum od sed grep fold; do
		if ! command -v "$v" > /dev/null; then
			sd_di "$v is required. Install it and run the line again: it is still valid."
			return $SD_SIGUE
		fi
	done
	if [[ -z $SD_CLAVES && -z $SD_LEGADO ]]; then
		sd_di "this copy of the installer has no publication keys: it is not a published one. Download it again from Central or from the Sugardaddy documentation."
		return $SD_SIGUE
	fi

	# Global: the trap runs after this function has returned.
	SD_TMP="$(mktemp -d)" || return $SD_SIGUE
	trap 'rm -rf "$SD_TMP"' EXIT
	chmod 700 "$SD_TMP"
	mkdir -p "$SD_TMP/piezas" "$SD_TMP/datos"
	t=$SD_TMP

	# 1. The signed release and its files, as data. It uses nothing up.
	if ! curl -fsS --connect-timeout 15 --max-time 300 --max-filesize 8388608 \
		-o "$t/version" "$panel/instalar/$codigo/datos"; then
		sd_di "could not reach Central at $panel. Try again in a few minutes: the line is still valid."
		return $SD_SIGUE
	fi
	IFS=' ' read -r primera v rc < "$t/version" || true
	case "$primera ${v:-}" in
		"sugardaddy-version 1") ;;
		sugardaddy-error\ *)
			sd_di "$(printf '%s' "${rc:-}" | sd_texto)"
			[[ $v == sigue ]] && return $SD_SIGUE
			return 1
			;;
		*)
			sd_di "what $panel returned is not a Sugardaddy Central answer (is there a proxy in between, or is Central older than this installer?). The line is still valid."
			return $SD_SIGUE
			;;
	esac
	if ! sd_leer "$t/version"; then
		sd_di "what Central returned is malformed. Try again in a few minutes: the line is still valid."
		return $SD_SIGUE
	fi
	# 2. Signature, edition and fingerprints. If this fails, the line was not used up,
	# but running it again will not help: it is Central that is serving something wrong.
	if ! sd_verificar_version; then
		sd_di "Do not try other ways to install: tell $operador, and SeguridadSI (contacto@seguridadsi.com), that the installer refused what Central served."
		return 1
	fi
	echo "Sugardaddy $SD_VERSION: release signature verified (publication key $SD_FIRMADA_CON)."

	# 3. This customer's data, with the PIN. This is what uses up the line.
	if [[ -z $pin ]]; then
		if ! (: < /dev/tty) 2> /dev/null; then
			if [[ -f /etc/sugardaddy/appliance.env ]]; then
				sd_di "this line needs the 6-digit PIN you were given separately, and unattended enrollment cannot ask for it. Enroll from this machine's screen (option 1) with the same code: it is still valid."
			else
				sd_di "this line needs the 6-digit PIN you were given separately, and there is no terminal to ask for it. Run it from a terminal, or pass the PIN: sudo SUGARDADDY_PIN=<PIN> bash sugardaddy-install.sh $panel/instalar/<code>. The line is still valid."
			fi
			return $SD_SIGUE
		fi
		preguntar=si
	fi
	for _ in 1 2 3 4 5 6; do
		if [[ $preguntar == si ]]; then
			printf 'PIN you were given separately (6 digits): ' > /dev/tty
			IFS= read -r pin < /dev/tty || pin=""
		fi
		# As it is read out: "123 456" or "123-456" also work.
		pin="${pin//[[:space:]-]/}"
		if [[ ! $pin =~ ^[0-9]{6}$ ]]; then
			sd_di "the PIN has 6 digits."
			[[ $preguntar == si ]] && continue
			return $SD_SIGUE
		fi
		rm -f "$t/cliente"
		# The PIN goes in through stdin, not on the command line, where ps would show it.
		if ! curl -fsS --connect-timeout 15 --max-time 300 --max-filesize 1048576 -X POST \
			-H 'Content-Type: application/json' --data-binary @- \
			-o "$t/cliente" "$panel/instalar/$codigo/datos" <<< "{\"pin\":\"$pin\"}"; then
			sd_di "could not download this installation's data from Central. Try again in a few minutes; if it then says the line was already used, ask for a new one."
			return $SD_SIGUE
		fi
		primera="" v="" rc=""
		IFS=' ' read -r primera v rc < "$t/cliente" || true
		case "$primera ${v:-}" in
			"sugardaddy-datos 1") break ;;
			"sugardaddy-error pin")
				sd_di "$(printf '%s' "${rc:-}" | sd_texto)"
				[[ $preguntar == si ]] && continue
				return $SD_SIGUE
				;;
			sugardaddy-error\ *)
				sd_di "$(printf '%s' "${rc:-}" | sd_texto)"
				[[ $v == sigue ]] && return $SD_SIGUE
				return 1
				;;
			*)
				sd_di "what Central returned is not a Sugardaddy Central answer. Try again in a few minutes."
				return $SD_SIGUE
				;;
		esac
	done
	[[ "$primera ${v:-}" == "sugardaddy-datos 1" ]] || return $SD_SIGUE
	local usada="This line has already been used: ask for a new one."
	if ! sd_leer "$t/cliente"; then
		sd_di "what Central returned is malformed. $usada"
		return 1
	fi
	nodo="$(sd_dato NODO '^[a-z0-9][a-z0-9-]{0,62}$' si)" || { sd_di "$usada"; return 1; }
	dominio="$(sd_dato DOMINIO '^[a-z0-9.-]{1,253}$' si)" || { sd_di "$usada"; return 1; }
	cliente="$(sd_dato CLIENTE '^.{1,600}$' si)" || { sd_di "$usada"; return 1; }
	huella_panel="$(sd_dato HUELLA_PANEL '^[0-9a-f]{16}$')" || { sd_di "$usada"; return 1; }
	REGISTRO="$(sd_dato REGISTRO '^[A-Za-z0-9.:-]{1,253}$' si)" || { sd_di "$usada"; return 1; }
	REGISTRO_USUARIO="$(sd_dato REGISTRO_USUARIO '^[!-~]*$' si)" || { sd_di "$usada"; return 1; }
	REGISTRO_TOKEN="$(sd_dato REGISTRO_TOKEN '^[!-~]*$' si)" || { sd_di "$usada"; return 1; }
	PANEL_ALTA_CODIGO="$(sd_dato PANEL_ALTA_CODIGO '^[A-Za-z0-9_-]{1,200}$' si)" || { sd_di "$usada"; return 1; }
	TRAMPAS_DESPLAZAR="$(sd_dato TRAMPAS_DESPLAZAR '^[0-9]{1,5}$')" || { sd_di "$usada"; return 1; }
	export REGISTRO REGISTRO_USUARIO REGISTRO_TOKEN PANEL_ALTA_CODIGO
	export TRAMPAS_DESPLAZAR="${TRAMPAS_DESPLAZAR:-0}"
	for v in ENTRA_TENANT_ID ENTRA_CLIENT_ID ENTRA_CLIENT_SECRET ENTRA_GRUPO_CLIENTE ENTRA_GRUPO_SOPORTE; do
		[[ -f $t/datos/$v ]] || continue
		rc="$(sd_dato "$v" '^[!-~]*$')" || { sd_di "$usada"; return 1; }
		export "$v=$rc"
	done
	# Central is the address you typed, not one it sent back.
	export PANEL_URL="$panel" SUGARDADDY_CONFIGURACION="$SD_VERSION"
	# The Sugardaddy virtual machine has no SSH and no local DNS: decoys use their real ports.
	if [[ -f /etc/sugardaddy/appliance.env ]]; then export TRAMPAS_DESPLAZAR=0; fi
	if ! sd_preparar; then
		sd_di "could not prepare the installation. $usada"
		return 1
	fi

	# 4. The verified instalar.sh. With bash and not by running the file: on a hardened
	# Linux /tmp is mounted noexec.
	bash "$t/nodo/instalar.sh" "${SUGARDADDY_DIR:-/opt/sugardaddy}" "$nodo" "$cliente" "$dominio" < /dev/null
	rc=$?
	# 75 only means "still valid" when this stage says so, not when the installation ends that way.
	((rc == SD_SIGUE)) && rc=1
	((rc == 0)) || return "$rc"
	echo
	[[ -z $huella_panel ]] || echo "Check in the console, under Settings, that the Central fingerprint is: $huella_panel"
	return 0
}

sd_instalar "$@"
exit $?
