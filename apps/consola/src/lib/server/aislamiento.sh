# --- aislamiento de las trampas (docs/diseno/aislamiento-trampas.md §4 y §5) ---
# El mismo bloque en este instalar.sh y en el del sensor remoto (aislamiento-sh.ts en la
# consola; aislamiento-sh.spec.ts comprueba que no se separan). El auxiliar
# «aislar-anfitrion» de cada versión pone lo mismo (aislamiento.go, con su prueba).
sd_aislar_env() { # fichero clave valor
	{ grep -v "^$2=" "$1" || true; echo "$2=$3"; } > "$1.tmp"
	chmod 600 "$1.tmp" && mv "$1.tmp" "$1"
}
sd_aislar_trampas() { # fichero-.env carpeta-de-datos-del-sensor imagen-del-sensor
	local env_sd="$1" datos_sensor="$2" imagen="$3"
	# 1. Perfil AppArmor de las trampas, si la máquina tiene AppArmor: sd-motor lo
	# pone a cada trampa que corre con runc (con gVisor no hace falta).
	if [[ -d /sys/kernel/security/apparmor ]] && command -v apparmor_parser >/dev/null; then
		mkdir -p /etc/apparmor.d
		cat > /etc/apparmor.d/sugardaddy-trampa <<'PERFIL'
# Perfil de las trampas de Sugardaddy (docs/diseno/aislamiento-trampas.md §4).
# El de Docker por defecto, más: sin enchufes crudos, sin ptrace, sin montar y
# sin escribir en /proc ni /sys. Lo instala instalar.sh; lo aplica sd-motor.
#include <tunables/global>
profile sugardaddy-trampa flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>
  network inet stream,
  network inet dgram,
  network inet6 stream,
  network inet6 dgram,
  network unix,
  network netlink dgram,
  deny network raw,
  deny network packet,
  file,
  deny mount,
  deny umount,
  deny pivot_root,
  deny ptrace,
  deny capability,
  signal (send,receive) peer=sugardaddy-trampa,
  signal (receive) peer=unconfined,
  deny @{PROC}/* w,
  deny @{PROC}/{[^1-9],[^1-9][^0-9],[^1-9s][^0-9y][^0-9s],[^1-9][^0-9][^0-9][^0-9/]*}/** w,
  deny @{PROC}/sys/** wklx,
  deny @{PROC}/sysrq-trigger rwklx,
  deny @{PROC}/kcore rwklx,
  deny @{PROC}/kmem rwklx,
  deny @{PROC}/mem rwklx,
  deny /sys/** wklx,
  deny /sys/firmware/** rwklx,
  deny /sys/kernel/security/** rwklx,
  deny /var/run/docker.sock rwklx,
  deny /run/docker.sock rwklx,
}
PERFIL
		if apparmor_parser -r -W /etc/apparmor.d/sugardaddy-trampa 2>/dev/null; then
			sd_aislar_env "$env_sd" TRAMPAS_APPARMOR sugardaddy-trampa
		else
			echo "WARNING: the AppArmor profile for decoys did not load; decoys run with seccomp only"
			sd_aislar_env "$env_sd" TRAMPAS_APPARMOR ""
		fi
	fi
	# 2. El servicio de discos del anfitrión (sd-discos): monta el disco de tamaño fijo
	# de cada trampa sin contenedor privilegiado. Es el binario firmado del sensor con
	# su orden discos-anfitrion, en una unidad con un único comando fijo. sd-motor le
	# deja la petición en el buzón y la unidad .path la arranca.
	if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null && [[ -n "$imagen" ]]; then
		mkdir -p /usr/local/lib/sugardaddy /var/lib/sugardaddy/discos
		chmod 700 /var/lib/sugardaddy/discos
		if docker run --rm --user 0:0 --network none --read-only --cap-drop ALL --cap-add DAC_OVERRIDE \
			-v /usr/local/lib/sugardaddy:/salida "$imagen" copiar-binario /salida/sd-discos >/dev/null; then
			cat > /etc/systemd/system/sd-discos.service <<UNIDAD
# Discos de las trampas de Sugardaddy (docs/diseno/aislamiento-trampas.md §5).
[Unit]
Description=Sugardaddy decoy disks
[Service]
Type=oneshot
ExecStart=/usr/local/lib/sugardaddy/sd-discos discos-anfitrion /var/lib/sugardaddy/discos $datos_sensor
# Montar un fichero en loop y formatearlo pide CAP_SYS_ADMIN; dejar las carpetas a
# quien las usa, CHOWN y FOWNER. Nada más. Sin red. Sin espacio de montaje propio
# (ProtectSystem, PrivateTmp…): los discos que monta tienen que verse en la máquina.
CapabilityBoundingSet=CAP_SYS_ADMIN CAP_CHOWN CAP_FOWNER CAP_DAC_OVERRIDE
AmbientCapabilities=
NoNewPrivileges=yes
PrivateNetwork=yes
RestrictAddressFamilies=AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
TimeoutStartSec=10min
UNIDAD
			cat > /etc/systemd/system/sd-discos.path <<UNIDAD
[Unit]
Description=Sugardaddy decoy disks: request mailbox
[Path]
PathExists=/var/lib/sugardaddy/discos/peticion.json
[Install]
WantedBy=multi-user.target
UNIDAD
			systemctl daemon-reload
			if systemctl enable --now sd-discos.path >/dev/null 2>&1; then
				: > /var/lib/sugardaddy/discos/instalado
			else
				echo "WARNING: the decoy disk service did not start; decoys run without their own disk"
			fi
		else
			echo "WARNING: could not install the decoy disk service; decoys run without their own disk"
		fi
	fi
	return 0
}
# --- fin del aislamiento de las trampas ---
