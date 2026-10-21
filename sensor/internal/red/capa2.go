package red

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/kinomakino/sugardaddy/sensor/internal/motor"
)

// Hecho red.capa2: si esta máquina puede poner a una trampa con su propia IP
// en el segmento del cliente (docs/diseno/red.md §2.1). Solo lo informa el
// sensor: la consola no lo sabe y el cliente no lo promete.
//
// El modo «IP propia» necesita dos cosas del cliente: la interfaz física del
// segmento a vigilar (por cable o VLAN de acceso) y un rango de IP propias
// reservado fuera del reparto del DHCP. Y una tercera del mundo real: que el
// enlace sea de los que macvlan sabe falsificar.
//
//   - Wi-Fi: NO. macvlan no funciona sobre 802.11 (las tramas llevan más
//     cabeceras de las que puede fingir): el hecho es false con este motivo,
//     el elector descarta las trampas «IP propia» y se lo dice al cliente.
//   - Nube (AWS, Azure, GCP, Oracle): NO. Las IP del segmento las gestiona
//     el hipervisor: una MAC que el cliente no ha registrado no llega a
//     ninguna parte. tpot.md §4.4 lo apunta: en la nube hace falta una IP
//     secundaria del proveedor, que no es cosa del sensor.
//   - Cable o VLAN de acceso: sí, con el rango reservado.
//
// nil: aún no se sabe (el cliente no ha elegido interfaz); sin el hecho, el
// elector descarta las trampas «IP propia» con su motivo, igual que hace
// sensorMinimo con las que no le llegan.
type Opciones struct {
	// Interfaz física del segmento del cliente (p. ej. eth0). Vacía: el
	// cliente no ha dicho cuál y el hecho no se informa.
	Interfaz string
	// Rango de IP propias reservado (p. ej. 10.0.0.240/28): fuera del DHCP.
	Rango string
}

// Capa2 decide el hecho red.capa2 por la configuración del cliente y por lo
// que hay en la máquina. El motivo es lo que el cliente lee cuando no se
// puede (y cómo arreglarlo).
func Capa2(o Opciones) *motor.Hecho {
	if o.Interfaz == "" {
		return nil
	}
	if _, err := os.Stat(filepath.Join(sys, "class", "net", o.Interfaz)); err != nil {
		return &motor.Hecho{Valor: false, Motivo: "la interfaz " + o.Interfaz +
			" no existe en esta máquina: elige la del segmento a vigilar (por cable o VLAN)"}
	}
	// /sys/class/net/<if>/phy80211 existe solo en las interfaces Wi-Fi.
	if _, err := os.Stat(filepath.Join(sys, "class", "net", o.Interfaz, "phy80211")); err == nil {
		return &motor.Hecho{Valor: false, Motivo: "la interfaz " + o.Interfaz +
			" es Wi-Fi: el modo «IP propia» (macvlan) no funciona sobre Wi-Fi, porque las tramas 802.11 llevan más cabeceras de las que puede fingir. Pon el sensor en la VLAN por cable."}
	}
	if nube(sys) {
		return &motor.Hecho{Valor: false, Motivo: "esta máquina es una VM en la nube (AWS, Azure, GCP u Oracle): " +
			"las IP del segmento las gestiona el hipervisor y una MAC sin registrar no llega a ninguna parte. El modo «IP propia» necesita un servidor propio o en VM en la LAN del cliente."}
	}
	if o.Rango == "" {
		return &motor.Hecho{Valor: false, Motivo: "falta el rango de IP propias: reserva uno fuera del reparto del DHCP " +
			"(p. ej. 10.0.0.240/28) y arranca el sensor con -rango."}
	}
	if _, err := Rangos(o.Rango); err != nil || !strings.Contains(o.Rango, "/") {
		return &motor.Hecho{Valor: false, Motivo: "el rango de IP propias (" + o.Rango +
			") no se entiende: tiene que ser un CIDR IPv4 (p. ej. 10.0.0.240/28)."}
	}
	return &motor.Hecho{Valor: true, Motivo: "la interfaz " + o.Interfaz +
		" es un enlace por cable o VLAN de acceso y hay un rango propio reservado (" + o.Rango +
		"): macvlan puede dar a cada trampa su propia IP en el segmento."}
}

// sys: raíz de /sys, para las pruebas (que fabrican la suya).
var sys = "/sys"

// nube mira lo que la máquina dice de sí misma en DMI (los fabricantes de
// nube lo dejan en /sys/devices/virtual/dmi/id) y solo da «nube pública» con
// un MARCADOR REAL de proveedor, campo a campo (hallazgo 4: antes era un OR
// de seis cadenas sueltas, y «Microsoft Corporation» — que lleva igual una MV
// Hyper-V de la LAN del cliente — marcaba como nube a una máquina legítima
// para `red.capa2`). La regla dura es NO marcar nube pública real como capaz
// (un falso positivo prohibido); los falsos negativos que este recorte deja
// (una nube cuyo DMI no traiga estos marcadores) están documentados en
// docs/diseno/red.md §2.1 con el marcador exacto: el operador es quien no
// debe instalar ahí.
//
//   - Azure: el chassis asset tag empieza por «7783-7084-3265», el prefijo
//     que Microsoft deja en el SMBIOS de sus MV (se ve con dmidecode; es EL
//     marcador de Azure). Las cadenas «Microsoft Corporation» + «Virtual
//     Machine» NO valen: las lleva igual el guest Hyper-V del cliente, que
//     es local.
//   - AWS EC2: «Amazon EC2» como sys_vendor o product_name.
//   - Google Cloud: sys_vendor «Google» junto a product_name/product_family
//     «Google Compute Engine».
//   - Oracle Cloud (OCI): sys_vendor «Oracle Corporation» junto a
//     product_name «Virtual Machine».
//
// VMware, KVM, QEMU o Hyper-V en la LAN del cliente no son nube: el
// hipervisor puede ser de quien sea — la LAN del cliente es la LAN del
// cliente, y una MV así es una máquina más con su interfaz física (tpot.md
// §4.2).
func nube(raiz string) bool {
	leer := func(campo string) string {
		b, err := os.ReadFile(filepath.Join(raiz, "devices", "virtual", "dmi", "id", campo))
		if err != nil {
			return ""
		}
		return strings.ToLower(strings.TrimSpace(string(b)))
	}
	sysVendor, producto, familia := leer("sys_vendor"), leer("product_name"), leer("product_family")
	// Azure: el prefijo documentado del asset tag del chasis (SMBIOS type 3).
	if strings.HasPrefix(leer("chassis_asset_tag"), "7783-7084-3265") {
		return true
	}
	// AWS EC2: el fabricante o el producto lo dicen solos.
	if strings.Contains(sysVendor, "amazon ec2") || strings.Contains(producto, "amazon ec2") {
		return true
	}
	// GCP: el fabricante y el producto, juntos (un QEMU local no trae «Google»
	// de fábrica; el AND evita el falso positivo del OR de antes).
	if strings.Contains(sysVendor, "google") && (strings.Contains(producto, "compute engine") || strings.Contains(familia, "compute engine")) {
		return true
	}
	// OCI: fabricante y producto juntos (VirtualBox no es «Virtual Machine»).
	if strings.Contains(sysVendor, "oracle corporation") && strings.Contains(producto, "virtual machine") {
		return true
	}
	return false
}
