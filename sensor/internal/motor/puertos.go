package motor

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/netip"
	"sort"
	"strconv"
	"strings"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// Lo que escucha la máquina donde corre el motor y sus direcciones de red,
// medido con una sonda en la red del anfitrión (la orden puertos-anfitrion
// del sensor). Sirve para dos cosas:
//
//   - Publicar una trampa en la IP de red de la máquina, no en 0.0.0.0, si su
//     puerto ya lo tiene algo de la propia máquina en una dirección local. Es
//     el caso del DNS en Ubuntu: el resolvedor del sistema escucha en
//     127.0.0.53:53, choca con 0.0.0.0:53 y no con la IP de red.
//   - Decir a la consola qué puertos están ocupados de verdad
//     (puertos.ocupados), para que no deje poner ahí una trampa.

// Escucha es un puerto atado en la máquina: TCP en LISTEN, o UDP atado.
type Escucha struct {
	Proto  string     `json:"proto"`
	Puerto int        `json:"puerto"`
	IP     netip.Addr `json:"ip"`
}

// Anfitrion es lo que mide la sonda.
type Anfitrion struct {
	// Direcciones IPv4 de la máquina en sus interfaces de red, sin las locales
	// ni las de los puentes de Docker.
	Direcciones []string  `json:"direcciones"`
	Escuchas    []Escucha `json:"escuchas"`
}

// Estados de /proc/net: TCP_LISTEN en tcp, TCP_CLOSE (atado, sin conectar) en udp.
var estadoEscucha = map[string]string{"tcp": "0A", "udp": "07"}

// LeerEscuchas lee una tabla de /proc/net (tcp, tcp6, udp o udp6) y devuelve
// lo que escucha. proto es «tcp» o «udp»; la familia sale de la dirección.
func LeerEscuchas(proto string, r io.Reader) []Escucha {
	var r2 []Escucha
	l := bufio.NewScanner(r)
	l.Scan() // cabecera
	for l.Scan() {
		c := strings.Fields(l.Text())
		if len(c) < 4 || c[3] != estadoEscucha[proto] {
			continue
		}
		ip, puerto, ok := direccionProc(c[1])
		if !ok || puerto == 0 {
			continue
		}
		r2 = append(r2, Escucha{Proto: proto, Puerto: puerto, IP: ip})
	}
	return r2
}

// direccionProc entiende «0100007F:0035» (IPv4) o los 32 dígitos de una IPv6,
// en palabras de 32 bits con los bytes al revés (las arquitecturas de
// Sugardaddy son little-endian), y el puerto en hexadecimal.
func direccionProc(t string) (netip.Addr, int, bool) {
	dir, pto, ok := strings.Cut(t, ":")
	b, err := hex.DecodeString(dir)
	p, err2 := strconv.ParseUint(pto, 16, 16)
	if !ok || err != nil || err2 != nil || (len(b) != 4 && len(b) != 16) {
		return netip.Addr{}, 0, false
	}
	for i := 0; i < len(b); i += 4 {
		b[i], b[i+1], b[i+2], b[i+3] = b[i+3], b[i+2], b[i+1], b[i]
	}
	ip, _ := netip.AddrFromSlice(b)
	return ip.Unmap(), int(p), true
}

// DireccionesDeRed da las IPv4 de las interfaces encendidas de la máquina,
// sin las locales, las de enlace local ni las de los puentes de Docker (no
// sirven para que un equipo de la red llegue a una trampa).
func DireccionesDeRed(interfaces []net.Interface, dirs func(net.Interface) ([]net.Addr, error)) []string {
	var r []string
	for _, i := range interfaces {
		if i.Flags&net.FlagUp == 0 || i.Flags&net.FlagLoopback != 0 || deDocker(i.Name) {
			continue
		}
		ds, err := dirs(i)
		if err != nil {
			continue
		}
		for _, d := range ds {
			p, err := netip.ParsePrefix(d.String())
			if err != nil {
				continue
			}
			a := p.Addr()
			if a.Is4() && !a.IsLoopback() && !a.IsLinkLocalUnicast() {
				r = append(r, a.String())
			}
		}
	}
	sort.Strings(r)
	return r
}

func deDocker(nombre string) bool {
	return nombre == "docker0" || strings.HasPrefix(nombre, "br-") || strings.HasPrefix(nombre, "veth")
}

// PublicarEn da las direcciones donde publicar un puerto que se pediría en
// 0.0.0.0: las de red de la máquina si ese puerto ya lo tiene algo de la
// propia máquina en una dirección local (127.x o ::1), con lo que 0.0.0.0
// chocaría; nil si se publica como siempre.
func (a *Anfitrion) PublicarEn(proto string, puerto int) []string {
	if a == nil || len(a.Direcciones) == 0 {
		return nil
	}
	for _, e := range a.Escuchas {
		if e.Proto == proto && e.Puerto == puerto && e.IP.IsLoopback() {
			return a.Direcciones
		}
	}
	return nil
}

// Ocupados da los puertos que otro programa tiene en todas las direcciones o
// en una de red («udp/53», como los pide la consola en puertos.ocupados),
// sin los que publican las trampas de este sensor (propios: «tcp/2222»…).
// Los de una dirección local no cuentan: la trampa se publica en la IP de
// red (PublicarEn).
func (a *Anfitrion) Ocupados(propios map[string]bool) []string {
	vistos := map[string]bool{}
	r := []string{}
	for _, e := range a.Escuchas {
		clave := fmt.Sprintf("%s/%d", e.Proto, e.Puerto)
		if e.IP.IsLoopback() || propios[clave] || vistos[clave] {
			continue
		}
		vistos[clave] = true
		r = append(r, clave)
	}
	sort.Strings(r)
	return r
}

// SondaAnfitrion mide los puertos y las direcciones de la máquina con una
// sonda en su red.
func SondaAnfitrion(ctx context.Context, d *docker.Cliente, imagen, sensor string) (*Anfitrion, error) {
	codigo, salida, err := d.EjecutarSonda(ctx, sonda(imagen, sensor, "puertos", "host", "puertos-anfitrion"))
	if err != nil {
		return nil, err
	}
	if codigo != 0 {
		return nil, fmt.Errorf("la sonda de puertos ha salido con %d: %s", codigo, strings.TrimSpace(salida))
	}
	var a Anfitrion
	if err := json.Unmarshal([]byte(strings.TrimSpace(salida)), &a); err != nil {
		return nil, fmt.Errorf("la sonda de puertos no da lo esperado: %w", err)
	}
	return &a, nil
}
