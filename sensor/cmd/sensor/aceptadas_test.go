package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kinomakino/sugardaddy/sensor/internal/consola"
	"github.com/kinomakino/sugardaddy/sensor/internal/estado"
)

// §4.11 (auditoría 2026-11-23): una consola tomada o rota que contesta a la
// entrega con unas aceptadas imposibles no tumba al sensor (antes, un slice
// fuera de rango en entregar) ni corre lo entregado más allá de la cola: se
// trata como una entrega fallida, con pausa, y lo entregado no se mueve.
func TestAceptadasImposiblesNoTumbanAlSensor(t *testing.T) {
	for _, aceptadas := range []int{-1, 6, 500, 999999} {
		t.Run(fmt.Sprint(aceptadas), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprintf(w, `{"ok":true,"aceptadas":%d}`, aceptadas)
			}))
			defer srv.Close()
			datos := t.TempDir()
			salida := filepath.Join(datos, "salida.jsonl")
			if err := os.WriteFile(salida, []byte(strings.Repeat(`{"x":1}`+"\n", 5)), 0o644); err != nil {
				t.Fatal(err)
			}
			e, _ := estado.Cargar(datos)
			s := &sensor{consola: consola.Nuevo(srv.URL, "token"), estado: e, salida: salida}
			s.opc.Datos = datos

			s.entregar(context.Background())

			if s.estado.Entregado != 0 {
				t.Fatalf("lo entregado no se mueve con unas aceptadas imposibles: %d", s.estado.Entregado)
			}
			if s.consolaRecoge || s.pausa.IsZero() {
				t.Fatalf("se trata como una entrega fallida, con pausa: recoge=%v pausa=%v", s.consolaRecoge, s.pausa)
			}
		})
	}
}
