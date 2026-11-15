# --- proxy de salida (docs/diseno/proxy-salida.md) ---
SD_PROXY="" SD_NO_PROXY="" SD_PROXY_CLIENTE="" SD_PROXY_CA="" SD_PROXY_CAMBIO=""
sd_proxy_de_env() { # carpeta clave
	[[ -f "$1/.env" ]] && grep "^$2=" "$1/.env" | head -1 | cut -d= -f2- || true
}
sd_proxy_preparar() { # carpeta excepciones-propias…
	local dir="$1" x pem forma='^https?://([A-Za-z0-9._~%!*+,;=:-]+@)?[A-Za-z0-9.-]+(:[0-9]{1,5})?$'
	shift
	SD_PROXY="${SUGARDADDY_PROXY:-${HTTPS_PROXY:-${https_proxy:-$(sd_proxy_de_env "$dir" PROXY_SALIDA)}}}"
	[[ "$SD_PROXY" == none ]] && SD_PROXY=""
	SD_PROXY="${SD_PROXY%/}"
	if [[ -n "$SD_PROXY" && ! "$SD_PROXY" =~ $forma ]]; then
		echo "Sugardaddy: the proxy must look like http://proxy.example.com:3128 or http://user:password@proxy.example.com:3128, with any special character of the user or the password percent-encoded (\$ as %24, @ as %40). (code proxy.forma)" >&2
		return 1
	fi
	SD_PROXY_CLIENTE="${SUGARDADDY_NO_PROXY:-${NO_PROXY:-${no_proxy:-$(sd_proxy_de_env "$dir" PROXY_EXCEPCIONES_CLIENTE)}}}"
	[[ "$SD_PROXY_CLIENTE" == none ]] && SD_PROXY_CLIENTE=""
	SD_PROXY_CLIENTE="$(printf '%s' "$SD_PROXY_CLIENTE" | tr ' ;' ',,' | tr -cd 'A-Za-z0-9.,:/*_-' | tr -s ',' | sed -e 's/^,//' -e 's/,$//')"
	SD_NO_PROXY="localhost,127.0.0.1,::1,consola,postgres,https,sensor,actualizador"
	for x in "$@" "$SD_PROXY_CLIENTE"; do [[ -n "$x" ]] && SD_NO_PROXY+=",$x"; done
	mkdir -p "$dir/proxy"
	chmod 755 "$dir/proxy"
	if [[ "${SUGARDADDY_PROXY_CA:-}" == none ]]; then
		rm -f "$dir/proxy/ca.crt"
	elif [[ -n "${SUGARDADDY_PROXY_CA:-}" ]]; then
		# Solo certificados, todos los del fichero (raíz e intermedias), sin nada más.
		pem="$(openssl crl2pkcs7 -nocrl -certfile "$SUGARDADDY_PROXY_CA" 2>/dev/null | openssl pkcs7 -print_certs 2>/dev/null | sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p')"
		if [[ -z "$pem" ]]; then
			echo "Sugardaddy: $SUGARDADDY_PROXY_CA is not a PEM certificate. Give the proxy CA (the root your company installs on its computers) in PEM form. (code proxy.ca)" >&2
			return 1
		fi
		[[ "$(cat "$dir/proxy/ca.crt" 2>/dev/null)" == "$pem" ]] || SD_PROXY_CAMBIO=1
		printf '%s\n' "$pem" > "$dir/proxy/ca.crt.tmp"
		chmod 644 "$dir/proxy/ca.crt.tmp"
		mv "$dir/proxy/ca.crt.tmp" "$dir/proxy/ca.crt"
	fi
	SD_PROXY_CA=""
	[[ -s "$dir/proxy/ca.crt" ]] && SD_PROXY_CA=1
	if [[ -n "$SD_PROXY" ]]; then
		export http_proxy="$SD_PROXY" https_proxy="$SD_PROXY" HTTP_PROXY="$SD_PROXY" HTTPS_PROXY="$SD_PROXY"
		export no_proxy="$SD_NO_PROXY" NO_PROXY="$SD_NO_PROXY"
		echo "==> Outbound proxy: $(printf '%s' "$SD_PROXY" | sed -E 's#//[^@]*@#//***@#')"
	else
		unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY
	fi
}
sd_proxy_sistema() { # carpeta: apt y el almacén de CA del sistema
	local dir="$1" ancla="" orden=""
	if [[ -d /etc/apt/apt.conf.d ]]; then
		if [[ -n "$SD_PROXY" ]]; then
			printf 'Acquire::http::Proxy "%s";\nAcquire::https::Proxy "%s";\n' "$SD_PROXY" "$SD_PROXY" > /etc/apt/apt.conf.d/95sugardaddy-proxy
			chmod 600 /etc/apt/apt.conf.d/95sugardaddy-proxy
		else
			rm -f /etc/apt/apt.conf.d/95sugardaddy-proxy
		fi
	fi
	if [[ -d /usr/local/share/ca-certificates ]] && command -v update-ca-certificates >/dev/null; then
		ancla=/usr/local/share/ca-certificates/sugardaddy-proxy.crt orden="update-ca-certificates"
	elif [[ -d /etc/pki/ca-trust/source/anchors ]] && command -v update-ca-trust >/dev/null; then
		ancla=/etc/pki/ca-trust/source/anchors/sugardaddy-proxy.crt orden="update-ca-trust"
	fi
	[[ -n "$ancla" ]] || { [[ -z "$SD_PROXY_CA" ]] || echo "Sugardaddy: this system has no CA store this installer knows; add $dir/proxy/ca.crt to it by hand." >&2; return 0; }
	if [[ -n "$SD_PROXY_CA" ]]; then
		cmp -s "$dir/proxy/ca.crt" "$ancla" || { install -m 644 "$dir/proxy/ca.crt" "$ancla" && $orden >/dev/null 2>&1 && SD_PROXY_CAMBIO=1; }
	elif [[ -f "$ancla" ]]; then
		rm -f "$ancla" && $orden >/dev/null 2>&1 && SD_PROXY_CAMBIO=1
	fi
	return 0
}
sd_proxy_docker() { # el motor de Docker descarga las imágenes: necesita el proxy y relee la CA al arrancar
	local f=/etc/systemd/system/docker.service.d/sugardaddy-proxy.conf nuevo=""
	command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] || {
		[[ -z "$SD_PROXY" ]] || echo "Sugardaddy: this machine does not run systemd: set the proxy for the Docker engine by hand (docs: outbound proxy)." >&2
		return 0
	}
	if [[ -n "$SD_PROXY" ]]; then
		nuevo="$(printf '[Service]\nEnvironment="HTTP_PROXY=%s" "HTTPS_PROXY=%s" "NO_PROXY=%s"\n' "${SD_PROXY//%/%%}" "${SD_PROXY//%/%%}" "$SD_NO_PROXY")"
	fi
	if [[ "$(cat "$f" 2>/dev/null)" != "$nuevo" ]]; then
		if [[ -n "$nuevo" ]]; then
			mkdir -p "${f%/*}" && (umask 077 && printf '%s\n' "$nuevo" > "$f")
		else
			rm -f "$f"
		fi
		SD_PROXY_CAMBIO=1
	fi
	if [[ -n "$SD_PROXY_CAMBIO" ]] && systemctl cat docker.service >/dev/null 2>&1; then
		echo "==> Restarting Docker with the proxy settings"
		systemctl daemon-reload
		# En una máquina lenta el motor anterior tarda en soltar su pid y el arranque falla
		# («process … is still running»): se reintenta hasta un par de minutos. Si systemd
		# ya lo da por parado y su dockerd sigue vivo fuera de la unidad (visto en máquinas
		# emuladas), nada lo va a parar: se le pide que acabe y, si no, se le corta.
		local i viejo
		for i in $(seq 1 24); do
			systemctl restart docker 2>/dev/null && docker info >/dev/null 2>&1 && break
			viejo="$(cat /var/run/docker.pid 2>/dev/null || true)"
			if [[ "$viejo" =~ ^[0-9]+$ ]] && ! systemctl is-active -q docker \
				&& [[ "$(cat "/proc/$viejo/comm" 2>/dev/null)" == dockerd ]]; then
				kill -TERM "$viejo" 2>/dev/null || true
				sleep 20
				kill -0 "$viejo" 2>/dev/null && kill -KILL "$viejo" 2>/dev/null || true
			fi
			sleep 5
			systemctl reset-failed docker 2>/dev/null || true
		done
		docker info >/dev/null 2>&1 || { echo "Sugardaddy: Docker did not start again with the proxy settings: check «journalctl -u docker». (code proxy.docker)" >&2; return 1; }
		SD_PROXY_CAMBIO=""
	fi
	return 0
}
sd_proxy_env() { # fichero .env
	local k v
	for k in PROXY_SALIDA PROXY_EXCEPCIONES PROXY_EXCEPCIONES_CLIENTE PROXY_CA; do
		case $k in
			PROXY_SALIDA) v="$SD_PROXY" ;;
			PROXY_EXCEPCIONES) v="" && [[ -z "$SD_PROXY" ]] || v="$SD_NO_PROXY" ;;
			PROXY_EXCEPCIONES_CLIENTE) v="$SD_PROXY_CLIENTE" ;;
			PROXY_CA) v="$SD_PROXY_CA" ;;
		esac
		{ grep -v "^$k=" "$1" || true; echo "$k=$v"; } > "$1.tmp"
		chmod 600 "$1.tmp" && mv "$1.tmp" "$1"
	done
}
# Deja en la carpeta un proxy.sh para cambiar o quitar el proxy después, sin la línea de
# instalación (que es de un solo uso): sudo SUGARDADDY_PROXY=… <carpeta>/proxy.sh
sd_proxy_guion() { # carpeta
	{
		echo '#!/usr/bin/env bash'
		echo '# Cambia el proxy de salida de este nodo o sensor (docs: outbound proxy). Lo escribe su instalador.'
		echo '#   sudo SUGARDADDY_PROXY=http://[user:password@]proxy:3128 [SUGARDADDY_NO_PROXY=…] [SUGARDADDY_PROXY_CA=ca.pem] ./proxy.sh'
		echo '#   sudo SUGARDADDY_PROXY=none ./proxy.sh'
		echo 'set -Eeuo pipefail'
		echo 'SD_PROXY="" SD_NO_PROXY="" SD_PROXY_CLIENTE="" SD_PROXY_CA="" SD_PROXY_CAMBIO=""'
		declare -f sd_proxy_de_env sd_proxy_preparar sd_proxy_sistema sd_proxy_docker sd_proxy_env
		cat <<'FIN'
[[ "$(id -u)" == 0 ]] || { echo "Run it with sudo" >&2; exit 1; }
[[ -n "${SUGARDADDY_PROXY:-}${SUGARDADDY_NO_PROXY:-}${SUGARDADDY_PROXY_CA:-}" ]] || { sed -n '3,4p' "$0" | cut -c3- >&2; exit 1; }
DIR="$(cd "$(dirname "$0")" && pwd)"
url="$(sd_proxy_de_env "$DIR" CONSOLA_URL)" url="${url#*://}"
fija="$(sd_proxy_de_env "$DIR" CONSOLA_FIJA)"
sd_proxy_preparar "$DIR" "$(sd_proxy_de_env "$DIR" CONSOLA_DOMINIO)" "${url%%[:/]*}" "${fija#*:}" "$(sd_proxy_de_env "$DIR" SENSOR_LOCAL_RED)"
sd_proxy_sistema "$DIR"
sd_proxy_docker
sd_proxy_env "$DIR/.env"
cd "$DIR" && docker compose --env-file .env --env-file versiones.env up -d --wait >/dev/null
echo "Done: the outbound proxy is applied."
FIN
	} > "$1/proxy.sh.tmp"
	chmod 700 "$1/proxy.sh.tmp" && mv "$1/proxy.sh.tmp" "$1/proxy.sh"
}
# --- fin del proxy de salida ---
