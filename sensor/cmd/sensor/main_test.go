package main

import (
	"net/netip"
	"sync"
	"testing"
)

// TestElRangoDelArranqueSigueLaReglaDelReparto (hallazgo 10 de la revisión):
// la validación del -rango al arrancar y la de red.Rangos (la que luego
// decide red.capa2 y el reparto de IP) son LA MISMA — un /7 o un /31 no
// arrancan el sensor con un mensaje claro, en vez de arrancar y morir luego
// con «el rango no se entiende».
func TestElRangoDelArranqueSigueLaReglaDelReparto(t *testing.T) {
	// lo que no vale: fuera de /8–/30, IPv6, sin enlace.
	malos := []struct{ enlace, rango string }{
		{"", "10.0.0.0/24"}, // enlace y rango van JUNTOS
		{"eth0", ""},        // ídem
		{"eth0", "10.0.0.0/7"},
		{"eth0", "10.0.0.0/1"},
		{"eth0", "10.0.0.0/31"},
		{"eth0", "10.0.0.0/32"},
		{"eth0", "::1/64"},
		{"eth0", "no-es-un-cidr"},
	}
	for _, m := range malos {
		if _, err := redPropiaDeArranque(m.enlace, m.rango); err == nil {
			t.Fatalf("el arranque aceptó enlace=%q rango=%q: el propio sensor lo rechazaría luego", m.enlace, m.rango)
		}
	}
	// lo que vale: todo el /8–/30, con su interfaz.
	for _, rango := range []string{"10.0.0.0/8", "10.0.0.0/24", "10.0.0.240/28", "10.0.0.240/30"} {
		red, err := redPropiaDeArranque("eth0", rango)
		if err != nil {
			t.Fatalf("el arranque rechazó el rango bueno %s: %v", rango, err)
		}
		if red.Interfaz != "eth0" || red.Rango.String() != rango {
			t.Fatalf("el modo quedó mal montado: %+v", red)
		}
	}
}

// TestVigilarYOlvidarSinCarrera (hallazgo 6 de la revisión): vigiladas lo
// tocan el bucle del sensor (vigilar, al apuntar las IP nuevas del plan) y
// la goroutina del vigilante (olvidarVigilada, al llegar un reclamo) a la
// vez. Con go test -race, sin el mutex de vigiladas esto revienta; con él,
// verde. Y el dedup sigue valiendo: una IP ya apuntada no vuelve al
// vigilante; olvidada, sí.
func TestVigilarYOlvidarSinCarrera(t *testing.T) {
	var mu sync.Mutex
	apuntadas := 0
	s := &sensor{apuntarIP: func(netip.Addr) {
		mu.Lock()
		apuntadas++
		mu.Unlock()
	}, vigiladas: map[string]bool{}}
	ip := netip.MustParseAddr("10.0.0.7")
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			s.vigilar(ip)
		}()
		go func() {
			defer wg.Done()
			s.olvidarVigilada("10.0.0.7")
		}()
	}
	wg.Wait()
	// Determinista: una IP ya vigilada no vuelve al vigilante; olvidada, sí.
	mu.Lock()
	s.vigiladas = map[string]bool{} // como al montar el vigilante
	apuntadas = 0                   // lo que dejó la tormenta no cuenta
	mu.Unlock()
	s.vigilar(ip)
	s.vigilar(ip)
	if apuntadas != 1 {
		t.Fatalf("la IP ya apuntada volvió al vigilante: %d apuntadas", apuntadas)
	}
	s.olvidarVigilada(ip.String())
	s.vigilar(ip)
	if apuntadas != 2 {
		t.Fatalf("la IP reclamada y olvidada no se vuelve a apuntar: %d apuntadas", apuntadas)
	}
}
