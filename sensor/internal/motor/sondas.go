package motor

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/netip"
	"strconv"
	"strings"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// Sondas: lo que el motor no dice de sí mismo se mide con contenedores
// efímeros que corren la imagen del propio sensor con una orden suya.

// La misma etiqueta que la sonda del aislamiento (ver despliegue): las que
// quedaran de otra vuelta se encuentran por ella.
const etiquetaSonda = "sugardaddy.sonda"

func sonda(imagen, sensor, papel, red string, orden ...string) docker.Sonda {
	return docker.Sonda{
		Nombre: "sd_sonda_" + sensor + "_" + papel, Imagen: imagen, Orden: orden, Red: red,
		Etiquetas: map[string]string{etiquetaSonda: sensor},
	}
}

// Motivos (códigos estables) del hecho motor.clone3.
const (
	// Los contenedores pueden usar clone3, o el motor contesta ENOSYS y
	// glibc vuelve a clone: los programas con glibc 2.34 o posterior crean
	// sus hilos sin problema.
	Clone3Disponible = "clone3.disponible"
	// El perfil seccomp del motor contesta EPERM a clone3 (Docker anterior
	// a la 20.10.10 sin el parche de su distribución, o un perfil propio):
	// los programas con glibc 2.34 o posterior no pueden crear hilos.
	Clone3Bloqueado = "clone3.bloqueado"
)

// Códigos de salida de la orden probar-clone3 del sensor.
const (
	SalidaClone3Disponible = 0
	SalidaClone3Bloqueado  = 3
	// Un perfil que, en vez de contestar, mata el proceso (SIGSYS, que en
	// Linux es la señal 31): también bloquea, y peor.
	salidaClone3Matado = 128 + 31
)

// Clone3 mide si los contenedores de este motor pueden usar clone3, con una
// sonda sin red y con el mismo perfil seccomp que una trampa. No se deduce
// de la versión: Ubuntu y Debian arreglaron sus Docker 20.10 sin cambiar el
// número.
func Clone3(ctx context.Context, d *docker.Cliente, imagen, sensor string) (*Hecho, error) {
	codigo, salida, err := d.EjecutarSonda(ctx, sonda(imagen, sensor, "clone3", "none", "probar-clone3"))
	if err != nil {
		return nil, err
	}
	switch codigo {
	case SalidaClone3Disponible:
		return &Hecho{true, Clone3Disponible}, nil
	case SalidaClone3Bloqueado, salidaClone3Matado:
		return &Hecho{false, Clone3Bloqueado}, nil
	}
	return nil, fmt.Errorf("la sonda de clone3 ha salido con %d: %s", codigo, strings.TrimSpace(salida))
}

// PuertaEnlace mide la puerta de enlace IPv4 de la máquina donde corre el
// motor, con una sonda en su red (la orden puerta-enlace del sensor). Con
// WSL2 en NAT es el propio Windows: lo que reenvía (netsh portproxy) llega a
// las trampas con esa dirección. Vacía si la máquina no tiene ruta por
// defecto.
func PuertaEnlace(ctx context.Context, d *docker.Cliente, imagen, sensor string) (string, error) {
	codigo, salida, err := d.EjecutarSonda(ctx, sonda(imagen, sensor, "puerta", "host", "puerta-enlace"))
	if err != nil {
		return "", err
	}
	linea := strings.TrimSpace(salida)
	if codigo != 0 {
		return "", fmt.Errorf("la sonda de la puerta de enlace ha salido con %d: %s", codigo, linea)
	}
	if linea == "" {
		return "", nil
	}
	a, err := netip.ParseAddr(linea)
	if err != nil || !a.Is4() {
		return "", fmt.Errorf("la sonda de la puerta de enlace no da una dirección: %q", linea)
	}
	return a.String(), nil
}

// LeerPuertaEnlace saca de /proc/net/route la puerta de enlace de la ruta
// por defecto (destino y máscara 0, con el indicador de puerta de enlace).
// Las direcciones van en hexadecimal con los bytes al revés (en las
// arquitecturas de Sugardaddy, todas little-endian: amd64, arm64 y arm).
func LeerPuertaEnlace(r io.Reader) string {
	l := bufio.NewScanner(r)
	l.Scan() // cabecera
	mejor, metrica := "", -1
	for l.Scan() {
		c := strings.Fields(l.Text())
		if len(c) < 8 || c[1] != "00000000" || c[7] != "00000000" {
			continue
		}
		indicadores, err1 := strconv.ParseUint(c[3], 16, 32)
		g, err2 := strconv.ParseUint(c[2], 16, 32)
		m, err3 := strconv.Atoi(c[6])
		if err1 != nil || err2 != nil || err3 != nil || indicadores&0x3 != 0x3 || g == 0 { // RTF_UP | RTF_GATEWAY
			continue
		}
		if metrica == -1 || m < metrica {
			mejor = netip.AddrFrom4([4]byte{byte(g), byte(g >> 8), byte(g >> 16), byte(g >> 24)}).String()
			metrica = m
		}
	}
	return mejor
}
