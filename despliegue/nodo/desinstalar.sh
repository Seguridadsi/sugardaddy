#!/usr/bin/env bash
# Remove a Sugardaddy node from this machine, with everything the installer and the
# sensor left on it.
#
#   sudo despliegue/nodo/desinstalar.sh [folder] [--dry-run] [--yes] [--keep-backups]
#
#   folder          the node's folder (default /opt/sugardaddy)
#   --dry-run       list what would be removed and change nothing
#   --yes           do not ask for confirmation (unattended)
#   --keep-backups  leave <folder>/copias in place
#
# It removes: the node's containers, decoys, probes and helpers; their networks and
# volumes (ALL the node's data: events, settings, users); the node's images; the
# decoy disks; the node's firewall rules (chains SD-CONSOLA and SD-TRAMPAS, and the
# strict host firewall's nftables table); the AppArmor profile; the
# systemd units and cron entry it installed; the outbound proxy settings it wrote;
# and the node's folders. It does not uninstall Docker, and it touches no rule,
# container or file that is not Sugardaddy's. If you built the images from source,
# the base images the build pulled stay (docker image prune -a removes them).
#
# There is no way back: make a backup first if you may want the data
# (docs/OPERATIONS.md, «Backups»), and keep it, with its key, off this machine.
set -uo pipefail

DIR=/opt/sugardaddy SIMULAR="" SIN_PREGUNTAR="" CONSERVAR_COPIAS=""
for a in "$@"; do
	case "$a" in
	--dry-run) SIMULAR=1 ;;
	--yes) SIN_PREGUNTAR=1 ;;
	--keep-backups) CONSERVAR_COPIAS=1 ;;
	-h | --help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
	-*) echo "Unknown option: $a" >&2; exit 1 ;;
	*) DIR="$a" ;;
	esac
done
DIR="${DIR%/}"

[[ "$(id -u)" == 0 ]] || { echo "Run it as root: sudo $0 $*" >&2; exit 1; }
case "$DIR" in
"" | / | /usr | /usr/* | /etc | /etc/* | /var | /home | /root | /bin | /sbin | /boot | /lib*)
	echo "Refusing to remove $DIR: give the node's own folder (usually /opt/sugardaddy)." >&2
	exit 1
	;;
esac
if [[ -d "$DIR" && ! -f "$DIR/compose.yml" && ! -f "$DIR/.env" ]]; then
	echo "$DIR does not look like a Sugardaddy node (no compose.yml or .env): nothing removed." >&2
	exit 1
fi

HAY_DOCKER=""
command -v docker >/dev/null && docker info >/dev/null 2>&1 && HAY_DOCKER=1
HAY_SYSTEMD=""
[[ -d /run/systemd/system ]] && command -v systemctl >/dev/null && HAY_SYSTEMD=1

# What there is, gathered before anything changes.
ETIQUETAS=(sugardaddy.trampa sugardaddy.sonda sugardaddy.captura sugardaddy.auxiliar sugardaddy.sensor sugardaddy.servicio sugardaddy.senuelo)
CONTENEDORES=() REDES=() VOLUMENES=() IMAGENES=()
if [[ -n "$HAY_DOCKER" ]]; then
	mapfile -t CONTENEDORES < <(
		{
			docker ps -aq --filter label=com.docker.compose.project=sugardaddy
			for e in "${ETIQUETAS[@]}"; do docker ps -aq --filter "label=$e"; done
			docker ps -aq --filter name=^sd-local-
		} | sort -u
	)
	mapfile -t REDES < <(
		{
			docker network ls -q --filter label=com.docker.compose.project=sugardaddy
			for e in "${ETIQUETAS[@]}"; do docker network ls -q --filter "label=$e"; done
			docker network ls --format '{{.ID}} {{.Name}}' | awk '$2 ~ /^(sugardaddy[-_]|sd-trampas)/ { print $1 }'
		} | sort -u
	)
	mapfile -t VOLUMENES < <(
		{
			docker volume ls -q --filter label=com.docker.compose.project=sugardaddy
			for e in "${ETIQUETAS[@]}"; do docker volume ls -q --filter "label=$e"; done
			docker volume ls -q | grep -E '^(sugardaddy_|sd_(disco|captura|sonda|trampa)_)' || true
		} | sort -u
	)
	# By id: an image pulled by digest has no tag to remove it by. Ours by name, and
	# whatever the node's containers run (the database and web server it pulled).
	mapfile -t IMAGENES < <(
		{
			docker image ls --no-trunc --format '{{.ID}} {{.Repository}}' |
				awk '$2 ~ /(^|\/)sugardaddy-(consola|sensor|actualizador|trampa)/ { print $1 }'
			for c in ${CONTENEDORES[@]+"${CONTENEDORES[@]}"}; do docker inspect -f '{{.Image}}' "$c" 2>/dev/null; done
		} | sort -u
	)
fi

FICHEROS=(
	/etc/apparmor.d/sugardaddy-trampa
	/etc/systemd/system/sd-discos.service
	/etc/systemd/system/sd-discos.path
	/etc/systemd/system/sugardaddy-copias.service
	/etc/systemd/system/sugardaddy-copias.timer
	/etc/cron.d/sugardaddy-copias
	/etc/apt/apt.conf.d/95sugardaddy-proxy
	/etc/systemd/system/docker.service.d/sugardaddy-proxy.conf
	/usr/local/share/ca-certificates/sugardaddy-proxy.crt
	/etc/pki/ca-trust/source/anchors/sugardaddy-proxy.crt
)
PRESENTES=()
for f in "${FICHEROS[@]}"; do [[ -e "$f" ]] && PRESENTES+=("$f"); done
CARPETAS=()
[[ -d "$DIR" ]] && CARPETAS+=("$DIR")
[[ -d /var/lib/sugardaddy ]] && CARPETAS+=(/var/lib/sugardaddy)
[[ -d /usr/local/lib/sugardaddy ]] && CARPETAS+=(/usr/local/lib/sugardaddy)

# Decoy disks still mounted under the node's folders.
MONTAJES=()
if command -v findmnt >/dev/null; then
	mapfile -t MONTAJES < <(findmnt -rn -o TARGET | awk -v d="$DIR/" '
		index($0, d) == 1 || index($0, "/var/lib/sugardaddy/") == 1' | sort -r)
fi

# The node's firewall rules, in every iptables backend and family that has them:
# SD-CONSOLA (who can open the console, from DOCKER-USER and INPUT) and SD-TRAMPAS
# (decoys cannot reach the host, from INPUT); and the nftables table of the strict
# host firewall, if it was turned on.
CADENAS=(SD-CONSOLA SD-TRAMPAS)
REGLAS=()
for t in iptables-nft iptables-legacy ip6tables-nft ip6tables-legacy; do
	command -v "$t" >/dev/null || continue
	for c in "${CADENAS[@]}"; do
		"$t" -w -t filter -S "$c" >/dev/null 2>&1 && REGLAS+=("$t $c")
	done
done
TABLA_NFT=""
command -v nft >/dev/null && nft list table inet sugardaddy >/dev/null 2>&1 && TABLA_NFT=1

lista() { # title, items...
	local titulo=$1
	shift
	(($#)) || return 0
	echo "$titulo"
	printf '  %s\n' "$@"
}

echo "Sugardaddy node in $DIR. This will remove:"
echo
lista "Containers (console, sensor, updater, database, decoys, probes):" \
	$(for c in ${CONTENEDORES[@]+"${CONTENEDORES[@]}"}; do docker inspect -f '{{.Name}}' "$c" 2>/dev/null | tr -d /; done)
lista "Networks:" $(for r in ${REDES[@]+"${REDES[@]}"}; do docker network inspect -f '{{.Name}}' "$r" 2>/dev/null; done)
lista "Volumes (all the node's data):" ${VOLUMENES[@]+"${VOLUMENES[@]}"}
lista "Images:" $(for i in ${IMAGENES[@]+"${IMAGENES[@]}"}; do docker image inspect -f '{{range .RepoTags}}{{.}} {{end}}{{if not .RepoTags}}{{index .RepoDigests 0}}{{end}}' "$i" 2>/dev/null; done)
lista "Mounted decoy disks:" ${MONTAJES[@]+"${MONTAJES[@]}"}
lista "Firewall chains (backend and chain):" ${REGLAS[@]+"${REGLAS[@]}"}
[[ -n "$TABLA_NFT" ]] && lista "Strict host firewall:" "nftables table inet sugardaddy"
lista "Files:" ${PRESENTES[@]+"${PRESENTES[@]}"}
lista "Folders:" ${CARPETAS[@]+"${CARPETAS[@]}"}
[[ -n "$CONSERVAR_COPIAS" && -d "$DIR/copias" ]] && echo "Kept: $DIR/copias (--keep-backups)"
[[ -n "$HAY_DOCKER" ]] || echo "(Docker does not answer here: containers, networks, volumes and images are not listed.)"
echo
echo "Docker itself stays installed."

if [[ -n "$SIMULAR" ]]; then
	echo
	echo "Dry run: nothing was changed."
	exit 0
fi
if [[ -z "$SIN_PREGUNTAR" ]]; then
	echo
	echo "There is no way back. Type the node's folder ($DIR) to confirm:"
	read -r respuesta
	[[ "$respuesta" == "$DIR" ]] || { echo "Not confirmed: nothing was changed."; exit 1; }
fi

FALLOS=0
hacer() { # description, command...
	local que=$1
	shift
	if ! "$@" >/dev/null 2>&1; then
		echo "  could not: $que"
		FALLOS=1
	fi
}

echo
echo "==> Stopping the node's services"
if [[ -n "$HAY_SYSTEMD" ]]; then
	for u in sd-discos.path sd-discos.service sugardaddy-copias.timer sugardaddy-copias.service; do
		systemctl disable --now "$u" >/dev/null 2>&1 || true
	done
fi

if [[ -n "$HAY_DOCKER" ]]; then
	echo "==> Removing containers"
	# The updater first, so it does not bring anything back while the rest goes.
	docker ps -aq --filter label=com.docker.compose.service=actualizador | xargs -r docker rm -f >/dev/null 2>&1
	((${#CONTENEDORES[@]})) && hacer "remove some containers" docker rm -f -v "${CONTENEDORES[@]}"
fi

echo "==> Unmounting decoy disks"
for m in ${MONTAJES[@]+"${MONTAJES[@]}"}; do hacer "unmount $m" umount -l "$m"; done
if command -v losetup >/dev/null; then
	losetup -n -O NAME,BACK-FILE 2>/dev/null | awk -v d="$DIR/" '
		index($2, d) == 1 || index($2, "/var/lib/sugardaddy/") == 1 { print $1 }' |
		while read -r dev; do losetup -d "$dev" >/dev/null 2>&1 || true; done
fi

if [[ -n "$HAY_DOCKER" ]]; then
	echo "==> Removing networks, volumes and images"
	for r in ${REDES[@]+"${REDES[@]}"}; do hacer "remove network $r" docker network rm "$r"; done
	((${#VOLUMENES[@]})) && hacer "remove some volumes" docker volume rm -f "${VOLUMENES[@]}"
	for i in ${IMAGENES[@]+"${IMAGENES[@]}"}; do
		# One that another container on this machine still uses stays.
		[[ -z "$(docker ps -aq --filter "ancestor=$i")" ]] || { echo "  kept, another container uses it: $i"; continue; }
		hacer "remove image $i" docker image rm -f "$i"
	done
fi

echo "==> Removing the node's firewall rules"
for par in ${REGLAS[@]+"${REGLAS[@]}"}; do
	t="${par% *}" c="${par#* }"
	for padre in DOCKER-USER INPUT FORWARD; do
		while n="$("$t" -w -t filter -S "$padre" 2>/dev/null | grep -n -- "-j $c\$" | head -1 | cut -d: -f1)" && [[ -n "$n" ]]; do
			# -S prints the chain policy or its -N line first: rule k is line k+1.
			"$t" -w -t filter -D "$padre" $((n - 1)) >/dev/null 2>&1 || break
		done
	done
	hacer "flush $c ($t)" "$t" -w -t filter -F "$c"
	hacer "delete $c ($t)" "$t" -w -t filter -X "$c"
done
[[ -n "$TABLA_NFT" ]] && hacer "delete the nftables table inet sugardaddy" nft delete table inet sugardaddy

echo "==> Removing files and folders"
if [[ -e /etc/apparmor.d/sugardaddy-trampa ]] && command -v apparmor_parser >/dev/null; then
	apparmor_parser -R /etc/apparmor.d/sugardaddy-trampa >/dev/null 2>&1 || true
fi
for f in ${PRESENTES[@]+"${PRESENTES[@]}"}; do hacer "remove $f" rm -f "$f"; done
if [[ " ${PRESENTES[*]-} " == *" /etc/systemd/system/docker.service.d/sugardaddy-proxy.conf "* && -n "$HAY_SYSTEMD" ]]; then
	systemctl daemon-reload >/dev/null 2>&1
	echo "  Docker was set to go out through the proxy; restart it when convenient: systemctl restart docker"
fi
[[ -n "$HAY_SYSTEMD" ]] && systemctl daemon-reload >/dev/null 2>&1
if [[ " ${PRESENTES[*]-} " == *"sugardaddy-proxy.crt "* ]]; then
	command -v update-ca-certificates >/dev/null && update-ca-certificates --fresh >/dev/null 2>&1
	command -v update-ca-trust >/dev/null && update-ca-trust >/dev/null 2>&1
fi
for c in ${CARPETAS[@]+"${CARPETAS[@]}"}; do
	if [[ "$c" == "$DIR" && -n "$CONSERVAR_COPIAS" && -d "$DIR/copias" ]]; then
		find "$DIR" -mindepth 1 -maxdepth 1 ! -name copias -exec rm -rf {} + 2>/dev/null || FALLOS=1
	else
		hacer "remove $c" rm -rf "$c"
	fi
done

echo
if ((FALLOS)); then
	echo "Done, with the errors above. Run it again to retry what is left."
	exit 1
fi
echo "Sugardaddy is no longer on this machine."
[[ -n "$CONSERVAR_COPIAS" && -d "$DIR/copias" ]] && echo "Your backups are still in $DIR/copias."
exit 0
