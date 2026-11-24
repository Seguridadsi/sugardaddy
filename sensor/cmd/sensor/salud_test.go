package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/estado"
)

// La cola en la muestra de salud: lo que falta por entregar y desde cuándo.
func TestColaParaSalud(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "salida.jsonl")
	if err := os.WriteFile(ruta, make([]byte, 1000), 0o600); err != nil {
		t.Fatal(err)
	}
	s := &sensor{salida: ruta, estado: &estado.Estado{Entregado: 1000}}
	t0 := time.Unix(1_000_000, 0)
	if c := s.colaParaSalud(t0); c.Pendiente != 0 || c.SinEntregar != 0 || c.Descartando || c.Tope <= 0 {
		t.Fatalf("al día: %+v", c)
	}
	// Llega algo y la consola no lo recoge: cuenta desde la última vez que estuvo al día.
	s.estado.Entregado = 400
	if c := s.colaParaSalud(t0.Add(20 * time.Minute)); c.Pendiente != 600 || c.SinEntregar != 1200 {
		t.Fatalf("atascada: %+v", c)
	}
	s.descartes = descartes{"x": &descarte{}}
	if c := s.colaParaSalud(t0.Add(21 * time.Minute)); !c.Descartando {
		t.Fatalf("descartando: %+v", c)
	}
	// Entregada: vuelve a cero.
	s.estado.Entregado, s.descartes = 1000, nil
	if c := s.colaParaSalud(t0.Add(22 * time.Minute)); c.SinEntregar != 0 || c.Pendiente != 0 {
		t.Fatalf("otra vez al día: %+v", c)
	}
}
