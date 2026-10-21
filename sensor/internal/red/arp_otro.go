//go:build !linux

package red

import (
	"context"
	"fmt"
	"net/netip"
	"time"
)

// Fuera de Linux (el banco de desarrollo en un Mac) no hay AF_PACKET: el
// sondeo y el vigilante no existen. El sondeo previo no se salta en
// producción (el sensor corre en Linux); en el banco de pruebas la IP de la
// trampa es fija y la elige quien escribe la prueba, así que no hace falta.
// El compilador de BPF sí es portable: se prueba en cualquier sitio.

// Libre: sin AF_PACKET no se puede sondear. Quien lo llame desde el banco
// tiene que elegir la IP de antemano (y el que corre en Linux nunca llega
// aquí, que es donde de verdad se despliega).
func Libre(interfaz string, ip netip.Addr, espera time.Duration) (bool, error) {
	return false, fmt.Errorf("el sondeo ARP necesita Linux (AF_PACKET); aquí no hay")
}

// Reclamo y Vigilar: igual que Libre, solo existen en Linux.
type Reclamo struct {
	IP  string
	MAC string
}

func Vigilar(ctx context.Context, interfaz string, macPropia func([6]byte) bool, reclamos chan<- Reclamo) (func(netip.Addr), error) {
	return nil, fmt.Errorf("el vigilante ARP necesita Linux (AF_PACKET); aquí no hay")
}
