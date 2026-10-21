package main

import (
	"net"
	"net/netip"
	"strings"
	"testing"
)

// TestElBancoSeNiegaSiLaSubredEsDelAnfitrion (hallazgo 8 de la revisión): la
// subred del banco es fija (172.31.201.0/24) y sus IP van sin sondeo a un
// puente sandbox. Si ESTE anfitrión tiene esa subred de verdad (una
// dirección local suya dentro — p. ej. la LAN de producción del cliente
// siendo justo esa), crear el puente choca con la ruta local: el banco se
// niega antes de tocar nada, no secuestra la red del cliente.
func TestElBancoSeNiegaSiLaSubredEsDelAnfitrion(t *testing.T) {
	subred := netip.MustParsePrefix(subredBanco)
	// Una dirección del anfitrión DENTRO de la subred del banco: no se lanza.
	dentro := []net.Addr{&net.IPNet{IP: net.ParseIP("192.168.100.39")}, &net.IPNet{IP: net.ParseIP("172.31.201.14")}}
	err := subredSin(subred, dentro)
	if err == nil || !strings.Contains(err.Error(), "pisaría la red del cliente") {
		t.Fatalf("una dirección local dentro de la subred del banco lo dejó pasar: %v", err)
	}
	// Direcciones locales fuera de la subred: el banco puede.
	fuera := []net.Addr{
		&net.IPNet{IP: net.ParseIP("192.168.100.39")},
		&net.IPNet{IP: net.ParseIP("172.31.202.1")},
		&net.IPNet{IP: net.ParseIP("10.0.0.5")},
		&net.IPNet{IP: net.ParseIP("fe80::1")},
	}
	if err := subredSin(subred, fuera); err != nil {
		t.Fatalf("el banco se negó con el anfitrión fuera de su subred: %v", err)
	}
}
