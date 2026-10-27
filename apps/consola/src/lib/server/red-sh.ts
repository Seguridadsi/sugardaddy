/*
 * Detección de la red de la máquina para los scripts de instalación: el del
 * nodo (despliegue/nodo/instalar.sh, que lleva este mismo texto; lo vigila
 * red-sh.spec.ts) y el del sensor remoto que da la consola.
 *
 * Deja en RED_DETECTADA la red de la interfaz por la que sale la máquina
 * (10.70.0.0/24) y en VLAN_DETECTADA su VLAN, si esa interfaz es una 802.1Q.
 * Si no se saben (sin ip, sin ruta por defecto, en un puerto sin etiquetar),
 * vacías: nunca hace fallar la instalación.
 *
 * Sin ${…} de shell dentro: el texto va en plantillas de JavaScript.
 */
export const detectarRed = `interfaz="$(ip -4 route show default 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}' || true)"
RED_DETECTADA="" VLAN_DETECTADA=""
if [[ -n "$interfaz" ]]; then
	RED_DETECTADA="$(ip -4 route show dev "$interfaz" proto kernel scope link 2>/dev/null | awk '$1 ~ /\\// { print $1; exit }' || true)"
	VLAN_DETECTADA="$(ip -d -o link show dev "$interfaz" 2>/dev/null | grep -o 'vlan protocol 802.1Q id [0-9]*' | awk '{ print $NF }' || true)"
fi`;
