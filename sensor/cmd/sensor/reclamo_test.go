package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/adaptador"
)

// Un reclamo de la IP propia de una trampa deja un evento en la cola de la
// consola: un ARP falso no la apaga sin rastro (auditoría del 2026-11-14).
func TestUnaIPReclamadaDejaEventoEnLaCola(t *testing.T) {
	s, _ := sensorDeCola(t, &consolaFalsa{})
	s.apuntarReclamo("t1", "10.0.0.50", "02:00:00:00:00:99", time.Date(2026, 11, 14, 3, 0, 0, 0, time.UTC))
	s.apuntarReclamo("no-existe", "10.0.0.51", "02:00:00:00:00:98", time.Now())
	s.leer()

	b, err := os.ReadFile(s.salida)
	if err != nil {
		t.Fatal(err)
	}
	lineas := strings.Split(strings.TrimSpace(string(b)), "\n")
	var vistos int
	for _, l := range lineas {
		var e struct {
			Trampa    struct{ ID string }
			Severidad string
			Detalle   map[string]any
		}
		if json.Unmarshal([]byte(l), &e) != nil || e.Detalle["codigo"] != adaptador.CodigoIPReclamada {
			continue
		}
		vistos++
		if e.Trampa.ID != "t1" || e.Severidad != "alta" || e.Detalle["ip"] != "10.0.0.50" || e.Detalle["mac"] != "02:00:00:00:00:99" {
			t.Fatalf("evento: %s", l)
		}
	}
	if vistos != 1 {
		t.Fatalf("tenía que haber un evento de IP reclamada (solo de la trampa que existe): %d\n%s", vistos, b)
	}
	if len(s.tomarReclamos()) != 0 {
		t.Fatal("tras leer no queda nada pendiente")
	}
}

func TestLosReclamosPendientesTienenTope(t *testing.T) {
	s, _ := sensorDeCola(t, &consolaFalsa{})
	for i := 0; i < 3*maxReclamadas; i++ {
		s.apuntarReclamo("t1", "10.0.0.50", "02:00:00:00:00:99", time.Now())
	}
	if n := len(s.tomarReclamos()); n != maxReclamadas {
		t.Fatalf("pendientes: %d", n)
	}
}
