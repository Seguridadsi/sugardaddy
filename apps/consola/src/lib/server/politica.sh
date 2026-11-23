# --- política de cambios (docs/diseno/politica-cambios.md) ---
# El suelo de la política de cambios desde la instalación, por entorno: ACTUALIZACION_POLITICA
# (automatica o manual), ACTUALIZACION_RETARDO_HORAS (0 a 720) y ACTUALIZACION_VENTANA
# («1-5 02:00-05:00 Europe/Madrid», varias separadas por «;»). Lo que no se da no se toca. Lo
# que no vale para la instalación antes de escribir nada: el actualizador tomaría un valor
# ilegible como lo más estricto, y el nodo se quedaría sin instalar versiones.
sd_politica_comprobar() {
	local p="${ACTUALIZACION_POLITICA:-}" h="${ACTUALIZACION_RETARDO_HORAS:-}" v="${ACTUALIZACION_VENTANA:-}"
	local parte dias horas zona resto t n=0 hora='([01][0-9]|2[0-3]):[0-5][0-9]'
	local -a partes=() trozo=()
	if [[ -n "$p" && "$p" != automatica && "$p" != manual ]]; then
		echo "Sugardaddy: ACTUALIZACION_POLITICA must be automatica or manual. Nothing was changed. (code politica.modo)" >&2
		return 1
	fi
	if [[ -n "$h" ]] && ! [[ "$h" =~ ^(0|[1-9][0-9]{0,2})$ && "$h" -le 720 ]]; then
		echo "Sugardaddy: ACTUALIZACION_RETARDO_HORAS must be a number of hours from 0 to 720. Nothing was changed. (code politica.retardo)" >&2
		return 1
	fi
	[[ -n "$v" ]] || return 0
	IFS=';' read -ra partes <<< "$v"
	for parte in "${partes[@]}"; do
		dias="" horas="" zona="" resto=""
		read -r dias horas zona resto <<< "$parte" || true
		[[ -n "$dias" ]] || continue
		n=$((n + 1))
		local bien=1
		[[ -z "$resto" && $n -le 8 && "$horas" =~ ^${hora}-${hora}$ && "$dias" =~ ^[1-7](-[1-7])?(,[1-7](-[1-7])?)*$ ]] || bien=""
		if [[ -n "$bien" ]]; then
			IFS=',' read -ra trozo <<< "$dias"
			for t in "${trozo[@]}"; do [[ "${t%-*}" -le "${t#*-}" ]] || bien=""; done
		fi
		if [[ -n "$bien" && -n "$zona" && "$zona" != UTC ]]; then
			[[ "$zona" =~ ^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+){0,2}$ ]] || bien=""
			# Con la base de zonas de la máquina, la zona tiene que estar en ella.
			[[ -z "$bien" || ! -d /usr/share/zoneinfo || -f "/usr/share/zoneinfo/$zona" ]] || bien=""
		fi
		if [[ -z "$bien" ]]; then
			echo "Sugardaddy: ACTUALIZACION_VENTANA cannot be read at \"$parte\". Write each window as days (1 Monday to 7 Sunday, ranges and commas), times and an optional time zone, such as \"1-5 02:00-05:00 Europe/Madrid\", and separate windows with \";\". Nothing was changed. (code politica.ventana)" >&2
			return 1
		fi
	done
}
sd_politica_env() { # fichero .env: deja en él las que se dieron
	local k
	for k in ACTUALIZACION_POLITICA ACTUALIZACION_RETARDO_HORAS ACTUALIZACION_VENTANA; do
		[[ -n "${!k:-}" ]] || continue
		grep -v "^$k=" "$1" > "$1.tmp" || true
		if [[ "$k" == ACTUALIZACION_VENTANA ]]; then echo "$k=\"${!k}\"" >> "$1.tmp"; else echo "$k=${!k}" >> "$1.tmp"; fi
		chmod 600 "$1.tmp" && mv "$1.tmp" "$1"
	done
	if [[ -n "${ACTUALIZACION_POLITICA:-}${ACTUALIZACION_RETARDO_HORAS:-}${ACTUALIZACION_VENTANA:-}" ]]; then
		echo "==> Update policy set on this machine (no console can lower it): ${ACTUALIZACION_POLITICA:-unchanged}, ${ACTUALIZACION_RETARDO_HORAS:-unchanged} hours of delay, window ${ACTUALIZACION_VENTANA:-unchanged}"
	fi
}
# --- fin de la política de cambios ---
